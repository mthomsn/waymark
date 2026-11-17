#!/usr/bin/env node
// WAYMARK MVP bridge: polls TSS over UDP (same path the HoloLens app will use)
// and serves the HUD wireframe + a Server-Sent Events stream of snapshots.
//
//   TSS_HOST=<ip printed by server.exe> TEAM=0 PORT=8080 node bridge.js

const dgram = require('node:dgram');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TSS_HOST = process.env.TSS_HOST || process.argv[2];
const TEAM = Number(process.env.TEAM ?? 0);
const PORT = Number(process.env.PORT ?? 8080);
const UDP_PORT = 14142 + TEAM;   // per-team UDP socket (src/server.c)
const HTTP_PORT = 14141;         // TSS web UI / form POST
const POLL_MS = 1000;            // TSS updates at 1 Hz
const TIMEOUT_MS = 3000;       // TSS round-trips take ~1.05 s: its loop selects 100 ms on each of 11 sockets

if (!TSS_HOST) {
  console.error('Usage: TSS_HOST=<ip printed by server.exe> node bridge.js');
  process.exit(1);
}

let latest = null;       // last good EVA.json
let receivedAt = 0;
let seq = 0;
let link = 'connecting';
let misses = 0;
const sseClients = new Set();

// ---- UDP -----------------------------------------------------------------

function packet(command, value) {
  const buf = Buffer.alloc(value === undefined ? 8 : 12);
  buf.writeUInt32BE(Math.floor(Date.now() / 1000) >>> 0, 0);
  buf.writeUInt32BE(command, 4);
  if (value !== undefined) buf.writeFloatBE(Number(value), 8);
  return buf;
}

// One request/response exchange on a fresh socket (TSS treats each UDP request as one-off).
function udpRequest(buf) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); reject(new Error('timeout')); }, TIMEOUT_MS);
    sock.on('message', (msg) => { clearTimeout(timer); sock.close(); resolve(msg); });
    sock.on('error', (err) => { clearTimeout(timer); sock.close(); reject(err); });
    sock.send(buf, UDP_PORT, TSS_HOST);
  });
}

function decodeJson(msg) {
  // README documents an 8-byte header; the current server sends raw JSON. Handle both.
  const start = msg.indexOf(0x7b); // '{'
  if (start < 0) throw new Error('no JSON in response');
  return JSON.parse(msg.subarray(start).toString('utf8').replace(/\0+$/, ''));
}

async function poll() {
  try {
    latest = decodeJson(await udpRequest(packet(0)));
    receivedAt = Date.now();
    seq++;
    if (link !== 'ok') console.log(`[udp] link OK  ${TSS_HOST}:${UDP_PORT}`);
    link = 'ok';
    misses = 0;
  } catch (err) {
    if (++misses >= 2 && link !== 'lost') { console.warn(`[udp] link LOST (${err.message})`); link = 'lost'; }
  }
  broadcast();
}

// Poll back-to-back, never overlapping, at most once per POLL_MS.
async function pollLoop() {
  const t0 = Date.now();
  await poll();
  setTimeout(pollLoop, Math.max(0, POLL_MS - (Date.now() - t0)));
}

function snapshot() {
  return { eva: latest, receivedAt, seq, link, now: Date.now(), team: TEAM, host: TSS_HOST };
}

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}

// ---- HTTP ----------------------------------------------------------------

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

// Forward a field update through TSS's web-form endpoint (used for status.started and
// telemetry fields that have no UDP command).
function tssFormPost(field, value) {
  const body = `team=${TEAM}&${field}=${value}`;
  return new Promise((resolve) => {
    const req = http.request({ host: TSS_HOST, port: HTTP_PORT, method: 'POST', path: '/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); resolve(res.statusCode < 400); });
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

let pendingPose = null;
let poseInFlight = false;
function queuePose(p) {
  if (![p.x, p.y, p.heading].every(Number.isFinite)) return;
  pendingPose = p;
  if (!poseInFlight) flushPose();
}
async function flushPose() {
  if (!pendingPose) return;
  const p = pendingPose; pendingPose = null; poseInFlight = true;
  await Promise.all([
    tssFormPost('eva.imu.posx', p.x.toFixed(2)),
    tssFormPost('eva.imu.posy', p.y.toFixed(2)),
    tssFormPost('eva.imu.heading', p.heading.toFixed(1)),
  ]);
  poseInFlight = false;
  if (pendingPose) flushPose();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Local pose → TSS IMU. Uses the HTTP form path (TSS services all pending HTTP clients each
  // loop) so it doesn't eat the ~1 datagram/s per-team UDP budget that telemetry polling needs.
  // Latest-wins: if a sync is in flight, the newest pose is queued and older ones dropped.
  if (url.pathname === '/pose' && req.method === 'POST') {
    try {
      const { x, y, heading } = JSON.parse(await readBody(req));
      queuePose({ x: Number(x), y: Number(y), heading: Number(heading) });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (err) {
      res.writeHead(400); res.end();
    }
    return;
  }

  if (url.pathname === '/cmd' && req.method === 'POST') {
    try {
      const { command, value, field } = JSON.parse(await readBody(req));
      let ok;
      if (field) ok = await tssFormPost(field, value);
      else ok = (await udpRequest(packet(Number(command), Number(value)))).some((b) => b !== 0); // 4-byte bool ack
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`WAYMARK MVP  http://localhost:${PORT}`);
  console.log(`TSS          udp://${TSS_HOST}:${UDP_PORT} (team ${TEAM})`);
  pollLoop();
});

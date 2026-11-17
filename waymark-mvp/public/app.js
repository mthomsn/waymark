import { evaluate, fmt } from './cw.js';
import { RangeModel } from './range.js';
import { Procedure, get } from './procedure.js';

const $ = (id) => document.getElementById(id);
const PANEL_TIMEOUT_MS = 12000;

// ---------------------------------------------------------------- state
const state = {
  snap: null,          // last SSE message
  eva: null,
  cw: null,
  range: new RangeModel(),
  proc: null,
  trail: [],           // breadcrumbs {x, y}
  home: null,          // lander / start point
  pins: [],            // {n, x, y, t, sample, rock, data}
  target: null,        // {label, x, y}
  showNominal: false,
  viaVoice: false,
};

try {
  const saved = JSON.parse(localStorage.getItem('waymark-map') || 'null');
  if (saved) Object.assign(state, { trail: saved.trail || [], home: saved.home || null, pins: saved.pins || [] });
} catch { /* storage unavailable */ }
function saveMap() {
  try { localStorage.setItem('waymark-map', JSON.stringify({ trail: state.trail.slice(-3000), home: state.home, pins: state.pins })); } catch { }
}

fetch('procedures/egress.json').then((r) => r.json()).then((def) => { state.proc = new Procedure(def); render(); });

// ---------------------------------------------------------------- telemetry stream
const es = new EventSource('/events');
es.onmessage = (e) => {
  const snap = JSON.parse(e.data);
  state.snap = snap;
  if (snap.eva && snap.seq !== state.lastSeq) {
    state.lastSeq = snap.seq;
    state.eva = snap.eva;
    ingest(snap.eva);
  }
  render();
};
es.onerror = () => { state.snap = state.snap && { ...state.snap, link: 'bridge down' }; render(); };
setInterval(render, 1000); // keep stale age ticking even if the bridge goes quiet

function ingest(eva) {
  state.range.add(eva);
  if (state.proc?.update(eva)) show('procedure', true);

  const { posx: x, posy: y } = eva.imu || {};
  if (typeof x === 'number' && typeof y === 'number') {
    if (!state.home) state.home = { x, y };
    const last = state.trail.at(-1);
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.5) { state.trail.push({ x, y }); saveMap(); }
  }
}

// ---------------------------------------------------------------- geometry
const norm = (d) => ((d % 360) + 360) % 360;
const pos = () => state.eva?.imu && { x: state.eva.imu.posx, y: state.eva.imu.posy, h: state.eva.imu.heading };
// Heading convention assumed: 0° = +y (north), clockwise.
function bearingTo(t) {
  const p = pos(); if (!p || !t) return null;
  return { bearing: norm((Math.atan2(t.x - p.x, t.y - p.y) * 180) / Math.PI), dist: Math.hypot(t.x - p.x, t.y - p.y) };
}

// ---------------------------------------------------------------- render
function render() {
  const snap = state.snap;
  const now = Date.now();
  state.cw = evaluate(state.eva, { receivedAt: snap?.receivedAt, now, suitActive: state.proc ? state.proc.done : true });
  state.est = state.range.estimate();
  renderLink(snap, now);
  renderHeading();
  renderAlert();
  renderRange();
  if (!$('panel-status').classList.contains('hidden')) renderStatus();
  if (!$('panel-find').classList.contains('hidden')) renderFind();
  if (!$('panel-range').classList.contains('hidden')) renderRangeDetail();
  renderProcedure();
  renderDev();
}

function renderLink(snap, now) {
  const el = $('link');
  if (!snap) { el.textContent = 'connecting…'; el.className = 'chip'; return; }
  const age = snap.receivedAt ? Math.round((now - snap.receivedAt) / 1000) : null;
  const started = state.eva?.status?.started;
  if (state.cw.stale) {
    el.textContent = age == null ? `TSS ${snap.link}` : `STALE ${age}s · ${snap.link}`;
    el.className = 'chip bad';
  } else {
    el.textContent = `TSS team ${snap.team} · ${started ? 'EVA ' + clock(state.eva.telemetry.eva_elapsed_time) : 'EVA not started'}`;
    el.className = 'chip ok';
  }
}
const clock = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;

function renderHeading() {
  const c = $('heading'), g = c.getContext('2d');
  const W = c.width, H = c.height, span = 120, pxPerDeg = W / span;
  const h = pos()?.h ?? 0;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#cfe3dc'; g.fillStyle = '#cfe3dc'; g.lineWidth = 2;
  g.font = 'bold 16px ui-monospace, Menlo, monospace'; g.textAlign = 'center';
  for (let d = Math.ceil((h - span / 2) / 5) * 5; d <= h + span / 2; d += 5) {
    const x = W / 2 + (d - h) * pxPerDeg, n = norm(d);
    const major = n % 30 === 0;
    g.globalAlpha = 1 - Math.abs(d - h) / (span / 2) * 0.7;
    g.beginPath(); g.moveTo(x, H - 4); g.lineTo(x, H - (major ? 18 : 9)); g.stroke();
    if (major) g.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] ?? String(n), x, H - 24);
  }
  g.globalAlpha = 1;
  // centre caret + numeric heading
  g.beginPath(); g.moveTo(W / 2 - 7, 0); g.lineTo(W / 2 + 7, 0); g.lineTo(W / 2, 9); g.fill();
  // target marker
  const b = bearingTo(state.target);
  if (b && b.dist >= 2) {
    let off = ((b.bearing - h + 540) % 360) - 180;
    const clamped = Math.max(-span / 2 + 3, Math.min(span / 2 - 3, off));
    const x = W / 2 + clamped * pxPerDeg;
    g.fillStyle = '#7be0b0';
    g.beginPath();
    if (Math.abs(off) > span / 2 - 3) { const s = Math.sign(off); g.moveTo(x + 10 * s, 26); g.lineTo(x - 6 * s, 16); g.lineTo(x - 6 * s, 36); }
    else { g.moveTo(x - 9, 40); g.lineTo(x + 9, 40); g.lineTo(x, 28); }
    g.fill();
    g.font = 'bold 13px ui-monospace, Menlo, monospace';
    g.fillText(`${Math.round(b.dist)} m`, Math.max(40, Math.min(W - 40, x)), 14);
  }
}

function alertsNow() {
  const a = [];
  const s = state.snap;
  if (s && state.cw.stale) a.push({ level: 'warning', text: s.receivedAt ? `TELEMETRY STALE ${Math.round(state.cw.ageMs / 1000)} s` : 'NO TELEMETRY', action: `link: ${s.link}` });
  if (!state.cw.stale) for (const i of state.cw.offNominal) {
    a.push({ level: i.level, text: i.flag ? i.label.toUpperCase() : `${i.label} ${fmt(i.value, i.unit)}`, action: i.action || (i.level === 'warning' ? `nominal ${i.min}–${i.max} ${i.unit}` : 'nearing limit') });
  }
  const e = state.est, home = bearingTo(state.home);
  if (e?.minutes != null && state.eva?.status?.started && state.proc?.done !== false) {
    if (e.minutes < 10 || (home && e.meters != null && home.dist > e.meters)) a.push({ level: 'warning', text: 'RETURN NOW', action: `${Math.round(e.minutes)} min left · lander ${home ? Math.round(home.dist) + ' m' : '?'}` });
  }
  if (state.proc?.wrong && Date.now() - state.proc.wrong.at < 15000) a.push({ level: 'caution', text: `Wrong switch: ${state.proc.wrong.path}`, action: `Expected: ${state.proc.step?.text ?? ''}` });
  const rank = { warning: 0, caution: 1 };
  return a.sort((x, y) => rank[x.level] - rank[y.level]);
}

function renderAlert() {
  const el = $('alert'), a = alertsNow();
  if (!a.length) { el.className = 'hidden'; return; }
  const top = a[0];
  el.className = top.level;
  el.innerHTML = `${esc(top.text)}<span class="action">${esc(top.action || '')}</span>${a.length > 1 ? `<span class="more">+${a.length - 1} more · say "status"</span>` : ''}`;
}

function renderRange() {
  const t = state.eva?.telemetry, e = state.est, ring = $('ring');
  const pool = t ? (t.oxy_pri_storage + t.oxy_sec_storage - 40) / 160 : 0;
  ring.style.strokeDashoffset = String(314.16 * (1 - Math.max(0, Math.min(1, pool))));
  let cls = '';
  if (e?.minutes != null) {
    $('range-main').textContent = `${Math.round(e.meters)} m`;
    $('range-sub').textContent = `${Math.round(e.minutes)} min · ${e.limitedBy}`;
    cls = e.minutes < 10 ? 'warning' : e.minutes < 30 ? 'caution' : '';
  } else {
    $('range-main').textContent = t ? `${Math.round(t.oxy_pri_storage)}/${Math.round(t.oxy_sec_storage)}` : '--';
    $('range-sub').textContent = state.eva?.status?.started ? 'O2 % · learning' : 'O2 % PRI/SEC';
  }
  ring.setAttribute('class', `ring ${cls}`);
}

function renderStatus() {
  const { offNominal, items } = state.cw;
  const nominal = items.filter((i) => i.level === 'nominal');
  const row = (i) => `<div class="row ${i.level}"><span class="k">${esc(i.label)}${i.action ? `<span class="act">${esc(i.action)}</span>` : ''}</span><span class="v">${i.flag ? 'FAULT' : fmt(i.value, i.unit)}</span></div>`;
  $('status-off').innerHTML = offNominal.length ? offNominal.map(row).join('') : '<div class="row"><span>All values nominal</span></div>';
  $('status-toggle').textContent = `${state.showNominal ? '▾' : '▸'} ${nominal.length} values nominal`;
  $('status-nom').classList.toggle('hidden', !state.showNominal);
  if (state.showNominal) $('status-nom').innerHTML = nominal.map(row).join('');
  const d = state.eva?.dcu, u = state.eva?.uia;
  if (!d) { $('status-sw').innerHTML = ''; return; }
  const sw = (on, label) => `<span class="sw ${on ? 'on' : ''}">${label}</span>`;
  $('status-sw').innerHTML = `<div style="margin-top:10px;color:var(--dim);font-size:12px">DCU</div>` +
    sw(true, d.batt.lu ? 'BATT LOCAL' : 'BATT UMB') + sw(true, d.batt.ps ? 'BATT PRI' : 'BATT SEC') +
    sw(true, d.oxy ? 'OXY PRI' : 'OXY SEC') + sw(true, d.fan ? 'FAN PRI' : 'FAN SEC') +
    sw(d.pump, d.pump ? 'PUMP OPEN' : 'PUMP CLOSED') + sw(true, d.co2 ? 'CO2 A' : 'CO2 B') +
    `<div style="margin-top:8px;color:var(--dim);font-size:12px">UIA</div>` +
    Object.entries(u || {}).map(([k, v]) => sw(v, k.replace(/_/g, ' ').toUpperCase())).join('');
}

function renderFind() {
  const c = $('map'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const p = pos();
  const pts = [...state.trail, ...state.pins, state.home, p].filter(Boolean);
  if (!pts.length) return;
  let minX = Math.min(...pts.map((q) => q.x)), maxX = Math.max(...pts.map((q) => q.x));
  let minY = Math.min(...pts.map((q) => q.y)), maxY = Math.max(...pts.map((q) => q.y));
  const span = Math.max(maxX - minX, maxY - minY, 20), pad = 24;
  const scale = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const X = (x) => W / 2 + (x - cx) * scale, Y = (y) => H / 2 - (y - cy) * scale;

  // scale bar
  const m = [5, 10, 25, 50, 100, 250, 500].find((v) => v * scale > 50) || 500;
  g.strokeStyle = '#6f8580'; g.fillStyle = '#6f8580'; g.font = '11px ui-monospace, monospace';
  g.beginPath(); g.moveTo(10, H - 10); g.lineTo(10 + m * scale, H - 10); g.stroke(); g.fillText(`${m} m`, 12, H - 14);

  // breadcrumbs
  g.strokeStyle = '#7be0b0'; g.lineWidth = 2; g.setLineDash([4, 4]);
  g.beginPath(); state.trail.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y)))); g.stroke();
  g.setLineDash([]);
  // target line
  if (state.target && p) { g.strokeStyle = '#ffb020'; g.beginPath(); g.moveTo(X(p.x), Y(p.y)); g.lineTo(X(state.target.x), Y(state.target.y)); g.stroke(); }
  // lander
  if (state.home) { g.fillStyle = '#cfe3dc'; g.fillRect(X(state.home.x) - 6, Y(state.home.y) - 6, 12, 12); g.fillText('LANDER', X(state.home.x) + 9, Y(state.home.y) + 4); }
  // pins
  for (const q of state.pins) {
    g.fillStyle = q.sample ? '#ffb020' : '#cfe3dc';
    g.beginPath(); g.moveTo(X(q.x), Y(q.y) - 8); g.lineTo(X(q.x) - 6, Y(q.y) + 4); g.lineTo(X(q.x) + 6, Y(q.y) + 4); g.fill();
    g.fillText(`${q.sample ? 'S' : 'P'}${q.n}`, X(q.x) + 8, Y(q.y));
  }
  // EV pose
  if (p) {
    g.save(); g.translate(X(p.x), Y(p.y)); g.rotate((p.h * Math.PI) / 180);
    g.fillStyle = '#7be0b0'; g.beginPath(); g.moveTo(0, -11); g.lineTo(7, 8); g.lineTo(0, 4); g.lineTo(-7, 8); g.fill(); g.restore();
  }
  const b = bearingTo(state.target);
  $('find-target').textContent = state.target ? `· ${state.target.label}` : '';
  $('find-info').textContent = b ? `${Math.round(b.dist)} m · bearing ${Math.round(b.bearing)}°` : `${state.pins.length} pins · ${state.trail.length} breadcrumbs`;
}

function renderRangeDetail() {
  const e = state.est, t = state.eva?.telemetry, home = bearingTo(state.home);
  $('range-detail').innerHTML = [
    ['Return radius', e?.meters != null ? `${Math.round(e.meters)} m` : 'learning…'],
    ['Time to reserve', e?.minutes != null ? `${Math.round(e.minutes)} min` : '—'],
    ['Limited by', e?.limitedBy ?? '—'],
    ['Lander', home ? `${Math.round(home.dist)} m @ ${Math.round(home.bearing)}°` : '—'],
    ['O2 PRI / SEC', t ? `${fmt(t.oxy_pri_storage, '%')} / ${fmt(t.oxy_sec_storage, '%')}` : '—'],
    ['O2 use', t ? fmt(t.oxy_consumption, 'psi/min') : '—'],
    ['Batt PRI', t ? fmt(t.primary_battery_level, '%') : '—'],
  ].map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
    '<p style="color:var(--dim);font-size:12px">Conservative headset estimate: linear burn rate over last 5 min, 20 % reserve, 40 m/min out-and-back.</p>';
}

function renderProcedure() {
  const pr = state.proc; if (!pr) return;
  $('proc-title').textContent = pr.def.name;
  if (pr.done) {
    $('proc-group').textContent = ''; $('proc-step').textContent = 'Egress complete ✓';
    $('proc-progress').textContent = `${pr.def.steps.length} of ${pr.def.steps.length}`; $('proc-upcoming').innerHTML = '';
    $('proc-wrong').classList.add('hidden'); return;
  }
  const s = pr.step;
  let hint = s.type === 'manual' ? 'say "done" when complete' : s.type === 'switch' ? 'auto-checks from TSS' : '';
  if (s.type === 'wait' && state.eva) hint = s.all.map((c) => `${c.path.split('.').pop()} ${fmt(get(state.eva, c.path))} ${c.op} ${c.value}`).join(' · ');
  $('proc-group').textContent = s.group;
  $('proc-step').innerHTML = `${esc(s.text)}<span class="hint">${esc(hint)}</span>`;
  $('proc-progress').textContent = `step ${pr.index + 1} of ${pr.def.steps.length}`;
  const w = pr.wrong && Date.now() - pr.wrong.at < 15000;
  $('proc-wrong').classList.toggle('hidden', !w);
  if (w) $('proc-wrong').textContent = `⚠ ${pr.wrong.path} changed — not this step`;
  $('proc-upcoming').innerHTML = pr.def.steps.slice(pr.index + 1, pr.index + 4).map((x) => `<li>${esc(x.text)}</li>`).join('');
  $('proc-upcoming').start = pr.index + 2;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------- panels
const timers = {};
function show(name, sticky = false) {
  const el = $(`panel-${name}`);
  // Status/Find/Range share the right edge: one at a time.
  if (name !== 'procedure') for (const n of ['status', 'find', 'range']) if (n !== name) $(`panel-${n}`).classList.add('hidden');
  el.classList.remove('hidden');
  clearTimeout(timers[name]);
  if (!sticky) timers[name] = setTimeout(() => el.classList.add('hidden'), PANEL_TIMEOUT_MS);
  render();
}
function hideAll() { document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden')); state.target = null; render(); }

let toastTimer;
function toast(text) {
  const el = $('toast'); el.textContent = text; el.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
  if (state.viaVoice && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ---------------------------------------------------------------- commands (five fixed + panel verbs)
function command(raw) {
  const c = raw.toLowerCase().replace(/^(hey\s+)?waymark[,\s]*/, '').trim();
  const t = state.eva?.telemetry;
  if (!c) return;
  if (/^(status|vitals)/.test(c)) return show('status');
  if (/^(oxygen|o2)/.test(c) && t) return toast(`Primary O2 ${Math.round(t.oxy_pri_storage)} percent, secondary ${Math.round(t.oxy_sec_storage)}`);
  if (/^(heart|hr)/.test(c) && t) return toast(`Heart rate ${Math.round(t.heart_rate)}`);
  if (/^range/.test(c)) return show('range');
  if (/^find/.test(c)) return find(c.replace(/^find\s*/, ''));
  if (/^(mark|pin)/.test(c)) return mark(/sample/.test(c));
  if (/^(procedure|steps?)/.test(c)) return show('procedure', true);
  if (/^next/.test(c)) { state.proc?.next(); return show('procedure', true); }
  if (/^back/.test(c)) { state.proc?.back(); return show('procedure', true); }
  if (/^done/.test(c)) { if (state.proc?.step?.type === 'manual') state.proc.next(); return show('procedure', true); }
  if (/^repeat/.test(c)) return toast(state.proc?.step?.text ?? 'No active step');
  if (/^restart procedure/.test(c)) { state.proc?.reset(); return show('procedure', true); }
  if (/^(close|hide|dismiss)/.test(c)) return hideAll();
  if (/^clear map/.test(c)) { state.trail = []; state.pins = []; state.home = null; saveMap(); return toast('Map cleared'); }
  toast(`Not understood: "${c}". Try status, find, range, mark, procedure.`);
}

function find(what) {
  let t = null;
  if (!what || /lander|home|start|airlock/.test(what)) t = state.home && { label: 'lander', ...state.home };
  else {
    const n = Number((what.match(/\d+/) || [])[0]);
    const pool = /sample/.test(what) ? state.pins.filter((p) => p.sample) : state.pins;
    const p = n ? pool.find((q) => q.n === n) : pool.at(-1);
    if (p) t = { label: `${p.sample ? 'sample' : 'pin'} ${p.n}`, x: p.x, y: p.y };
  }
  if (!t) return toast(`Nothing to find for "${what || 'lander'}"`);
  state.target = t;
  show('find');
  const b = bearingTo(t);
  if (b) toast(`${t.label}: ${Math.round(b.dist)} meters, bearing ${Math.round(b.bearing)}`);
}

function mark(sample) {
  const p = pos();
  if (!p) return toast('No position from TSS');
  const spec = state.eva?.spec;
  const pin = { n: state.pins.length + 1, x: p.x, y: p.y, t: state.eva?.telemetry?.eva_elapsed_time ?? 0, sample,
    rock: sample ? spec?.name : undefined, data: sample ? spec?.data : undefined };
  state.pins.push(pin); saveMap();
  const top = sample && spec?.data ? Object.entries(spec.data).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}%`).join(', ') : '';
  toast(sample ? `Sample ${pin.n} marked · ${spec?.name ?? 'no XRF'}${top ? ' · ' + top : ''}` : `Pin ${pin.n} dropped`);
  show('find');
}

$('voice').addEventListener('submit', (e) => { e.preventDefault(); state.viaVoice = false; command($('voice-input').value); $('voice-input').value = ''; });
$('status-toggle').addEventListener('click', () => { state.showNominal = !state.showNominal; show('status'); });
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  const map = { s: 'status', f: 'find lander', r: 'range', m: 'mark sample', p: 'procedure', n: 'next', b: 'back', d: 'done', Escape: 'close' };
  if (map[e.key]) { e.preventDefault(); state.viaVoice = false; command(map[e.key]); }
  if (e.key === '/') { e.preventDefault(); $('voice-input').focus(); }
});

// Browser speech recognition stands in for the MRTK keyword recognizer.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SR) {
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false;
  rec.onresult = (e) => { state.viaVoice = true; command(e.results[0][0].transcript); };
  rec.onend = () => $('mic').classList.remove('live');
  $('mic').onclick = () => { $('mic').classList.add('live'); rec.start(); };
} else $('mic').classList.add('hidden');

// ---------------------------------------------------------------- dev drawer
const UIA = [[2001, 'uia.eva1_power', 'EMU1 PWR'], [2002, 'uia.eva1_oxy', 'EV1 O2'], [2003, 'uia.eva1_water_supply', 'EV1 SUPPLY'],
  [2004, 'uia.eva1_water_waste', 'EV1 WASTE'], [2009, 'uia.oxy_vent', 'O2 VENT'], [2010, 'uia.depress', 'DEPRESS']];
const DCU = [[2011, 'dcu.batt.lu', 'BATT LOCAL'], [2013, 'dcu.batt.ps', 'BATT PRI'], [2012, 'dcu.oxy', 'OXY PRI'],
  [2014, 'dcu.fan', 'FAN PRI'], [2015, 'dcu.pump', 'PUMP OPEN'], [2016, 'dcu.co2', 'CO2 A']];

function devButtons(list, parent) {
  for (const [cmd, path, label] of list) {
    const b = document.createElement('button');
    b.textContent = label; b.dataset.path = path;
    b.onclick = () => send({ command: cmd, value: get(state.eva, path) ? 0 : 1 }, `${label} → ${get(state.eva, path) ? 'off' : 'on'}`);
    $(parent).appendChild(b);
  }
}
devButtons(UIA, 'dev-uia'); devButtons(DCU, 'dev-dcu');
function renderDev() {
  document.querySelectorAll('#dev button[data-path]').forEach((b) => b.classList.toggle('on', get(state.eva, b.dataset.path) === true));
}

async function send(body, label) {
  try {
    const r = await (await fetch('/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    $('dev-log').textContent = `${new Date().toLocaleTimeString()} ${label}: ${r.ok ? 'ok' : 'FAILED ' + (r.error || '')}\n` + $('dev-log').textContent;
  } catch (e) { $('dev-log').textContent = `${label}: ${e.message}\n` + $('dev-log').textContent; }
}

document.querySelectorAll('#dev button[data-field]').forEach((b) => (b.onclick = () => send({ field: b.dataset.field, value: b.dataset.value }, b.textContent)));
document.querySelectorAll('#dev button[data-walk]').forEach((b) => (b.onclick = async () => {
  const p = pos(); if (!p) return;
  const d = Number(b.dataset.walk), r = (p.h * Math.PI) / 180;
  await send({ command: 2017, value: p.x + Math.sin(r) * d }, 'posx');
  await send({ command: 2018, value: p.y + Math.cos(r) * d }, 'posy');
}));
document.querySelectorAll('#dev button[data-turn]').forEach((b) => (b.onclick = () => {
  const p = pos(); if (p) send({ command: 2019, value: norm(p.h + Number(b.dataset.turn)) }, 'heading');
}));
$('dev-rock').onchange = (e) => send({ command: 2020, value: Number(e.target.value) }, `rock ${e.target.value}`);

// Demo convenience: http://localhost:8080/#status,procedure runs those commands once data arrives.
if (location.hash.length > 1) {
  const cmds = decodeURIComponent(location.hash.slice(1)).split(',');
  const wait = setInterval(() => { if (state.eva && state.proc) { clearInterval(wait); cmds.forEach(command); } }, 200);
}

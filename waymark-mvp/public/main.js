// WAYMARK v2 integrator: wires TSS telemetry (SSE from bridge.js), the 3D world, the HUD,
// the mission scenario, fault injection and route planning into one model per frame.
import { evaluate } from './cw.js';
import { RangeModel } from './range.js';
import { Procedure } from './procedure.js';
import { createWorld } from './world/world.js';
import { createHud } from './hud/hud.js';
import { Scenario, returnCheck } from './mission/scenario.js';
import { FaultInjector } from './mission/faults.js';
import { planRoute } from './mission/astar.js';
import { allPois } from './mission/pois.js';

const POSE_SYNC_MS = 1000;
const TRAIL_STEP_M = 1.0;

const config = await (await fetch('world/world.json')).json();
const [egressDef, ingressDef] = await Promise.all([
  fetch('procedures/egress.json').then((r) => r.json()),
  fetch('procedures/ingress.json').then((r) => r.json()),
]);

// ------------------------------------------------------------------ state
const range = new RangeModel();
const faults = new FaultInjector();
const procs = { egress: new Procedure(egressDef), ingress: new Procedure(ingressDef) };
const pois = allPois(config.pois);
const scenario = new Scenario({ pois });

const store = loadStore();
const model = {
  eva: null, link: 'connecting', stale: true, ageMs: Infinity,
  pose: { x: 0, y: 0, heading: 0 },
  cw: null, est: null, proc: procs.egress, alerts: [],
  pois, pins: store.pins, trail: store.trail, route: [], target: null,
  scenario: scenario.state, syncToTss: store.syncToTss ?? true, faults: [],
};

let rawEva = null;         // last TSS snapshot, before fault injection
let receivedAt = 0;        // when TSS last answered (commsloss freezes this)
let lastSeq = -1;
let lastFaultTick = performance.now();

// ------------------------------------------------------------------ world + hud
const world = await createWorld({ canvas: document.getElementById('world'), config });
const hud = createHud({ root: document.getElementById('hud'), onCommand: command, worldHighlight: (k) => world.highlight(k) });
document.getElementById('boot').classList.add('gone');
model.pose = { ...world.pose };
world.setPois(pois);
world.setPins(model.pins);
world.setTrail(model.trail);

world.onPose((p) => {
  model.pose = { ...p };
  const last = model.trail.at(-1);
  if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= TRAIL_STEP_M) {
    model.trail.push({ x: p.x, y: p.y });
    world.setTrail(model.trail);
    saveStore();
  }
});

// ------------------------------------------------------------------ telemetry
const es = new EventSource('/events');
es.onmessage = (e) => {
  const snap = JSON.parse(e.data);
  model.link = snap.link;
  if (snap.eva && snap.seq !== lastSeq) {
    lastSeq = snap.seq;
    rawEva = snap.eva;
    receivedAt = snap.receivedAt;
    tickTelemetry();
  }
};
es.onerror = () => { model.link = 'bridge down'; };

// Runs once per TSS update (~1 Hz) and once per second during commsloss so faults keep evolving.
function tickTelemetry() {
  const now = performance.now();
  const dt = Math.min(5, (now - lastFaultTick) / 1000);
  lastFaultTick = now;
  if (!rawEva) return;
  const eva = faults.apply(rawEva, dt);
  model.faults = [...faults.active];
  if (eva === null) { frozenAt ??= receivedAt; return; } // commsloss: hold last values, let the age grow
  frozenAt = null;
  model.eva = eva;
  range.add(eva);
  model.proc.update(eva);
}
let frozenAt = null;
setInterval(() => { if (faults.active.length) tickTelemetry(); }, 1000);

function effectiveReceivedAt() {
  return frozenAt ?? receivedAt;
}

// ------------------------------------------------------------------ pose sync → TSS (HTTP form path, latest-wins)
let lastSync = { x: NaN, y: NaN, heading: NaN, at: 0 };
setInterval(() => {
  if (!model.syncToTss || model.link !== 'ok') return;
  const p = model.pose;
  if (Math.hypot(p.x - lastSync.x, p.y - lastSync.y) < 0.3 && Math.abs(p.heading - lastSync.heading) < 3) return;
  lastSync = { ...p, at: Date.now() };
  fetch('/pose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }).catch(() => {});
}, POSE_SYNC_MS);

// ------------------------------------------------------------------ routing
let grid = null;
let planFrom = null;   // pose + target the current route was planned for
function replan(force = false) {
  if (!model.target) { if (model.route.length) { model.route = []; world.setRoute([]); } planFrom = null; return; }
  const p = model.pose, t = model.target;
  const moved = planFrom ? Math.hypot(p.x - planFrom.x, p.y - planFrom.y) : Infinity;
  const retarget = !planFrom || planFrom.tx !== t.x || planFrom.ty !== t.y;
  if (!force && !retarget && moved < 2) return;
  grid ??= world.costGrid({ cell: 1 });
  planFrom = { x: p.x, y: p.y, tx: t.x, ty: t.y };
  model.route = planRoute(grid, p, t);
  world.setRoute(model.route);
}

function setTarget(t) {
  model.target = t;
  world.setTarget(t);
  replan(true);
}

// ------------------------------------------------------------------ alerts (C&W + range + procedure)
function buildAlerts() {
  const a = [];
  if (model.cw.stale) {
    a.push({ level: 'warning', text: receivedAt ? `LIMITED MODE · telemetry ${Math.round(model.cw.ageMs / 1000)} s old` : 'NO TELEMETRY',
      action: 'Local warnings, procedures, breadcrumbs only' });
  } else {
    for (const i of model.cw.offNominal) {
      a.push({ level: i.level, text: i.flag ? i.label.toUpperCase() : `${i.label} ${fmtVal(i.value)} ${i.unit}`,
        action: i.action || (i.level === 'warning' ? `nominal ${i.min}–${i.max} ${i.unit}` : 'nearing limit') });
    }
  }
  const rc = returnCheck(model);
  if (rc && !rc.ok && model.eva?.status?.started) a.push({ level: 'warning', text: 'RETURN NOW', action: `${Math.round(rc.marginMin)} min margin · follow route to HAB` });
  const w = model.proc?.wrong;
  if (w && Date.now() - w.at < 15000) a.push({ level: 'caution', text: `Wrong switch: ${w.path}`, action: `Expected: ${model.proc.step?.text ?? ''}` });
  const rank = { warning: 0, caution: 1 };
  return a.sort((x, y) => rank[x.level] - rank[y.level]);
}
const fmtVal = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

// Values an injected fault drives off-nominal always alarm, even while the egress hold
// (suitActive=false) is suppressing pre-pressurization noise.
const FAULT_KEYS = { o2leak: ['oxy_pri_storage', 'suit_pressure_oxy'], fanfail: ['fan_pri_rpm'], co2high: ['scrubber_a_co2_storage', 'helmet_pressure_co2', 'suit_pressure_co2'],
  hrhigh: ['heart_rate'], battlow: ['primary_battery_level'] };
function withFaultValues(cw, now) {
  const keys = new Set(faults.active.flatMap((id) => FAULT_KEYS[id] ?? []));
  if (!keys.size || procs.egress.done || !model.eva) return cw;
  const open = evaluate(model.eva, { receivedAt: effectiveReceivedAt(), now, suitActive: true });
  const byKey = new Map(open.items.filter((i) => keys.has(i.key) && i.level !== 'nominal').map((i) => [i.key, i]));
  if (!byKey.size) return cw;
  const items = cw.items.map((i) => byKey.get(i.key) ?? i);
  const rank = { warning: 0, caution: 1, nominal: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);
  return { ...cw, items, offNominal: items.filter((i) => i.level !== 'nominal') };
}

// ------------------------------------------------------------------ frame loop
function frame() {
  const now = Date.now();
  // Procedure for the current scenario phase (egress before, ingress at the end).
  const want = scenario.state.phase?.procedure;
  if (want && procs[want] && model.proc !== procs[want]) model.proc = procs[want];

  model.cw = withFaultValues(evaluate(model.eva, { receivedAt: effectiveReceivedAt(), now, suitActive: procs.egress.done }), now);
  model.stale = model.cw.stale;
  model.ageMs = model.cw.ageMs;
  model.est = range.estimate();

  const before = scenario.state.phaseIndex;
  scenario.update(model);
  model.scenario = scenario.state;
  if (scenario.state.phaseIndex !== before) onPhaseChange();
  else if ((scenario.state.phase?.targetId ?? null) !== scenarioTargetId) followScenarioTarget();

  replan();
  model.alerts = buildAlerts();
  hud.update(model);
  requestAnimationFrame(frame);
}

let scenarioTargetId = null;
function followScenarioTarget() {
  const id = scenario.state.phase?.targetId ?? null;
  scenarioTargetId = id;
  const p = id && pois.find((q) => q.id === id);
  setTarget(p ? { label: p.label, x: p.x, y: p.y, id: p.id } : null);
}
function onPhaseChange() {
  const ph = scenario.state.phase;
  if (!ph) return;
  hud.toast(`${ph.title} — ${ph.objective}`);
  followScenarioTarget();
  if (ph.procedure) hud.show('procedure', true);
}
onPhaseChange();
requestAnimationFrame(frame);

// ------------------------------------------------------------------ commands (voice/text/hotkeys/dev drawer)
const UIA_DCU_PATHS = { 2001: 'uia.eva1_power', 2002: 'uia.eva1_oxy', 2003: 'uia.eva1_water_supply', 2004: 'uia.eva1_water_waste',
  2009: 'uia.oxy_vent', 2010: 'uia.depress', 2011: 'dcu.batt.lu', 2012: 'dcu.oxy', 2013: 'dcu.batt.ps', 2014: 'dcu.fan', 2015: 'dcu.pump', 2016: 'dcu.co2' };
const FAULT_FIX = { o2leak: { path: 'dcu.oxy', label: 'DCU OXY' }, fanfail: { path: 'dcu.fan', label: 'DCU FAN' },
  co2high: { path: 'dcu.co2', label: 'DCU CO2' }, battlow: { path: 'dcu.batt.ps', label: 'DCU BATT' } };
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

function send(body) {
  return fetch('/cmd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json()).catch(() => ({ ok: false }));
}

function command(raw) {
  const text = String(raw).trim();
  if (text.startsWith('dev:')) return devCommand(text.slice(4));
  const c = text.toLowerCase().replace(/^(hey\s+)?waymark[,\s]*/, '').trim();
  const t = model.eva?.telemetry;
  if (!c) return;
  if (/^(status|vitals)/.test(c)) return hud.show('status');
  if (/^(oxygen|o2)/.test(c) && t) return hud.toast(`Primary O2 ${Math.round(t.oxy_pri_storage)} percent, secondary ${Math.round(t.oxy_sec_storage)}`, { speak: true });
  if (/^(heart|hr)/.test(c) && t) return hud.toast(`Heart rate ${Math.round(t.heart_rate)}`, { speak: true });
  if (/^range/.test(c)) return hud.show('range');
  if (/^find/.test(c)) return find(c.replace(/^find\s*/, ''));
  if (/^(mark|pin)/.test(c)) return mark(/sample/.test(c));
  if (/^(procedure|steps?)/.test(c)) return hud.show('procedure', true);
  if (/^next/.test(c)) { if (model.proc && !model.proc.done) model.proc.next(); else scenario.next(); return hud.show('procedure', true); }
  if (/^back/.test(c)) { model.proc?.back(); return hud.show('procedure', true); }
  if (/^done/.test(c)) {
    if (model.proc && !model.proc.done && model.proc.step?.type === 'manual') model.proc.next();
    else if (!scenario.state.phase?.procedure) scenario.next();
    return hud.show('procedure', true);
  }
  if (/^repeat/.test(c)) return hud.toast(model.proc?.done ? scenario.state.phase?.objective ?? '' : model.proc?.step?.text ?? '', { speak: true });
  if (/^(close|hide|dismiss|cancel)/.test(c)) { hud.hideAll(); return setTarget(null); }
  if (/^clear map/.test(c)) { model.trail.length = 0; model.pins.length = 0; world.setTrail([]); world.setPins([]); saveStore(); return hud.toast('Map cleared'); }
  hud.toast(`Not understood: "${c}". Try status, find, range, mark, procedure.`);
}

function find(what) {
  let t = null;
  const w = what || 'hab';
  if (/lander|home|hab|start|airlock/.test(w)) t = poiTarget('hab');
  else if (/ltv|rover|task|board/.test(w)) t = poiTarget(/\bb\b|bravo/.test(w) ? 'ltv-b' : 'ltv-a');
  else if (/sample|pin/.test(w)) {
    const n = Number((w.match(/\d+/) || [])[0]);
    const pool = /sample/.test(w) ? model.pins.filter((p) => p.sample) : model.pins;
    const p = n ? pool.find((q) => q.n === n) : pool.at(-1);
    if (p) t = { label: `${p.sample ? 'Sample' : 'Pin'} ${p.n}`, x: p.x, y: p.y };
  } else {
    const p = pois.find((q) => q.label.toLowerCase().includes(w) || q.id.includes(w.replace(/\s+/g, '-')));
    if (p) t = { label: p.label, x: p.x, y: p.y, id: p.id };
  }
  if (!t) return hud.toast(`Nothing to find for "${w}"`);
  setTarget(t);
  hud.show('find');
  const d = Math.hypot(t.x - model.pose.x, t.y - model.pose.y);
  const brg = ((Math.atan2(t.x - model.pose.x, t.y - model.pose.y) * 180) / Math.PI + 360) % 360;
  hud.toast(`${t.label}: ${Math.round(d)} meters, bearing ${Math.round(brg)}`, { speak: true });
}
function poiTarget(id) { const p = pois.find((q) => q.id === id); return p && { label: p.label, x: p.x, y: p.y, id: p.id }; }

function mark(sample) {
  const p = model.pose;
  const spec = model.eva?.spec;
  const pin = { n: model.pins.length + 1, x: p.x, y: p.y, t: model.eva?.telemetry?.eva_elapsed_time ?? 0, sample,
    rock: sample ? spec?.name : undefined, data: sample ? spec?.data : undefined };
  model.pins.push(pin);
  world.setPins(model.pins);
  saveStore();
  const top = sample && spec?.data ? Object.entries(spec.data).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k} ${v}%`).join(', ') : '';
  hud.toast(sample ? `Sample ${pin.n} marked · ${spec?.name ?? 'no XRF'}${top ? ' · ' + top : ''}` : `Pin ${pin.n} dropped`, { speak: true });
}

async function devCommand(c) {
  if (c === 'start' || c === 'stop') return send({ field: 'eva.status.started', value: c === 'start' ? 'true' : 'false' });
  if (c.startsWith('cmd:')) {
    const n = Number(c.slice(4));
    const cur = getPath(rawEva, UIA_DCU_PATHS[n] ?? '');
    return send({ command: n, value: cur ? 0 : 1 });
  }
  if (c === 'sync:on' || c === 'sync:off') { model.syncToTss = c === 'sync:on'; return saveStore(); }
  if (c === 'fault:clear') { faults.clearAll(); model.faults = []; return; }
  if (c.startsWith('fault:')) {
    const id = c.slice(6);
    if (faults.active.includes(id)) { faults.clear(id); model.faults = [...faults.active]; return; }
    if (id !== 'commsloss' && !rawEva?.status?.started) return hud.toast('Start the EVA first — faults ride on live suit telemetry');
    const fix = FAULT_FIX[id];
    if (fix && getPath(rawEva, fix.path) === false) hud.toast(`${fix.label} is already on the backup — flip it to primary first, then the fault will need you to switch back`);
    faults.inject(id); model.faults = [...faults.active];
    return;
  }
  if (c === 'scenario:next') return scenario.next();
  if (c === 'scenario:back') return scenario.back();
  if (c === 'scenario:reset') {
    scenario.reset(); procs.egress.reset(); procs.ingress.reset(); model.proc = procs.egress;
    const hab = poiTarget('hab'); if (hab) world.setPose({ x: hab.x, y: hab.y, heading: world.pose.heading });
    return onPhaseChange();
  }
}

// ------------------------------------------------------------------ persistence (per-viewer convenience only)
function loadStore() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('waymark-v2') || '{}') || {}; } catch { /* storage unavailable */ }
  return { trail: Array.isArray(s.trail) ? s.trail : [], pins: Array.isArray(s.pins) ? s.pins : [], syncToTss: s.syncToTss };
}
function saveStore() {
  try {
    localStorage.setItem('waymark-v2', JSON.stringify({ trail: model.trail.slice(-4000), pins: model.pins, syncToTss: model.syncToTss }));
  } catch { /* storage unavailable */ }
}

window.waymark = { model, world, hud, scenario, faults, command }; // console debugging

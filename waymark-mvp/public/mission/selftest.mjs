// Node self test: `node public/mission/selftest.mjs`. Exercises Scenario, FaultInjector, planRoute.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Scenario, returnCheck, LTV_STEPS } from './scenario.js';
import { FaultInjector, FAULTS } from './faults.js';
import { planRoute } from './astar.js';
import { GEOLOGY_POIS, allPois } from './pois.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

// ---------------------------------------------------------------- Scenario
const WORLD = [
  { id: 'hab', label: 'HAB', kind: 'lander', x: -5670, y: -10060 },
  { id: 'ltv-a', label: 'LTV Task Board A', kind: 'worksite', x: -5635, y: -9970 },
  { id: 'ltv-b', label: 'LTV Task Board B', kind: 'worksite', x: -5615, y: -9995 },
];
const ingressDef = JSON.parse(readFileSync(new URL('../procedures/ingress.json', import.meta.url)));
// Minimal stand-in for ../procedure.js Procedure (only def/index/done are read).
const proc = (name, done, n = 10) => ({ def: { name, steps: new Array(n) }, index: done ? n : 2, done });

test('pois', () => {
  const all = allPois(WORLD);
  assert.equal(all.length, WORLD.length + GEOLOGY_POIS.length);
  for (const g of GEOLOGY_POIS) {
    assert.ok(g.x >= -5695 && g.x <= -5585 && g.y >= -10066 && g.y <= -9954, `${g.id} in bounds`);
  }
});

test('ingress.json shape', () => {
  assert.equal(ingressDef.id, 'ingress');
  for (const s of ingressDef.steps) assert.ok(['manual', 'switch', 'wait'].includes(s.type));
});

test('scenario progression', () => {
  let t = 0;
  const sc = new Scenario({ pois: allPois(WORLD), now: () => ++t });
  const hab = WORLD[0], ltv = WORLD[1];
  const m = { pose: { x: hab.x, y: hab.y, heading: 0 }, proc: proc('EVA Egress (EV1)', false), pins: [], pois: allPois(WORLD) };

  sc.update(m);
  assert.equal(sc.state.phase.id, 'egress');
  assert.match(sc.state.phase.objective, /step 3\/10/);
  m.proc = proc('EVA Ingress (EV1)', true);          // wrong procedure done → no advance
  sc.update(m); assert.equal(sc.state.phase.id, 'egress');
  m.proc = proc('EVA Egress (EV1)', true);
  assert.equal(sc.update(m), true);
  assert.equal(sc.state.phase.id, 'nav-ltv');

  sc.update(m);
  assert.equal(sc.state.phase.targetId, 'ltv-a');
  assert.ok(Math.abs(sc.state.phase.distance - Math.hypot(35, 90)) < 1e-6);
  assert.match(sc.state.phase.objective, /^Walk to LTV A · 97 m$/);
  m.pose = { x: ltv.x + 2, y: ltv.y, heading: 0 };
  sc.update(m); assert.equal(sc.state.phase.id, 'ltv-repair');

  sc.update(m); assert.equal(sc.state.phase.step.index, 0);
  for (let i = 1; i < LTV_STEPS.length; i++) { sc.next(); assert.equal(sc.state.phase.step.index, i); }
  sc.back(); assert.equal(sc.state.phase.step.index, LTV_STEPS.length - 2);
  sc.next(); sc.next();
  assert.equal(sc.state.phase.id, 'geology');

  const [g1, g2] = [GEOLOGY_POIS[0], GEOLOGY_POIS[1]];
  m.pose = { x: g1.x, y: g1.y, heading: 0 }; sc.update(m);
  assert.deepEqual(sc.state.phase.visited, [g1.id]);
  m.pose = { x: g2.x + 1, y: g2.y, heading: 0 }; sc.update(m);
  assert.equal(sc.state.phase.id, 'geology', 'needs a sample');
  assert.match(sc.state.phase.objective, /sample/);
  m.pins = [{ n: 1, x: 0, y: 0, sample: true }];      // sample far from any site doesn't count
  sc.update(m); assert.equal(sc.state.phase.id, 'geology');
  m.pins.push({ n: 2, x: g2.x + 2, y: g2.y, sample: true });
  sc.update(m); assert.equal(sc.state.phase.id, 'return');

  sc.update(m); assert.equal(sc.state.phase.targetId, 'hab');
  m.pose = { x: hab.x, y: hab.y - 2.9, heading: 0 }; sc.update(m);
  assert.equal(sc.state.phase.id, 'ingress');
  assert.equal(sc.state.phase.procedure, 'ingress');
  m.proc = { def: ingressDef, index: 0, done: false }; sc.update(m);
  assert.match(sc.state.phase.objective, /step 1\/12/);
  m.proc = { def: ingressDef, index: 12, done: true }; sc.update(m);
  assert.equal(sc.state.complete, true);
  assert.equal(sc.state.phase.id, 'complete');

  const tos = sc.state.log.map((e) => e.to).filter((x, i, a) => a.indexOf(x) === i);
  assert.deepEqual(tos, ['egress', 'nav-ltv', 'ltv-repair', 'geology', 'return', 'ingress', 'complete']);
  assert.ok(sc.state.log.every((e, i, a) => i === 0 || e.t > a[i - 1].t), 'timestamps increase');

  sc.back(); assert.equal(sc.state.complete, false);
  sc.back(); assert.equal(sc.state.phase.id, 'return');
  sc.reset(); assert.equal(sc.state.phase.id, 'egress'); assert.equal(sc.state.log.length, 1);
  sc.next(); assert.equal(sc.state.phase.id, 'nav-ltv', 'manual skip');
});

test('returnCheck', () => {
  const pois = WORLD;
  const pose = { x: -5670, y: -9980 };                 // 80 m from HAB → 2 min walk
  assert.deepEqual(returnCheck({ pose, pois, est: null }).marginMin, null);
  let r = returnCheck({ pose, pois, est: { minutes: 10 } });
  assert.equal(r.ok, true); assert.ok(Math.abs(r.marginMin - 8) < 1e-9);
  r = returnCheck({ pose, pois, est: { minutes: 1.5 } });
  assert.equal(r.ok, false);
  r = returnCheck({ pose, pois, est: { minutes: 5 } }, { x: -5670, y: -9900 }); // 80 + 160 m → 6 min
  assert.equal(r.ok, false); assert.ok(Math.abs(r.marginMin + 1) < 1e-9);
});

// ---------------------------------------------------------------- Faults
const baseEva = () => ({
  telemetry: {
    primary_battery_level: 90, secondary_battery_level: 95, oxy_pri_storage: 80, oxy_sec_storage: 90,
    suit_pressure_oxy: 4.0, suit_pressure_co2: 0.03, helmet_pressure_co2: 0.05, fan_pri_rpm: 30000, fan_sec_rpm: 0,
    scrubber_a_co2_storage: 20, scrubber_b_co2_storage: 5, heart_rate: 90,
  },
  status: { started: true },
  dcu: { oxy: true, fan: true, pump: false, co2: true, batt: { lu: true, ps: true } },
  error: { fan_error: false, oxy_error: false, power_error: false, scrubber_error: false },
});
const run = (fi, eva, secs, dt = 0.1) => { let out; for (let t = 0; t < secs - 1e-9; t += dt) out = fi.apply(eva, dt); return out; };

test('faults: metadata, no-op, deep copy', () => {
  assert.deepEqual(FAULTS.map((f) => f.id), ['o2leak', 'fanfail', 'co2high', 'hrhigh', 'battlow', 'commsloss']);
  for (const f of FAULTS) assert.ok(f.label && f.description && f.fix);
  const fi = new FaultInjector(), eva = baseEva();
  assert.equal(fi.apply(eva, 1), eva);
  assert.equal(fi.apply(null, 1), null);
  fi.inject('o2leak'); fi.apply(eva, 1);
  assert.equal(eva.telemetry.oxy_pri_storage, 80, 'input untouched');
  assert.throws(() => fi.inject('nope'));
});

test('fault o2leak', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('o2leak');
  let out = run(fi, eva, 10);
  assert.ok(Math.abs(out.telemetry.oxy_pri_storage - 60) < 0.5, `drain ${out.telemetry.oxy_pri_storage}`);
  assert.ok(out.telemetry.suit_pressure_oxy < 3.5, 'suit O2 sinking');
  assert.equal(out.error.oxy_error, true);
  eva.dcu.oxy = false;                                   // OXY → SEC
  out = run(fi, eva, 10);
  assert.ok(Math.abs(out.telemetry.oxy_pri_storage - 60) < 0.5, 'stops draining, stays low');
  assert.equal(out.error.oxy_error, false);
  assert.equal(out.telemetry.suit_pressure_oxy, 4.0);
  assert.equal(fi.status[0].resolved, true);
});

test('fault fanfail', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('fanfail');
  let out = run(fi, eva, 20);
  assert.equal(out.telemetry.fan_pri_rpm, 0);
  assert.equal(out.error.fan_error, true);
  eva.dcu.fan = false;
  out = run(fi, eva, 1);
  assert.equal(out.error.fan_error, false);
  assert.equal(out.telemetry.fan_sec_rpm, 30000);
});

test('fault co2high', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('co2high');
  let out = run(fi, eva, 60);
  assert.ok(Math.abs(out.telemetry.scrubber_a_co2_storage - 70) < 1e-6);
  assert.ok(out.telemetry.helmet_pressure_co2 > 0.19);
  assert.ok(out.telemetry.suit_pressure_co2 > 0.115);
  eva.dcu.co2 = false;
  out = run(fi, eva, 60);
  assert.ok(out.telemetry.helmet_pressure_co2 < 0.06 && out.telemetry.suit_pressure_co2 < 0.04);
  assert.equal(out.error.scrubber_error, false);
});

test('fault hrhigh', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('hrhigh');
  let out = run(fi, eva, 40);
  assert.ok(out.telemetry.heart_rate > 165, `hr ${out.telemetry.heart_rate}`);
  out = run(fi, eva, 15);
  assert.ok(out.telemetry.heart_rate < 110, 'settles after 45 s');
  run(fi, eva, 6);
  assert.deepEqual(fi.active, [], 'self-clears');
});

test('fault battlow', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('battlow');
  let out = run(fi, eva, 15);
  assert.equal(out.telemetry.primary_battery_level, 18);
  assert.equal(out.error.power_error, true);
  eva.dcu.batt.ps = false;
  out = run(fi, eva, 1);
  assert.equal(out.error.power_error, false);
  assert.equal(out.telemetry.primary_battery_level, 18);
});

test('fault commsloss + clear', () => {
  const fi = new FaultInjector(), eva = baseEva();
  fi.inject('commsloss'); fi.inject('fanfail');
  assert.equal(fi.apply(eva, 1), null);
  fi.clear('commsloss');
  assert.notEqual(fi.apply(eva, 1), null);
  fi.clear('all'); assert.deepEqual(fi.active, []);
  fi.inject('o2leak'); fi.clearAll(); assert.equal(fi.apply(eva, 1), eva);
});

// ---------------------------------------------------------------- A*
function makeGrid(cols, rows, cell, slopeFn) {
  const slopeDeg = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) slopeDeg[r * cols + c] = slopeFn(c, r);
  return { originX: -5695, originY: -10066, cell, cols, rows, slopeDeg };
}
const cellAt = (g, p) => [Math.floor((p.x - g.originX) / g.cell), Math.floor((p.y - g.originY) / g.cell)];
const legsClear = (g, path, max = 15) => {
  // Sample every leg finely; no sample may land in a blocked cell (except start/goal cells).
  const [sc, sr] = cellAt(g, path[0]), [gc, gr] = cellAt(g, path.at(-1));
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (g.cell * 0.05));
    for (let k = 0; k <= n; k++) {
      const [c, r] = cellAt(g, { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
      if ((c === sc && r === sr) || (c === gc && r === gr)) continue;
      if (g.slopeDeg[r * g.cols + c] > max) return false;
    }
  }
  return true;
};
const len = (p) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - p[i].x, q.y - p[i].y), 0);

test('astar: open ground is a straight line', () => {
  const g = makeGrid(50, 50, 1, () => 2);
  const p = planRoute(g, { x: -5690, y: -10060 }, { x: -5650, y: -10020 });
  assert.equal(p.length, 2);
});

test('astar: slope wall forces a detour', () => {
  // Vertical wall at column 25 from row 0..39 (gap at the top rows 40..49).
  const g = makeGrid(50, 50, 1, (c, r) => (c === 25 && r < 40 ? 30 : 3));
  const start = { x: -5695 + 10.5, y: -10066 + 5.5 }, goal = { x: -5695 + 40.5, y: -10066 + 5.5 };
  const p = planRoute(g, start, goal);
  assert.ok(p.length >= 3, 'has turn points');
  assert.ok(Math.max(...p.map((q) => q.y)) > -10066 + 39.9, 'goes around the top of the wall');
  assert.ok(legsClear(g, p), 'no leg crosses the wall');
  assert.ok(len(p) > 70 && len(p) < 85, `detour length ${len(p).toFixed(1)}`);
  assert.deepEqual(p[0], start); assert.deepEqual(p.at(-1), goal);
});

test('astar: no corner cutting through diagonal gap', () => {
  // Two blocked cells touching only at a corner; the diagonal between them must not be used.
  const g = makeGrid(10, 10, 1, (c, r) => ((c === 5 && r === 5) || (c === 4 && r === 4) ? 30 : 0));
  const p = planRoute(g, { x: -5695 + 4.5, y: -10066 + 5.5 }, { x: -5695 + 5.5, y: -10066 + 4.5 });
  assert.ok(p.length >= 3, 'must go around');
  assert.ok(legsClear(g, p));
});

test('astar: unreachable → []', () => {
  const g = makeGrid(50, 50, 1, (c) => (c === 25 ? 40 : 0));
  assert.deepEqual(planRoute(g, { x: -5690, y: -10060 }, { x: -5650, y: -10060 }), []);
  // ...but a steep start/goal cell itself is allowed.
  const g2 = makeGrid(20, 20, 1, (c, r) => ((c === 2 && r === 2) || (c === 17 && r === 17) ? 40 : 0));
  assert.equal(planRoute(g2, { x: -5695 + 2.5, y: -10066 + 2.5 }, { x: -5695 + 17.5, y: -10066 + 17.5 }).length, 2);
});

test('astar: slope weight prefers flatter ground', () => {
  // A band of 12° (passable but costly) on the direct line; flat ground around it.
  const g = makeGrid(60, 40, 1, (c, r) => (c >= 20 && c < 40 && r >= 10 && r < 30 ? 12 : 0));
  const p = planRoute(g, { x: -5695 + 5.5, y: -10066 + 20.5 }, { x: -5695 + 55.5, y: -10066 + 20.5 }, { slopeWeight: 0.05 });
  assert.ok(p.length >= 3, 'routes around the costly band');
});

test('astar: timing on 220×225 grid (< 30 ms)', () => {
  // Rocky synthetic terrain: pseudo-random slopes plus a long wall with one gap.
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const g = makeGrid(220, 225, 0.5, (c, r) => (r === 112 && c > 10 ? 40 : rnd() < 0.15 ? 20 + rnd() * 20 : rnd() * 12));
  const start = { x: g.originX + 100, y: g.originY + 2 }, goal = { x: g.originX + 10, y: g.originY + 110 };
  planRoute(g, start, goal);                         // warm-up (JIT)
  const times = [];
  let p;
  for (let i = 0; i < 10; i++) { const t0 = performance.now(); p = planRoute(g, start, goal); times.push(performance.now() - t0); }
  times.sort((a, b) => a - b);
  const median = times[5], worst = times[9];
  console.log(`    timing 220×225: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms, ${p.length} pts, ${len(p).toFixed(1)} m`);
  assert.ok(p.length >= 2 && legsClear(g, p));
  assert.ok(median < 30, `median ${median} ms`);
  // Corner-to-corner worst case.
  const t0 = performance.now();
  const q = planRoute(g, { x: g.originX + 0.2, y: g.originY + 0.2 }, { x: g.originX + 109.8, y: g.originY + 112.3 });
  const t1 = performance.now() - t0;
  console.log(`    timing corner→corner: ${t1.toFixed(2)} ms, ${q.length} pts`);
  assert.ok(t1 < 30);
  // Unreachable worst case: explores everything reachable before giving up.
  for (let c = 0; c < g.cols; c++) g.slopeDeg[100 * g.cols + c] = 40;
  const t2 = performance.now();
  assert.deepEqual(planRoute(g, start, goal), []);
  const t3 = performance.now() - t2;
  console.log(`    timing unreachable: ${t3.toFixed(2)} ms`);
  assert.ok(t3 < 30);
  // Smooth rolling terrain (closer to the real scan) simplifies to a handful of legs.
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) g.slopeDeg[r * g.cols + c] = 8 + 6 * Math.sin(c / 15) * Math.cos(r / 20);
  const t4 = performance.now();
  const sm = planRoute(g, start, goal);
  console.log(`    timing smooth terrain: ${(performance.now() - t4).toFixed(2)} ms, ${sm.length} pts`);
  assert.ok(sm.length <= 8);
});

console.log(`\n${passed} tests passed`);

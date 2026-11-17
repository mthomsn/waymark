# WAYMARK v2 — module contract (3D walkable HUD)

v2 = first-person Three.js walk through the real rock-yard scan with the WAYMARK HUD overlaid,
world-locked features, an explain-it tour, and a scripted mission scenario.
v1 (flat HUD) stays at `public/v1.html` and must keep working — do not edit v1 files
(`public/app.js`, `public/style.css`, `public/v1.html`).

**Hard rules for everyone**
- Never modify anything under `~/code/TSS2027` (read-only reference only).
- No npm / no build step. Plain ES modules in the browser. Three.js only via import map:
  `"three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js"`,
  `"three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"`.
- Stay inside your own folder (listed below). Reuse, don't copy: `public/cw.js`, `public/range.js`,
  `public/procedure.js`, `public/procedures/egress.json` (import them with `../cw.js` etc.; don't edit them).
- Visual language: low-light HUD — black/near-black, dim mint `#7be0b0` primary accent,
  `#cfe3dc` text, amber `#ffb020` caution, red `#ff4d4d` warning, mono font
  (`ui-monospace, "SF Mono", Menlo, monospace`). Few, thick, high-contrast elements.

## Coordinates
- **TSS frame** (what everything outside `world/` uses): meters, `x` = TSS `imu.posx`, `y` = TSS `imu.posy`,
  `heading` degrees, 0 = +y (north), clockwise. All POIs, pins, trail, route are `{x, y}` in TSS frame.
- **Scene frame** (inside `world/` only): Three.js, y-up. `scene.x = tssX - cx`, `scene.z = -(tssY - cy)`,
  where `[cx, cy] = world.json centerTss`. Terrain mesh scaled by `scale` (horizontal) / `verticalScale`, rotated by `rotationDeg`.
- Config: `public/world/world.json` (terrain URL, transform, eye height, POIs: HAB, LTV A, LTV B).

## Shared model (built by `public/main.js`, the integrator — owned by lead, not agents)
```js
model = {
  eva,            // TSS EVA.json after fault injection (may be null)
  link,           // 'ok' | 'lost' | 'connecting' | 'bridge down'
  stale, ageMs,   // from cw.evaluate
  pose: { x, y, heading },             // local 60 fps pose (TSS frame)
  cw,             // cw.evaluate(...) result {items, offNominal, stale, ageMs}
  est,            // RangeModel.estimate() | null  {minutes, meters, limitedBy, learning}
  proc,           // Procedure instance (current procedure)
  alerts,         // [{level:'warning'|'caution', text, action}] worst first
  pois,           // world.json pois
  pins,           // [{n, x, y, t, sample, rock, data}]
  trail,          // [{x, y}] breadcrumbs
  route,          // [{x, y}] planned path or []
  target,         // {label, x, y} | null
  scenario,       // Scenario.state (see mission/) or null
  syncToTss,      // bool
}
```

## world/ — agent WORLD
`public/world/world.js` exports `async function createWorld({ canvas, config })` → `api`:
- `api.pose` → `{x, y, heading}` (TSS frame); `api.onPose(cb)` called every frame the pose changes.
- `api.setPose({x, y, heading})` — teleport (e.g. follow TSS, scenario reset).
- `api.heightAt(x, y)`, `api.slopeAt(x, y)` (degrees) — TSS frame, from the terrain mesh (precompute a height grid).
- `api.costGrid({ cell })` → `{ originX, originY, cell, cols, rows, slopeDeg: Float32Array }` for A*.
- `api.setTrail(points)`, `api.setRoute(points)`, `api.setPois(pois)`, `api.setPins(pins)`, `api.setTarget(target|null)`.
- `api.highlight(kind|null)` — tour emphasis: `'trail'|'route'|'hazards'|'pois'|'pins'|'target'`.
- `api.setControlsEnabled(bool)`; `api.dispose()`.
- Controls: click canvas → pointer lock; WASD/arrows walk (≈1.4 m/s, Shift ≈3 m/s), mouse look, Esc releases.
  Ground-follow at `eyeHeight`. Do not capture keys while an `<input>` is focused. Keys owned by HUD
  (S F R M P N B D T H / Esc) must not be consumed by world (WASD + arrows + Shift only).
- Render: dark lunar sky with stars, low-angle sun (long shadows, south-pole lighting), grey regolith material
  with vertex normals; world-locked: breadcrumbs (dashed mint line + dots on ground), route (amber ribbon slightly
  above ground), POI beacons (tall thin light pillars + label sprite), pins/sample beacons, target pulse ring,
  hazard outline: edges of terrain cells steeper than threshold (default 12°) drawn red, only within ~10 m of the EV.

## hud/ — agent HUD
`public/index.html` (new v2 page: full-window canvas `#world` + HUD DOM overlay) and `public/hud/*`.
`public/hud/hud.js` exports `createHud({ root, onCommand })` → `{ update(model), toast(text), show(panel, sticky), tour }`.
- Ambient: heading strip (canvas), alert slot, range ring, link chip, phase/objective line (from `model.scenario`).
- Panels: Status, Find (minimap of trail/pois/pins/route/pose), Range, Procedure — same behaviors as v1 (`public/app.js` is the reference).
- Command box + mic; all text commands go to `onCommand(text)` (main.js parses). Hotkeys: S F R M P, N B D, T = tour, H = help, Esc = close.
- Dev drawer (collapsible, bottom-right): Start/Stop EVA, UIA/DCU toggles, "Sync pose to TSS" checkbox, fault injector buttons,
  scenario controls. It renders from `model` and calls `onCommand('dev:<action>')` (e.g. `dev:uia:2001`, `dev:start`, `dev:fault:o2leak`, `dev:sync:on`).
- `hud/tour.js`: "Explain-it" guided tour — ~10 steps, each a callout card pointing at a HUD element or a world feature
  (calls `worldHighlight(kind)` passed in), with title + 1–2 sentence explanation from the proposal (quiet HUD, C&W, range, breadcrumbs,
  hazard outline, Find, Mark sample, procedure auto-verify, limited mode). Next/Back/Exit, arrow keys. `createTour({ root, worldHighlight })`.
- Must render at 60 fps cheaply: `update(model)` is called every animation frame — diff before touching the DOM.

## mission/ — agent MISSION
- `public/mission/scenario.js`: `class Scenario` — scripted EVA following proposal Table 3 / TSS EV procedure:
  `egress → navigate to LTV → LTV repair (task steps) → navigate to geology POI(s) + mark sample → return → ingress`.
  `constructor({ pois })`, `state` = `{ phaseIndex, phase:{id,title,objective,targetId?}, phases:[...], log:[...], complete }`,
  `update(model)` advances on objective conditions (egress procedure done, within 3 m of target, sample marked, etc.),
  `next()`, `back()`, `reset()`. Also exports `ingressProcedure` JSON (from the TSS EV PDF ingress steps) in `public/procedures/ingress.json`.
- `public/mission/faults.js`: `class FaultInjector` — client-side only, never writes to TSS. `inject(id)`, `clear(id|all)`, `active`,
  `apply(eva, dtSeconds)` → deep-copied eva with overrides. Faults: `o2leak` (oxy_pri_storage drains fast, suit_pressure_oxy drops),
  `fanfail` (fan_pri_rpm→0, error.fan_error), `co2high` (scrubber/helmet CO2 climb), `hrhigh` (heart rate 170+), `battlow` (primary battery → 18%),
  `commsloss` (apply returns `null` → HUD goes stale / limited mode). Each fault clears when the EV flips the correct DCU switch where applicable
  (e.g. fanfail clears when `dcu.fan === false` (SEC)).
- `public/mission/astar.js`: `planRoute(grid, start, goal, { maxSlopeDeg = 15, slopeWeight })` on `world.costGrid()` output,
  8-connected, cost = distance × (1 + slopeWeight·slope²), blocked above maxSlope; returns simplified `[{x,y}]` (TSS frame) or `[]`.
- `public/mission/pois.js`: extra geology POIs (3–4) placed within the scan footprint around the HAB/LTV, `{id,label,kind:'geology',x,y}`.
- Include a tiny Node test `public/mission/selftest.mjs` (run with `node`) that exercises Scenario, FaultInjector, and planRoute on a synthetic grid.

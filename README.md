# WAYMARK

WAYMARK is a HoloLens 2 HUD concept for the NASA SUITS challenge. This repo holds the web prototype of the HUD. It is driven by live data from the NASA SUITS telemetry server (TSS2027).

## Repository layout

| Path | What it is |
|---|---|
| [`waymark-mvp/`](waymark-mvp/) | Web MVP: a Node bridge to TSS plus the browser HUD |
| [`waymark-mvp/README.md`](waymark-mvp/README.md) | How to run it, what's on screen, notes about TSS |
| [`waymark-mvp/CONTRACT.md`](waymark-mvp/CONTRACT.md) | v2 module contract: coordinate frames, the shared model, and the world/HUD/mission APIs |

Inside `waymark-mvp/`:

- `bridge.js` polls TSS over UDP, the same way the headset will. It serves the HUD and streams snapshots to the browser over SSE.
- `public/index.html` + `main.js` is **v2**: a first-person Three.js walk through the JSC rock-yard scan with the HUD overlaid.
- `public/v1.html` is **v1**: the original flat HUD.
- `public/world/` holds the terrain, world-locked features, and the controls.
- `public/hud/` holds the HUD panels, the dev drawer, and the guided tour.
- `public/mission/` holds the scripted EVA scenario, the fault injector, and the A* route planner.
- `public/cw.js`, `range.js`, `procedure.js` hold the caution & warning, range estimate, and procedure logic. These are the reference code to port to C#/Unity.

## Quick start

You need Node 18 or newer and a running TSS2027 server. There are no npm dependencies and no build step.

```bash
# 1. Start TSS in its own terminal and note the IP it prints
cd ~/code/TSS2027 && ./server.exe

# 2. Start the bridge
cd waymark-mvp
TSS_HOST=<ip> node bridge.js        # optional: TEAM=0..9  PORT=8080

# 3. Open the HUD
open http://localhost:8080          # v2; v1 is at /v1.html
```

In the HUD, press **T** for the guided tour. Start the EVA from the dev drawer.

## Tests

```bash
node waymark-mvp/public/mission/selftest.mjs
```

This runs the scenario, fault injection, and route-planner self-tests.

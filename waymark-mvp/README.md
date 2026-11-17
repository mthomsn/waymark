# WAYMARK MVP

**v2 (default, `http://localhost:8080/`)** is a first-person walk through the real JSC rock-yard scan (Three.js) with the WAYMARK HUD overlaid:
- **Walking:** click to walk, WASD to move, Shift to run.
- **World-locked features:** breadcrumbs, the A* route ribbon, POI and sample beacons, and red slope-hazard outlines.
- **Tour and scenario:** press **T** for the 11-step guided tour. The dev drawer runs the scripted EVA (egress → LTV → repair → geology → return → ingress) and injects faults, browser-side only.
- **Pose sync:** your local 60 fps position goes to TSS over its HTTP form (`/pose` on the bridge), so it doesn't slow the UDP telemetry polling.

Module layout and the coordinate frames are in `CONTRACT.md`. v1 (the flat HUD) is still at `/v1.html`. To test the mission logic, run `node public/mission/selftest.mjs`.

A web wireframe of the WAYMARK HoloLens 2 HUD (proposal Technical Section 1–2), driven by live data from the NASA SUITS telemetry server (TSS2027). It has no npm dependencies and only needs Node 18 or newer.

```
TSS2027 server.exe ──UDP :14142+team──▶ bridge.js ──SSE /events──▶ browser HUD (public/)
                   ◀──UDP set cmds / HTTP form──  ◀──POST /cmd────  (dev drawer)
```

The bridge talks to TSS the same way the headset will: UDP, big-endian `[uint32 timestamp][uint32 command][float value]`, polled about once a second. So `bridge.js` + `cw.js` + `procedure.js` + `range.js` are the reference logic to port to C#/Unity.

## Run

```bash
# 1. TSS (it exits when stdin closes, so run it in its own terminal)
cd ~/code/TSS2027 && ./server.exe        # note "Launching Server at IP: <ip>:14141"

# 2. Bridge
cd ~/code/suits/waymark-mvp
TSS_HOST=<ip> node bridge.js             # optional: TEAM=0..9  PORT=8080

# 3. Open http://localhost:8080
```

To start the EVA, use **Start EVA** in the dev drawer under the visor or the TSS web UI at `http://<ip>:14141`.

## What's on screen

| Proposal | MVP |
|---|---|
| Ambient layer: heading strip, range indicator, one alert slot | Compass tape from `imu.heading` with a target arrow, range ring (bottom-left), top-center alert slot (silent when nominal) |
| C&W against NASA ranges, stale marking (§1.5, Fig. 3) | `cw.js`: ranges from `eva-telemetry-ranges.pdf`, caution within 10 % of a limit, warning outside, DCU fix text, `error.*` flags, stale after 4 s |
| Status panel, off-nominal first, "N values nominal" | **Status** |
| Find + 2D map, breadcrumbs, live position (§1.4) | **Find**: breadcrumbs from `imu`, lander = first fix, pins, distance and bearing |
| Range (§1.5 headset fallback) | **Range**: linear O2 / battery burn → minutes to 20 % reserve → out-and-back radius; "RETURN NOW" alert |
| Mark sample (§1.7) | **Mark**: pin plus the XRF `spec` reading (rock name and composition) |
| Procedure FSM, auto-verify UIA/DCU (§2.2, Table 3) | **Procedure**: `procedures/egress.json` (from the TSS EV procedure PDF); switch and "wait until" steps advance from TSS; flags a wrong switch |
| Five voice commands | Text box (`/` to focus) or hotkeys **S F R M P**, N/B/D = next/back/done, Esc = close; **mic** uses browser speech in Chrome |

Suit-atmosphere and biomedical alarms are held until egress completes, so the HUD stays quiet while the suit is still being filled.

Demo shortcut: `http://localhost:8080/#procedure,status` runs those commands when data arrives.

## Notes about TSS

- **Replies take ~1.05 s.** TSS's main loop waits 100 ms on each of its 11 sockets in turn. The bridge uses a 3 s timeout, never overlaps polls, and only reports the link lost after 2 misses. The headset client needs the same handling.
- The README says replies have an 8-byte header, but the current server sends raw JSON. The bridge accepts both.
- Ports: TSS web UI is 14141; team *n* UDP is `14142 + n`. Set commands are 2001–2026 (`src/data.h`). `status.started` has no UDP command, so the bridge sets it through TSS's HTTP form (a 304 reply means success).

## Not in the MVP yet

LLM/Whisper/RAG assistant, A* route planner, spatial-mesh hazard outline, beacons, and the SSU drill panel.

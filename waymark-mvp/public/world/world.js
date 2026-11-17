// WAYMARK v2 — 3D world: rock-yard scan, first-person walk, world-locked WAYMARK features.
// See CONTRACT.md "world/". Everything outside this module speaks TSS frame {x, y, heading};
// scene frame: scene.x = tssX - cx, scene.z = -(tssY - cy), y up.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { loadTerrain, buildApron, sampleGrid } from './terrain.js';

const MINT = 0x7be0b0, TEXT = '#cfe3dc', AMBER = 0xffb020, RED = 0xff4d4d;
const FONT = 'ui-monospace, "SF Mono", Menlo, monospace';
const WALK = 1.4, RUN = 3.0, TURN = 90;          // m/s, m/s, deg/s (arrow keys)
const HAZARD_RADIUS = 10, HAZARD_RADIUS_HL = 25, HAZARD_MS = 200;
const KINDS = ['trail', 'route', 'hazards', 'pois', 'pins', 'target'];

export async function createWorld({ canvas, config, onProgress } = {}) {
  const [cx, cy] = config.centerTss ?? [0, 0];
  const eyeHeight = config.eyeHeight ?? 1.7;
  const hazardSlopeDeg = config.hazardSlopeDeg ?? 12;
  const toScene = (x, y) => [x - cx, -(y - cy)];
  const toTss = (sx, sz) => [sx + cx, -sz + cy];

  // ---- renderer / scene ----------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.Fog(0x000000, 140, 1100);
  const camera = new THREE.PerspectiveCamera(65, 1, 0.05, 4000);
  camera.rotation.order = 'YXZ';

  // low-angle sun (south-pole lighting) + faint earthshine fill
  const sunEl = THREE.MathUtils.degToRad(config.sunElevationDeg ?? 7);
  const sunAz = THREE.MathUtils.degToRad(config.sunAzimuthDeg ?? 105); // TSS heading the sun is in
  const sunDir = new THREE.Vector3(Math.sin(sunAz) * Math.cos(sunEl), Math.sin(sunEl), -Math.cos(sunAz) * Math.cos(sunEl));
  const sun = new THREE.DirectionalLight(0xffffff, 4.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 400 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x8c9bb0, 0x151515, 0.45));

  // stars
  {
    const n = 3500, p = new Float32Array(n * 3), c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
      const y = Math.abs(u) * 0.98 + 0.02; // upper hemisphere only
      p[i * 3] = Math.cos(th) * r * 1500; p[i * 3 + 1] = y * 1500; p[i * 3 + 2] = Math.sin(th) * r * 1500;
      const b = 0.35 + Math.pow(Math.random(), 3) * 0.65; c[i * 3] = b; c[i * 3 + 1] = b; c[i * 3 + 2] = b * (0.9 + Math.random() * 0.2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    var stars = new THREE.Points(g, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false }));
    stars.renderOrder = -1;
    scene.add(stars);
  }

  // ---- terrain ---------------------------------------------------------------
  const { geometry, grid, timings } = await loadTerrain(config, onProgress);
  const ground = new THREE.MeshStandardMaterial({ color: 0x96958f, roughness: 0.93, metalness: 0, vertexColors: true });
  ground.onBeforeCompile = (sh) => { // slight roughness variation from albedo
    sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>',
      '#include <roughnessmap_fragment>\n roughnessFactor = clamp(roughnessFactor + (0.9 - vColor.r) * 0.6, 0.75, 1.0);');
  };
  const terrain = new THREE.Mesh(geometry, ground);
  terrain.castShadow = true; terrain.receiveShadow = true;
  scene.add(terrain, ...buildApron(grid, ground));

  const hScene = (sx, sz) => sampleGrid(grid, grid.h, sx, sz, grid.planeH);
  const heightAt = (x, y) => { const [sx, sz] = toScene(x, y); return hScene(sx, sz); };
  const slopeAt = (x, y) => { const [sx, sz] = toScene(x, y); return sampleGrid(grid, grid.slope, sx, sz, 0); };

  // ---- shared helpers ---------------------------------------------------------
  const resolution = new THREE.Vector2(1, 1);
  const lineMats = [];
  const lineMat = (o) => { const m = new LineMaterial({ worldUnits: false, ...o }); m.resolution.copy(resolution); lineMats.push(m); return m; };
  // highlight registry: kind → [{ m, color, opacity }]
  const hl = Object.fromEntries(KINDS.map((k) => [k, []]));
  const reg = (kind, m) => { hl[kind].push({ m, color: m.color.clone(), opacity: m.opacity }); return m; };
  let highlighted = null;

  // resample a TSS polyline every `step` m and drape it (returns scene Vector3s)
  function drape(points, step, lift) {
    const out = [];
    if (!points || !points.length) return out;
    const sp = points.map((p) => toScene(p.x, p.y));
    const push = (sx, sz) => out.push(new THREE.Vector3(sx, hScene(sx, sz) + lift, sz));
    push(sp[0][0], sp[0][1]);
    for (let i = 1; i < sp.length; i++) {
      const [ax, az] = sp[i - 1], [bx, bz] = sp[i], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / step));
      for (let k = 1; k <= n; k++) push(ax + (bx - ax) * k / n, az + (bz - az) * k / n);
    }
    return out;
  }
  const sig = (arr) => arr ? arr.length + ':' + arr.map((p) => `${p.x?.toFixed?.(2)},${p.y?.toFixed?.(2)},${p.label ?? ''},${p.sample ?? ''},${p.n ?? ''}`).join(';') : 'null';
  const fastSig = (arr) => { // cheap for long, append-only arrays (trail)
    if (!arr || !arr.length) return '0';
    const a = arr[0], b = arr[arr.length - 1], m = arr[arr.length >> 1];
    return `${arr.length}|${a.x},${a.y}|${m.x},${m.y}|${b.x},${b.y}`;
  };

  function labelSprite(kind) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 96;
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false, fog: false });
    const sp = new THREE.Sprite(mat); sp.renderOrder = 10; sp.center.set(0.5, 0);
    sp.scale.set(0.27, 0.0506, 1);
    let last = '';
    sp.userData.draw = (title, sub, color) => {
      const key = title + '|' + sub + '|' + color; if (key === last) return; last = key;
      const g = cv.getContext('2d'); g.clearRect(0, 0, 512, 96);
      g.font = `600 34px ${FONT}`; const w1 = g.measureText(title).width;
      g.font = `500 28px ${FONT}`; const w2 = sub ? g.measureText(sub).width + 22 : 0;
      const w = Math.min(500, w1 + w2 + 36), x = (512 - w) / 2;
      g.fillStyle = 'rgba(5,9,8,0.72)'; g.strokeStyle = color; g.lineWidth = 3;
      g.beginPath(); g.roundRect(x, 18, w, 60, 8); g.fill(); g.stroke();
      g.textBaseline = 'middle'; g.font = `600 34px ${FONT}`; g.fillStyle = color; g.fillText(title, x + 18, 49);
      if (sub) { g.font = `500 28px ${FONT}`; g.fillStyle = TEXT; g.fillText(sub, x + 18 + w1 + 22, 50); }
      tex.needsUpdate = true;
    };
    sp.userData.kind = kind;
    reg(kind, mat);
    return sp;
  }

  // vertical gradient texture for light pillars
  const pillarTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 4; cv.height = 128;
    const g = cv.getContext('2d'), gr = g.createLinearGradient(0, 128, 0, 0);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 4, 128);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const pillarGeo = new THREE.CylinderGeometry(0.09, 0.09, 1, 8, 1, true).translate(0, 0.5, 0);
  const ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);

  function beacon(kind, color, height, ringR) {
    const g = new THREE.Group();
    const pm = reg(kind, new THREE.MeshBasicMaterial({ color, map: pillarTex, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    const pillar = new THREE.Mesh(pillarGeo, pm); pillar.scale.set(1, height, 1);
    const core = new THREE.Mesh(pillarGeo, pm); core.scale.set(1.8, Math.min(2.5, height * 0.1), 1.8); // brighter glow near the base
    const rm = reg(kind, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
    const ring = new THREE.Mesh(ringGeo, rm); ring.scale.setScalar(ringR); ring.position.y = 0.06;
    g.add(pillar, core, ring);
    return g;
  }
  const placeOnGround = (obj, x, y, lift = 0) => { const [sx, sz] = toScene(x, y); obj.position.set(sx, hScene(sx, sz) + lift, sz); };

  // ---- breadcrumbs ---------------------------------------------------------------
  const trailMat = reg('trail', lineMat({ color: MINT, linewidth: 3, dashed: true, dashSize: 0.6, gapSize: 0.45, transparent: true, opacity: 0.95 }));
  let trailLine = null, trailSig = '';
  const dotGeo = new THREE.CircleGeometry(0.12, 12).rotateX(-Math.PI / 2);
  const dotMat = reg('trail', new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  let dots = new THREE.InstancedMesh(dotGeo, dotMat, 1024); dots.count = 0; dots.frustumCulled = false;
  scene.add(dots);
  function setTrail(points) {
    const s = fastSig(points); if (s === trailSig) return; trailSig = s;
    if (trailLine) { scene.remove(trailLine); trailLine.geometry.dispose(); trailLine = null; }
    const pts = drape(points, 0.5, 0.07);
    if (pts.length >= 2) {
      const g = new LineGeometry(); g.setPositions(pts.flatMap((v) => [v.x, v.y, v.z]));
      trailLine = new Line2(g, trailMat); trailLine.computeLineDistances(); trailLine.frustumCulled = false; scene.add(trailLine);
    }
    // a dot every 2 m of walked path
    const drops = []; let acc = 2;
    for (let i = 0; i < pts.length; i++) { if (i) acc += pts[i].distanceTo(pts[i - 1]); if (acc >= 2) { drops.push(pts[i]); acc = 0; } }
    if (drops.length > dots.instanceMatrix.count) { scene.remove(dots); dots.dispose(); dots = new THREE.InstancedMesh(dotGeo, dotMat, drops.length * 2); dots.frustumCulled = false; scene.add(dots); }
    const mm = new THREE.Matrix4();
    drops.forEach((v, i) => dots.setMatrixAt(i, mm.makeTranslation(v.x, v.y - 0.03, v.z)));
    dots.count = drops.length; dots.instanceMatrix.needsUpdate = true;
  }

  // ---- route ribbon --------------------------------------------------------------
  const chevTex = (() => {
    const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
    const g = cv.getContext('2d'); g.fillStyle = 'rgba(255,255,255,0.38)'; g.fillRect(0, 0, 128, 64);
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(30, 6); g.lineTo(78, 32); g.lineTo(30, 58); g.lineTo(52, 32); g.closePath(); g.fill();
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
  })();
  const routeMat = reg('route', new THREE.MeshBasicMaterial({ color: AMBER, map: chevTex, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4 }));
  let route = null, routeSig = '';
  function setRoute(points) {
    const s = sig(points); if (s === routeSig) return; routeSig = s;
    if (route) { scene.remove(route); route.geometry.dispose(); route = null; }
    const pts = drape(points, 0.5, 0.14);
    if (pts.length < 2) return;
    const W = 0.32, pos = [], uv = [], idx = []; let L = 0;
    const side = new THREE.Vector3(), dir = new THREE.Vector3();
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      dir.subVectors(b, a); dir.y = 0; dir.normalize(); side.set(-dir.z, 0, dir.x).multiplyScalar(W);
      if (i) L += pts[i].distanceTo(pts[i - 1]);
      const p = pts[i];
      pos.push(p.x + side.x, hScene(p.x + side.x, p.z + side.z) + 0.14, p.z + side.z, p.x - side.x, hScene(p.x - side.x, p.z - side.z) + 0.14, p.z - side.z);
      uv.push(L / 1.1, 0, L / 1.1, 1);
      if (i) { const k = i * 2; idx.push(k - 2, k - 1, k, k - 1, k + 1, k); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
    route = new THREE.Mesh(g, routeMat); route.renderOrder = 2; scene.add(route);
  }

  // ---- POIs ----------------------------------------------------------------------
  const poiGroup = new THREE.Group(); scene.add(poiGroup);
  let poiItems = [], poiSig = '';
  function clearGroup(g, kind) {
    for (const c of [...g.children]) { g.remove(c); c.traverse((o) => { if (o.material) { if (o.isSprite) o.material.map.dispose(); o.material.dispose(); } }); }
    // drop sprite materials from highlight registry (beacon materials are recreated too)
    hl[kind] = [];
  }
  function setPois(pois) {
    const s = sig(pois); if (s === poiSig) return; poiSig = s;
    clearGroup(poiGroup, 'pois'); poiItems = [];
    for (const p of pois || []) {
      const b = beacon('pois', MINT, 40, 1.4); placeOnGround(b, p.x, p.y);
      const label = labelSprite('pois'); label.position.y = 3.2; b.add(label);
      poiGroup.add(b); poiItems.push({ p, label, color: '#7be0b0' });
    }
    refreshLabels(true);
  }

  // ---- pins / samples ------------------------------------------------------------
  const pinGroup = new THREE.Group(); scene.add(pinGroup);
  let pinItems = [], pinSig = '';
  const gemGeo = new THREE.OctahedronGeometry(0.22, 0);
  function setPins(pins) {
    const s = sig(pins); if (s === pinSig) return; pinSig = s;
    clearGroup(pinGroup, 'pins'); pinItems = [];
    for (const p of pins || []) {
      const color = p.sample ? 0xffd27a : 0xcfe3dc;
      const b = beacon('pins', color, 6, 0.55); placeOnGround(b, p.x, p.y);
      const gm = reg('pins', new THREE.MeshBasicMaterial({ color }));
      const gem = new THREE.Mesh(gemGeo, gm); gem.position.y = 2.1; gem.scale.y = 1.6; b.add(gem); b.userData.gem = gem;
      const label = labelSprite('pins'); label.position.y = 2.6; label.scale.multiplyScalar(0.8); b.add(label);
      pinGroup.add(b);
      const name = (p.sample ? 'S' : 'P') + (p.n ?? pinItems.length + 1) + (p.rock ? ' ' + p.rock : '');
      pinItems.push({ p, label, name, color: p.sample ? '#ffd27a' : TEXT });
    }
    refreshLabels(true);
  }

  // ---- target ring ---------------------------------------------------------------
  const targetGroup = new THREE.Group(); targetGroup.visible = false; scene.add(targetGroup);
  const targetRings = [0, 1, 2].map(() => {
    const m = reg('target', new THREE.MeshBasicMaterial({ color: MINT, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 }));
    const r = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2), m); r.position.y = 0.08; targetGroup.add(r); return r;
  });
  const targetCore = new THREE.Mesh(new THREE.RingGeometry(0.0, 0.25, 32).rotateX(-Math.PI / 2), reg('target', new THREE.MeshBasicMaterial({ color: MINT, transparent: true, opacity: 0.9, depthWrite: false })));
  targetCore.position.y = 0.08; targetGroup.add(targetCore);
  let target = null, targetSig = '';
  function setTarget(t) {
    const s = t ? `${t.x},${t.y},${t.label}` : 'null'; if (s === targetSig) return; targetSig = s;
    target = t || null; targetGroup.visible = !!t;
    if (t) placeOnGround(targetGroup, t.x, t.y);
  }

  // ---- hazard outline ------------------------------------------------------------
  // 1 m hazard cells (max slope of 2x2 grid cells, scan footprint only); boundary edges precomputed.
  const hazardEdges = (() => {
    const s = 2, hc = Math.floor((grid.cols - 1) / s), hr = Math.floor((grid.rows - 1) / s);
    const haz = new Uint8Array(hc * hr);
    for (let r = 0; r < hr; r++) for (let c = 0; c < hc; c++) {
      let m = 0, cov = 0;
      for (let dj = 0; dj < s; dj++) for (let di = 0; di < s; di++) { const k = (r * s + dj) * grid.cols + c * s + di; m += grid.slope[k]; cov += grid.covered[k]; }
      haz[r * hc + c] = cov === s * s && m / (s * s) > hazardSlopeDeg ? 1 : 0;
    }
    const step = s * grid.cell, out = [];
    const X = (c) => grid.x0 + c * step, Z = (r) => grid.z0 + r * step;
    const seg = (ax, az, bx, bz) => { // split into 2 for better draping
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const ya = hScene(ax, az) + 0.09, ym = hScene(mx, mz) + 0.09, yb = hScene(bx, bz) + 0.09;
      out.push(ax, ya, az, mx, ym, mz, mx, ym, mz, bx, yb, bz);
    };
    const H = (c, r) => (c >= 0 && r >= 0 && c < hc && r < hr ? haz[r * hc + c] : 0);
    for (let r = 0; r < hr; r++) for (let c = 0; c < hc; c++) {
      if (!H(c, r)) continue;
      if (!H(c - 1, r)) seg(X(c), Z(r), X(c), Z(r + 1));
      if (!H(c + 1, r)) seg(X(c + 1), Z(r), X(c + 1), Z(r + 1));
      if (!H(c, r - 1)) seg(X(c), Z(r), X(c + 1), Z(r));
      if (!H(c, r + 1)) seg(X(c), Z(r + 1), X(c + 1), Z(r + 1));
    }
    return new Float32Array(out); // 2 segments (12 floats) per cell edge
  })();
  const hazardMat = reg('hazards', lineMat({ color: RED, linewidth: 2.5, transparent: true, opacity: 0.95 }));
  let hazardLines = null, hazardT = -1e9, hazardKey = '';
  function updateHazards(now, force) {
    if (!force && now - hazardT < HAZARD_MS) return; hazardT = now;
    const R = highlighted === 'hazards' ? HAZARD_RADIUS_HL : HAZARD_RADIUS, R2 = R * R;
    const px = camera.position.x, pz = camera.position.z;
    const key = `${Math.round(px * 4)},${Math.round(pz * 4)},${R}`; if (key === hazardKey && !force) return; hazardKey = key;
    const sel = [];
    for (let i = 0; i < hazardEdges.length; i += 6) {
      const dx = hazardEdges[i] - px, dz = hazardEdges[i + 2] - pz;
      if (dx * dx + dz * dz < R2) for (let k = 0; k < 6; k++) sel.push(hazardEdges[i + k]);
    }
    if (hazardLines) { scene.remove(hazardLines); hazardLines.geometry.dispose(); hazardLines = null; }
    if (!sel.length) return;
    const g = new LineSegmentsGeometry(); g.setPositions(sel);
    hazardLines = new LineSegments2(g, hazardMat); hazardLines.frustumCulled = false; hazardLines.renderOrder = 3; scene.add(hazardLines);
  }

  // ---- labels (distance text, refreshed ~2 Hz) ------------------------------------
  let labelT = 0;
  function refreshLabels(force) {
    const [px, py] = [pose.x, pose.y];
    for (const it of poiItems) it.label.userData.draw(it.p.label ?? it.p.id, `${Math.round(Math.hypot(it.p.x - px, it.p.y - py))} m`, it.color);
    for (const it of pinItems) it.label.userData.draw(it.name, `${Math.round(Math.hypot(it.p.x - px, it.p.y - py))} m`, it.color);
  }

  // ---- pose / controls -----------------------------------------------------------
  const hab = (config.pois || []).find((p) => p.id === 'hab') || (config.pois || [])[0] || { x: cx, y: cy };
  const ltv = (config.pois || []).find((p) => p.id === 'ltv-a');
  const pose = { x: hab.x, y: hab.y, heading: ltv ? (Math.atan2(ltv.x - hab.x, ltv.y - hab.y) * 180 / Math.PI + 360) % 360 : 0 };
  let pitch = -0.08, camY = heightAt(pose.x, pose.y) + eyeHeight;
  const poseCbs = new Set();
  let lastEmitted = '';
  const keys = new Set();
  let controlsEnabled = true;

  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };
  const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
  const onKeyDown = (e) => { if (!controlsEnabled || typing() || e.metaKey || e.ctrlKey || e.altKey) return; if (MOVE_KEYS.has(e.code)) keys.add(e.code); };
  const onKeyUp = (e) => keys.delete(e.code);
  const onBlur = () => keys.clear();
  const onFocusIn = () => { if (typing()) keys.clear(); };
  const onClick = () => { if (controlsEnabled && document.pointerLockElement !== canvas) canvas.requestPointerLock?.()?.catch?.(() => {}); };
  const onMouseMove = (e) => {
    if (document.pointerLockElement !== canvas || !controlsEnabled) return;
    pose.heading = (pose.heading + e.movementX * 0.12 + 360) % 360;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * 0.0021, -1.35, 1.2);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  document.addEventListener('focusin', onFocusIn);
  canvas.addEventListener('click', onClick);
  document.addEventListener('mousemove', onMouseMove);

  function step(dt) {
    if (controlsEnabled && keys.size) {
      const k = (c) => keys.has(c);
      if (k('ArrowLeft')) pose.heading = (pose.heading - TURN * dt + 360) % 360;
      if (k('ArrowRight')) pose.heading = (pose.heading + TURN * dt) % 360;
      const fwd = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
      const str = (k('KeyD') ? 1 : 0) - (k('KeyA') ? 1 : 0);
      if (fwd || str) {
        const sp = (k('ShiftLeft') || k('ShiftRight') ? RUN : WALK) * dt / Math.hypot(fwd, str);
        const h = pose.heading * Math.PI / 180;
        pose.x += (Math.sin(h) * fwd + Math.cos(h) * str) * sp;
        pose.y += (Math.cos(h) * fwd - Math.sin(h) * str) * sp;
      }
    }
    const [sx, sz] = toScene(pose.x, pose.y);
    const ty = hScene(sx, sz) + eyeHeight;
    camY += (ty - camY) * Math.min(1, dt * 12);
    camera.position.set(sx, camY, sz);
    camera.rotation.set(pitch, -pose.heading * Math.PI / 180, 0);
  }
  function emitPose() {
    const s = `${pose.x.toFixed(3)},${pose.y.toFixed(3)},${pose.heading.toFixed(2)}`;
    if (s === lastEmitted) return; lastEmitted = s;
    const p = { x: pose.x, y: pose.y, heading: pose.heading };
    for (const cb of poseCbs) { try { cb(p); } catch (e) { console.error(e); } }
  }

  // ---- resize --------------------------------------------------------------------
  function resize() {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    resolution.set(w, h);
    for (const m of lineMats) m.resolution.set(w, h);
  }
  if (!canvas.style.width) Object.assign(canvas.style, { width: '100vw', height: '100vh', display: 'block' });
  window.addEventListener('resize', resize);
  resize();

  // ---- loop ----------------------------------------------------------------------
  let raf = 0, last = performance.now(), disposed = false;
  const tmp = new THREE.Color();
  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const t = now / 1000;
    step(dt);
    emitPose();

    // sun + shadow frustum follow the EV (texel-snapped to avoid shimmer)
    const texel = 80 / 2048;
    const fx = Math.round(camera.position.x / texel) * texel, fz = Math.round(camera.position.z / texel) * texel;
    sun.target.position.set(fx, grid.planeH, fz);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 150);
    stars.position.copy(camera.position);

    updateHazards(now, false);
    if (now - labelT > 500) { labelT = now; refreshLabels(); }

    // animations
    chevTex.offset.x = -(t * 0.9) % 1;
    if (targetGroup.visible) targetRings.forEach((r, i) => {
      const ph = (t * 0.6 + i / 3) % 1; r.scale.setScalar(0.4 + ph * 2.4); r.material.opacity = (1 - ph) * 0.9;
    });
    for (const b of pinGroup.children) if (b.userData.gem) b.userData.gem.rotation.y = t * 1.2;
    // hide light pillars when standing inside them (additive, double-sided → would wash out the view)
    for (const g of [poiGroup, pinGroup]) for (const b of g.children) {
      const near = Math.hypot(b.position.x - camera.position.x, b.position.z - camera.position.z) < 1.2;
      b.children[0].visible = b.children[1].visible = !near;
    }

    // highlight: pulse brightness/opacity of one feature class
    const pulse = 0.5 + 0.5 * Math.sin(t * 6);
    for (const kind of KINDS) for (const e of hl[kind]) {
      const on = kind === highlighted;
      if (on) {
        tmp.copy(e.color).multiplyScalar(1 + 0.9 * pulse); e.m.color.copy(tmp);
        if (!(kind === 'target' && targetRings.some((r) => r.material === e.m))) e.m.opacity = Math.min(1, e.opacity * (0.75 + 0.5 * pulse) + 0.1);
        if (e.m.isLineMaterial) e.m.linewidth = (kind === 'hazards' ? 2.5 : 3) * (1.3 + 0.9 * pulse);
      } else if (e.dirty !== false) {
        e.m.color.copy(e.color);
        if (!(kind === 'target' && targetRings.some((r) => r.material === e.m))) e.m.opacity = e.opacity;
        if (e.m.isLineMaterial) e.m.linewidth = kind === 'hazards' ? 2.5 : 3;
      }
      e.dirty = on;
    }
    if (highlighted === 'pois' || highlighted === 'pins') {
      const s = 1 + 0.25 * pulse;
      for (const b of (highlighted === 'pois' ? poiGroup : pinGroup).children) b.children[2].scale.setScalar((highlighted === 'pois' ? 1.4 : 0.55) * s);
    }

    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  // ---- api -----------------------------------------------------------------------
  setPois(config.pois || []);
  step(0); updateHazards(performance.now(), true);

  const api = {
    get pose() { return { x: pose.x, y: pose.y, heading: pose.heading }; },
    onPose(cb) { poseCbs.add(cb); return () => poseCbs.delete(cb); },
    setPose(p) {
      if (!p) return;
      if (Number.isFinite(p.x)) pose.x = p.x;
      if (Number.isFinite(p.y)) pose.y = p.y;
      if (Number.isFinite(p.heading)) pose.heading = ((p.heading % 360) + 360) % 360;
      if (Number.isFinite(p.pitch)) pitch = p.pitch; // extra: radians, for demos/screenshots
      camY = heightAt(pose.x, pose.y) + eyeHeight;
      step(0); updateHazards(performance.now(), true); refreshLabels();
    },
    heightAt,
    slopeAt,
    costGrid({ cell = 1 } = {}) {
      // covers the whole height grid (scan + apron). Cell (c, r) centre:
      // x = originX + (c + 0.5)·cell, y = originY + (r + 0.5)·cell; index r·cols + c; rows go +y (north).
      const [ax, ay] = toTss(grid.x0, grid.z0 + (grid.rows - 1) * grid.cell); // min x, min y corner
      const W = (grid.cols - 1) * grid.cell, H = (grid.rows - 1) * grid.cell;
      const cols = Math.floor(W / cell), rows = Math.floor(H / cell);
      const slopeDeg = new Float32Array(cols * rows), height = new Float32Array(cols * rows), known = new Uint8Array(cols * rows);
      const sub = Math.max(1, Math.round(cell / grid.cell));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = ax + (c + 0.5) * cell, y = ay + (r + 0.5) * cell, [sx, sz] = toScene(x, y);
        // worst slope inside the cell (conservative for A*)
        let m = 0;
        for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
          const s = sampleGrid(grid, grid.slope, sx + ((a + 0.5) / sub - 0.5) * cell, sz + ((b + 0.5) / sub - 0.5) * cell, 0);
          if (s > m) m = s;
        }
        const k = r * cols + c;
        slopeDeg[k] = m; height[k] = hScene(sx, sz);
        known[k] = sampleGrid(grid, grid.covered, sx, sz, 0) > 0.5 ? 1 : 0;
      }
      return { originX: ax, originY: ay, cell, cols, rows, slopeDeg, height, known };
    },
    setTrail, setRoute, setPois, setPins, setTarget,
    highlight(kind) { highlighted = KINDS.includes(kind) ? kind : null; updateHazards(performance.now(), true); },
    setControlsEnabled(on) {
      controlsEnabled = !!on;
      if (!on) { keys.clear(); if (document.pointerLockElement === canvas) document.exitPointerLock(); }
    },
    get locked() { return document.pointerLockElement === canvas; },
    // extras (read-only use): for integrator debugging
    scene, camera, renderer, timings, hazardSlopeDeg,
    dispose() {
      disposed = true; cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur); window.removeEventListener('resize', resize);
      document.removeEventListener('focusin', onFocusIn); document.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('click', onClick);
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      scene.traverse((o) => { o.geometry?.dispose?.(); const m = o.material; (Array.isArray(m) ? m : m ? [m] : []).forEach((x) => { x.map?.dispose(); x.dispose(); }); });
      renderer.dispose();
      poseCbs.clear();
    },
  };
  return api;
}

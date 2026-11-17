// WAYMARK world — terrain loading + height grid (scene frame, y-up).
// The scan is placed with scale / verticalScale / rotationDeg; scene origin = centerTss.
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export const CELL = 0.5;          // height grid resolution (m)
const MARGIN = 20;                // apron margin around the scan bbox (m)
const BLEND = 15;                 // distance over which the apron blends to the far plane (m)

// cheap deterministic value noise for subtle albedo variation
function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function albedo(x, z) {
  return 0.86 + 0.10 * vnoise(x * 0.35, z * 0.35) + 0.06 * vnoise(x * 2.1, z * 2.1) - 0.05;
}

export async function loadTerrain(config, onProgress) {
  const url = new URL('../' + config.terrainUrl, import.meta.url).href;
  const t0 = performance.now();
  const group = await new OBJLoader().loadAsync(url, (e) => onProgress && e.total && onProgress(e.loaded / e.total));
  const tLoad = performance.now() - t0;

  const s = config.scale ?? 1, vs = config.verticalScale ?? 1;
  const rot = THREE.MathUtils.degToRad(config.rotationDeg ?? 0);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), new THREE.Vector3(s, vs, s));
  const nm = new THREE.Matrix3().getNormalMatrix(m);

  // merge all meshes, bake transform (so raycasts / normals are in scene frame)
  const geoms = [];
  group.traverse((o) => { if (o.isMesh) geoms.push(o.geometry); });
  let total = 0; for (const g of geoms) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
  let off = 0;
  const v = new THREE.Vector3();
  for (const g of geoms) {
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++, off++) {
      v.fromBufferAttribute(p, i).applyMatrix4(m); pos[off * 3] = v.x; pos[off * 3 + 1] = v.y; pos[off * 3 + 2] = v.z;
      if (n) { v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); nor[off * 3] = v.x; nor[off * 3 + 1] = v.y; nor[off * 3 + 2] = v.z; }
      const a = albedo(pos[off * 3], pos[off * 3 + 2]);
      col[off * 3] = a; col[off * 3 + 1] = a * 0.985; col[off * 3 + 2] = a * 0.965;
    }
    g.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (geoms[0]?.attributes.normal) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); else geo.computeVertexNormals();
  geo.computeBoundingBox(); geo.computeBoundingSphere();

  const t1 = performance.now();
  const grid = buildGrid(pos, geo.boundingBox);
  const tGrid = performance.now() - t1;
  return { geometry: geo, grid, timings: { loadParseMs: Math.round(tLoad), gridMs: Math.round(tGrid), triangles: total / 3 } };
}

// Rasterize triangles (max height at cell centres), fill gaps, blend outward to a flat plane.
function buildGrid(pos, bb) {
  const x0 = Math.floor(bb.min.x - MARGIN), z0 = Math.floor(bb.min.z - MARGIN);
  const cols = Math.ceil((bb.max.x + MARGIN - x0) / CELL) + 1;
  const rows = Math.ceil((bb.max.z + MARGIN - z0) / CELL) + 1;
  const N = cols * rows;
  const h = new Float32Array(N).fill(-Infinity);
  const triCount = pos.length / 9;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    const ax = (pos[o] - x0) / CELL, ay = pos[o + 1], az = (pos[o + 2] - z0) / CELL;
    const bx = (pos[o + 3] - x0) / CELL, by = pos[o + 4], bz = (pos[o + 5] - z0) / CELL;
    const cx = (pos[o + 6] - x0) / CELL, cy = pos[o + 7], cz = (pos[o + 8] - z0) / CELL;
    // vertex splats (catch sub-cell triangles)
    splat(Math.round(ax), Math.round(az), ay); splat(Math.round(bx), Math.round(bz), by); splat(Math.round(cx), Math.round(cz), cy);
    const minI = Math.ceil(Math.min(ax, bx, cx)), maxI = Math.floor(Math.max(ax, bx, cx));
    const minJ = Math.ceil(Math.min(az, bz, cz)), maxJ = Math.floor(Math.max(az, bz, cz));
    if (minI > maxI || minJ > maxJ) continue;
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-12) continue;
    for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) {
      const w1 = ((bz - cz) * (i - cx) + (cx - bx) * (j - cz)) / d;
      const w2 = ((cz - az) * (i - cx) + (ax - cx) * (j - cz)) / d;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
      splat(i, j, w1 * ay + w2 * by + w3 * cy);
    }
  }
  function splat(i, j, y) { const k = j * cols + i; if (y > h[k]) h[k] = y; }

  const covered = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (h[k] > -Infinity) covered[k] = 1;
  // close 1-cell pinholes inside the scan (cells with ≥5 covered neighbours) — keeps the coverage mask solid
  const fillHole = [];
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    const k = j * cols + i; if (covered[k]) continue;
    let n = 0, s = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const q = k + dj * cols + di; if (covered[q]) { n++; s += h[q]; } }
    if (n >= 5) fillHole.push(k, s / n);
  }
  for (let q = 0; q < fillHole.length; q += 2) { h[fillHole[q]] = fillHole[q + 1]; covered[fillHole[q]] = 1; }

  // edge height = median of covered cells bordering uncovered ones
  const edge = [];
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    const k = j * cols + i;
    if (covered[k] && (!covered[k - 1] || !covered[k + 1] || !covered[k - cols] || !covered[k + cols])) edge.push(h[k]);
  }
  edge.sort((a, b) => a - b);
  const planeH = edge.length ? edge[edge.length >> 1] : 0;

  // multi-source BFS: nearest covered height + distance, for uncovered cells
  const dist = new Float32Array(N).fill(Infinity);
  const queue = new Int32Array(N); let qh = 0, qt = 0;
  for (let k = 0; k < N; k++) if (covered[k]) { dist[k] = 0; queue[qt++] = k; }
  while (qh < qt) {
    const k = queue[qh++], i = k % cols, j = (k / cols) | 0;
    const nb = [i > 0 ? k - 1 : -1, i < cols - 1 ? k + 1 : -1, j > 0 ? k - cols : -1, j < rows - 1 ? k + cols : -1];
    for (const q of nb) if (q >= 0 && dist[q] === Infinity) { dist[q] = dist[k] + CELL; h[q] = h[k]; queue[qt++] = q; }
  }
  for (let k = 0; k < N; k++) {
    if (covered[k]) continue;
    if (dist[k] === Infinity) { h[k] = planeH; continue; }
    const t = Math.min(1, dist[k] / BLEND), sm = t * t * (3 - 2 * t);
    h[k] = h[k] + (planeH - h[k]) * sm;
  }

  // slope (deg) on a lightly smoothed surface, central differences (1 m baseline)
  const hs = new Float32Array(N);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    let s = 0, n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) continue; s += h[jj * cols + ii]; n++;
    }
    hs[j * cols + i] = s / n;
  }
  const slope = new Float32Array(N);
  for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
    const k = j * cols + i;
    const gx = (hs[k + 1] - hs[k - 1]) / (2 * CELL), gz = (hs[k + cols] - hs[k - cols]) / (2 * CELL);
    slope[k] = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  }
  return { x0, z0, cols, rows, cell: CELL, h, slope, covered, planeH };
}

// bilinear sample of a grid field at scene (x, z); outside → fallback
export function sampleGrid(grid, field, x, z, fallback) {
  const fx = (x - grid.x0) / grid.cell, fz = (z - grid.z0) / grid.cell;
  if (!(fx >= 0 && fz >= 0 && fx < grid.cols - 1 && fz < grid.rows - 1)) return fallback;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, c = grid.cols, k = j * c + i;
  const a = field[k], b = field[k + 1], d = field[k + c], e = field[k + c + 1];
  return (a * (1 - u) + b * u) * (1 - v) + (d * (1 - u) + e * u) * v;
}

// apron mesh (hidden under the scan, blends to the far plane) + far plane with a hole
export function buildApron(grid, material) {
  const step = 2; // 1 m
  const cw = Math.floor((grid.cols - 1) / step) + 1, rw = Math.floor((grid.rows - 1) / step) + 1;
  const pos = new Float32Array(cw * rw * 3), col = new Float32Array(cw * rw * 3);
  for (let r = 0; r < rw; r++) for (let c = 0; c < cw; c++) {
    const i = c * step, j = r * step, k = j * grid.cols + i, o = (r * cw + c) * 3;
    let near = false;
    for (let dj = -2; dj <= 2 && !near; dj++) for (let di = -2; di <= 2; di++) {
      const ii = i + di, jj = j + dj; if (ii >= 0 && jj >= 0 && ii < grid.cols && jj < grid.rows && grid.covered[jj * grid.cols + ii]) { near = true; break; }
    }
    const x = grid.x0 + i * grid.cell, z = grid.z0 + j * grid.cell;
    pos[o] = x; pos[o + 1] = grid.h[k] - (near ? 0.35 : 0.03); pos[o + 2] = z;
    const a = albedo(x, z); col[o] = a; col[o + 1] = a * 0.985; col[o + 2] = a * 0.965;
  }
  const idx = [];
  for (let r = 0; r < rw - 1; r++) for (let c = 0; c < cw - 1; c++) {
    const a = r * cw + c, b = a + 1, d = a + cw, e = d + 1;
    idx.push(a, d, b, b, d, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const apron = new THREE.Mesh(g, material);
  apron.receiveShadow = true;

  const R = 3000, x1 = grid.x0, z1 = grid.z0, x2 = grid.x0 + (cw - 1) * step * grid.cell, z2 = grid.z0 + (rw - 1) * step * grid.cell;
  const shape = new THREE.Shape([new THREE.Vector2(-R, -R), new THREE.Vector2(R, -R), new THREE.Vector2(R, R), new THREE.Vector2(-R, R)]);
  // shape is in (x, -z) after rotating -90° about X
  shape.holes.push(new THREE.Path([new THREE.Vector2(x1, -z1), new THREE.Vector2(x1, -z2), new THREE.Vector2(x2, -z2), new THREE.Vector2(x2, -z1)]));
  const pg = new THREE.ShapeGeometry(shape);
  pg.rotateX(-Math.PI / 2);
  const pp = pg.attributes.position, pc = new Float32Array(pp.count * 3);
  for (let i = 0; i < pp.count; i++) { pp.setY(i, grid.planeH - 0.03); pc[i * 3] = pc[i * 3 + 1] = pc[i * 3 + 2] = 0.86; }
  pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
  pg.computeVertexNormals();
  const plane = new THREE.Mesh(pg, material);
  plane.receiveShadow = true;
  return [apron, plane];
}

// Slope-aware A* route planner over world.costGrid() output (TSS frame).
// 8-connected, octile heuristic, cost = step length × (1 + slopeWeight·slope²) using the
// destination cell's slope (start/goal cells cost ×1); cells steeper than maxSlopeDeg are blocked (start/goal exempt);
// diagonal moves may not cut the corner of a blocked cell. The cell path is then string-pulled
// with grid line-of-sight (cost-checked) so the route is a few straight legs. Typed arrays + binary heap keep
// it well under 30 ms on 220×225.

const SQRT2 = Math.SQRT2;
const SHORTCUT_TOL = 1.02;   // accept a straight shortcut up to 2 % costlier than the A* cells it replaces
// Neighbour offsets: 4 orthogonal first, then 4 diagonal.
const DC = [1, -1, 0, 0, 1, 1, -1, -1];
const DR = [0, 0, 1, -1, 1, -1, 1, -1];

/** Min-heap of cell indices keyed by f (Float64Array lookup). */
class Heap {
  constructor(cap, f) { this.a = new Int32Array(cap); this.n = 0; this.f = f; }
  push(i) {
    const a = this.a, f = this.f;
    let k = this.n++;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (f[a[p]] <= f[i]) break;
      a[k] = a[p]; k = p;
    }
    a[k] = i;
  }
  pop() {
    const a = this.a, f = this.f, top = a[0], last = a[--this.n];
    let k = 0;
    for (;;) {
      let c = 2 * k + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && f[a[c + 1]] < f[a[c]]) c++;
      if (f[a[c]] >= f[last]) break;
      a[k] = a[c]; k = c;
    }
    if (this.n > 0) a[k] = last;
    return top;
  }
}

export function planRoute(grid, start, goal, { maxSlopeDeg = 15, slopeWeight = 0.02 } = {}) {
  const { originX, originY, cell, cols, rows, slopeDeg } = grid;
  const N = cols * rows;
  const toCell = (p) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((p.x - originX) / cell)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((p.y - originY) / cell)));
    return r * cols + c;
  };
  const s = toCell(start), g = toCell(goal);
  if (s === g) return [{ x: start.x, y: start.y }, { x: goal.x, y: goal.y }];

  const blocked = (i) => i !== s && i !== g && !(slopeDeg[i] <= maxSlopeDeg); // NaN counts as blocked
  // Slope cost multiplier; start/goal cells are exempt (the EV is already there / must get there).
  const mult = (i) => {
    if (i === s || i === g) return 1;
    const sl = slopeDeg[i];
    return 1 + slopeWeight * sl * sl;
  };
  const gc = g % cols, gr = (g / cols) | 0;
  const h = (i) => {
    const dx = Math.abs((i % cols) - gc), dy = Math.abs(((i / cols) | 0) - gr);
    return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * cell;
  };

  const gScore = new Float64Array(N).fill(Infinity);
  const f = new Float64Array(N);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new Heap(N * 4, f);   // lazy deletion: a cell may be pushed several times
  gScore[s] = 0; f[s] = h(s); open.push(s);

  let found = false;
  while (open.n) {
    const cur = open.pop();
    if (closed[cur]) continue;
    if (cur === g) { found = true; break; }
    closed[cur] = 1;
    const cc = cur % cols, cr = (cur / cols) | 0;
    for (let k = 0; k < 8; k++) {
      const nc = cc + DC[k], nr = cr + DR[k];
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = nr * cols + nc;
      if (closed[ni] || blocked(ni)) continue;
      // No corner cutting: both orthogonal cells of a diagonal step must be open.
      if (k >= 4 && (blocked(cr * cols + nc) || blocked(nr * cols + cc))) continue;
      const step = (k >= 4 ? SQRT2 : 1) * cell * mult(ni);
      const ng = gScore[cur] + step;
      if (ng < gScore[ni]) {
        gScore[ni] = ng; came[ni] = cur; f[ni] = ng + h(ni);
        // Heap stores indices keyed by f[]; re-pushing after f changes is the lazy-decrease-key.
        open.push(ni);
      }
    }
  }
  if (!found) return [];

  const cells = [];
  for (let i = g; i !== -1; i = came[i]) cells.push(i);
  cells.reverse();
  const centre = (i) => ({ x: originX + ((i % cols) + 0.5) * cell, y: originY + (((i / cols) | 0) + 0.5) * cell });

  // String pulling: extend each straight leg while it has line of sight AND costs no more (±2 %) than
  // the A* path it replaces (so a shortcut never drags the route back over steep ground).
  const pts = [{ x: start.x, y: start.y }];
  let a = 0;
  while (a < cells.length - 1) {
    let b = a + 1;
    while (b + 1 < cells.length && legCost(cells[a], cells[b + 1]) <= (gScore[cells[b + 1]] - gScore[cells[a]]) * SHORTCUT_TOL + 1e-9) b++;
    if (b < cells.length - 1) pts.push(centre(cells[b]));
    a = b;
  }
  pts.push({ x: goal.x, y: goal.y });
  return pts;

  /**
   * Cost of a straight leg between two cell centres: length × mean slope multiplier of the cells
   * it crosses (supercover walk). Infinity if it touches a blocked cell or cuts a blocked corner.
   */
  function legCost(i0, i1) {
    let c = i0 % cols, r = (i0 / cols) | 0;
    const c1 = i1 % cols, r1 = (i1 / cols) | 0;
    const nx = Math.abs(c1 - c), ny = Math.abs(r1 - r);
    const sx = c1 > c ? 1 : -1, sy = r1 > r ? 1 : -1;
    let sum = 0, n = 0;
    for (let ix = 0, iy = 0; ix < nx || iy < ny;) {
      const d = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx; // next x- vs y-boundary crossing
      if (d === 0) {
        // Passes exactly through a corner: both side cells must be open.
        if (blocked(r * cols + c + sx) || blocked((r + sy) * cols + c)) return Infinity;
        c += sx; r += sy; ix++; iy++;
      } else if (d < 0) { c += sx; ix++; }
      else { r += sy; iy++; }
      const i = r * cols + c;
      if (blocked(i)) return Infinity;
      sum += mult(i); n++;
    }
    return Math.hypot(nx, ny) * cell * (n ? sum / n : 1);
  }
}

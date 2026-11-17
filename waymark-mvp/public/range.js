// Conservative headset range estimate (proposal §1.5 fallback when the laptop model is unavailable).
// Fits a straight line to recent O2 and battery levels vs EVA elapsed time and predicts minutes
// until the 20 % reserve floor; range = time × walking speed ÷ 2 (out and back).

const WINDOW_S = 300;        // last 5 min of samples
const RESERVE_PCT = 20;      // nominal-range floor
const WALK_M_PER_MIN = 40;   // conservative lunar walking pace (~0.67 m/s)

export class RangeModel {
  constructor() { this.samples = []; }

  add(eva) {
    const t = eva?.telemetry;
    if (!t || !eva?.status?.started) return;
    const s = t.eva_elapsed_time;
    if (this.samples.length && s <= this.samples.at(-1).s) {
      if (s < this.samples.at(-1).s) this.samples = []; // EVA restarted
      return;
    }
    this.samples.push({ s, oxy: t.oxy_pri_storage + t.oxy_sec_storage, batt: t.primary_battery_level });
    while (this.samples.length && s - this.samples[0].s > WINDOW_S) this.samples.shift();
  }

  static slope(pts, k) {
    const n = pts.length;
    if (n < 5) return null;
    const mx = pts.reduce((a, p) => a + p.s, 0) / n;
    const my = pts.reduce((a, p) => a + p[k], 0) / n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.s - mx) * (p[k] - my); den += (p.s - mx) ** 2; }
    return den ? num / den : null; // % per second
  }

  estimate() {
    const last = this.samples.at(-1);
    if (!last) return null;
    const minutesTo = (key, current, floor) => {
      const m = RangeModel.slope(this.samples, key);
      if (m === null || m >= 0) return Infinity;
      return Math.max(0, (current - floor) / -m / 60);
    };
    // O2: PRI and SEC are used in turn, so treat them as one pool with a reserve floor in each.
    const oxyMin = minutesTo('oxy', last.oxy, 2 * RESERVE_PCT);
    const battMin = minutesTo('batt', last.batt, RESERVE_PCT);
    const minutes = Math.min(oxyMin, battMin);
    if (!isFinite(minutes)) return { minutes: null, meters: null, limitedBy: null, learning: true };
    return {
      minutes,
      meters: (minutes * WALK_M_PER_MIN) / 2,
      limitedBy: oxyMin <= battMin ? 'O2' : 'Battery',
      learning: this.samples.length < 30,
    };
  }
}

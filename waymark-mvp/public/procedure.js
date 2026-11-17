// Procedure state machine (proposal §2.2). Switch steps advance when TSS reports the target
// position; wait steps advance when all conditions hold; manual steps need "done".

export const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

const WATCHED = ['uia.eva1_power', 'uia.eva1_oxy', 'uia.eva1_water_supply', 'uia.eva1_water_waste',
  'uia.oxy_vent', 'uia.depress', 'dcu.oxy', 'dcu.fan', 'dcu.pump', 'dcu.co2', 'dcu.batt.lu', 'dcu.batt.ps'];

const OPS = { '<': (a, b) => a < b, '>': (a, b) => a > b };

export class Procedure {
  constructor(def) {
    this.def = def;
    this.index = 0;
    this.prev = null;
    this.wrong = null;      // { path, at }
  }

  get step() { return this.def.steps[this.index]; }
  get done() { return this.index >= this.def.steps.length; }

  satisfied(step, eva) {
    if (!eva || !step) return false;
    if (step.type === 'switch') return get(eva, step.path) === step.expect;
    if (step.type === 'wait') return step.all.every((c) => OPS[c.op](get(eva, c.path), c.value));
    return false;
  }

  /** Feed a new snapshot; returns true if the step changed. */
  update(eva) {
    if (!eva) return false;
    // Wrong-switch detection: any watched switch that changed and isn't the current step's target.
    const now = Object.fromEntries(WATCHED.map((p) => [p, get(eva, p)]));
    if (this.prev && !this.done) {
      for (const p of WATCHED) {
        if (now[p] !== this.prev[p] && p !== this.step.path) this.wrong = { path: p, at: Date.now() };
        if (now[p] !== this.prev[p] && p === this.step.path) this.wrong = null;
      }
    }
    this.prev = now;

    let moved = false;
    while (!this.done && this.satisfied(this.step, eva)) { this.index++; moved = true; }
    return moved;
  }

  next() { if (!this.done) this.index++; }
  back() { if (this.index > 0) this.index--; }
  reset() { this.index = 0; this.wrong = null; }
}

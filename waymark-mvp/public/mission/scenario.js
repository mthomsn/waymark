// Scripted EVA scenario (proposal Table 3 / TSS EV team procedure timeline).
// Pure logic, no DOM: update(model) each frame, phases advance on objective conditions;
// next()/back() are the manual overrides ("done" / "back"). Ports 1:1 to a C# class.

import { GEOLOGY_POIS } from './pois.js';

export const ARRIVE_M = 3;           // "arrived" radius for navigation targets
export const SAMPLE_NEAR_M = 5;      // a sample pin counts for a site within this radius
export const GEOLOGY_VISITS = 2;     // sites to visit in the geology traverse
export const WALK_M_PER_MIN = 40;    // conservative lunar walking pace (matches range.js)

// LTV repair, summarized from ltv-repair-procedures.pdf. Real steps come from TSS LTV_ERRORS at
// test week; these are the manual checkpoints the EV confirms with "done".
export const LTV_STEPS = [
  'Inspect LTV for damage, announce diagnosis',
  'Exit Recovery Mode (4800)',
  'NAV restart (4509)',
  'Diagnose and repair remaining errors',
  'Announce "LTV repairs successful"',
];

const PHASES = [
  { id: 'egress',     title: 'EVA Egress',          targetId: null,    procedure: 'egress' },
  { id: 'nav-ltv',    title: 'Navigate to LTV',     targetId: 'ltv-a', procedure: null, short: 'LTV A' },
  { id: 'ltv-repair', title: 'LTV Repair',          targetId: 'ltv-a', procedure: null },
  { id: 'geology',    title: 'Geology traverse',    targetId: null,    procedure: null },
  { id: 'return',     title: 'Return to HAB',       targetId: 'hab',   procedure: null, short: 'HAB' },
  { id: 'ingress',    title: 'EVA Ingress',         targetId: null,    procedure: 'ingress' },
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** True if proc is the named procedure ('egress' | 'ingress'), matched on def.id or def.name. */
export function isProcedure(proc, name) {
  const d = proc?.def;
  if (!d) return false;
  return d.id === name || new RegExp(`\\b${name}\\b`, 'i').test(d.name ?? '');
}

/**
 * Return-margin check (proposal: recommend the next POI only when the EV can still reach the
 * lander with reserve). est.minutes is already time-to-reserve-floor, so margin > 0 = OK.
 * `via` (optional {x,y}) = candidate POI: walk pose → via → HAB.
 * → { ok, marginMin, needMin, meters }  (marginMin null when no estimate yet; ok stays true then)
 */
export function returnCheck(model, via = null) {
  const pose = model?.pose;
  const hab = model?.pois?.find((p) => p.id === 'hab') ?? { x: -5670, y: -10060 };
  if (!pose) return { ok: true, marginMin: null, needMin: null, meters: null };
  const meters = via ? dist(pose, via) + dist(via, hab) : dist(pose, hab);
  const needMin = meters / WALK_M_PER_MIN;
  const avail = model?.est?.minutes;
  if (typeof avail !== 'number' || !isFinite(avail)) return { ok: true, marginMin: null, needMin, meters };
  const marginMin = avail - needMin;
  return { ok: marginMin > 0, marginMin, needMin, meters };
}

export class Scenario {
  constructor({ pois = [], now = () => Date.now() } = {}) {
    this.pois = pois;
    this.geology = pois.filter((p) => p.kind === 'geology');
    if (!this.geology.length) this.geology = GEOLOGY_POIS;
    this.now = now;
    this.reset();
  }

  poi(id) { return this.pois.find((p) => p.id === id) ?? null; }

  reset() {
    this.phaseIndex = 0;
    this.ltvStep = 0;
    this.visited = new Set();     // geology POI ids reached during the traverse
    this.sampled = false;
    this.complete = false;
    this.log = [];
    this._log('reset', null, PHASES[0].id);
    this._build(null);
  }

  /** Feed the shared model; returns true if the phase changed. */
  update(model) {
    if (this.complete) { this._build(model); return false; }
    const before = this.phaseIndex;
    if (this._satisfied(model)) this._advance('auto');
    this._build(model);
    return this.phaseIndex !== before;
  }

  /** Manual "done": advances an LTV repair sub-step, otherwise completes the current phase. */
  next() {
    if (this.complete) return;
    const ph = PHASES[this.phaseIndex];
    if (ph.id === 'ltv-repair' && this.ltvStep < LTV_STEPS.length - 1) {
      this.ltvStep++;
      this._log('step', ph.id, ph.id, LTV_STEPS[this.ltvStep]);
    } else {
      this._advance('next');
    }
    this._build(this._lastModel);
  }

  back() {
    if (this.complete) { this.complete = false; this._log('back', 'complete', PHASES[this.phaseIndex].id); }
    else if (PHASES[this.phaseIndex].id === 'ltv-repair' && this.ltvStep > 0) this.ltvStep--;
    else if (this.phaseIndex > 0) {
      const from = PHASES[this.phaseIndex].id;
      this.phaseIndex--;
      this._enter();
      this._log('back', from, PHASES[this.phaseIndex].id);
    }
    this._build(this._lastModel);
  }

  // --- internals ---------------------------------------------------------------------------

  _log(how, from, to, note) { this.log.push({ t: this.now(), how, from, to, ...(note ? { note } : {}) }); }

  _enter() {
    // Reset per-phase progress when (re)entering a phase.
    const id = PHASES[this.phaseIndex].id;
    if (id === 'ltv-repair') this.ltvStep = 0;
    if (id === 'geology') { this.visited = new Set(); this.sampled = false; }
  }

  _advance(how) {
    const from = PHASES[this.phaseIndex].id;
    if (this.phaseIndex >= PHASES.length - 1) {
      this.complete = true;
      this._log(how, from, 'complete');
      return;
    }
    this.phaseIndex++;
    this._enter();
    this._log(how, from, PHASES[this.phaseIndex].id);
  }

  _satisfied(m) {
    const ph = PHASES[this.phaseIndex];
    const pose = m?.pose;
    switch (ph.id) {
      case 'egress':
      case 'ingress':
        return isProcedure(m?.proc, ph.procedure) && m.proc.done === true;
      case 'nav-ltv':
      case 'return': {
        const t = this.poi(ph.targetId);
        return !!(pose && t && dist(pose, t) <= ARRIVE_M);
      }
      case 'geology': {
        if (pose) for (const g of this.geology) if (dist(pose, g) <= ARRIVE_M) this.visited.add(g.id);
        this.sampled = (m?.pins ?? []).some((p) => p.sample &&
          this.geology.some((g) => dist(p, g) <= SAMPLE_NEAR_M));
        return this.visited.size >= Math.min(GEOLOGY_VISITS, this.geology.length) && this.sampled;
      }
      default:
        return false; // ltv-repair: manual only
    }
  }

  /** Nearest unvisited geology site to the pose (or first unvisited). */
  _nextGeology(pose) {
    const left = this.geology.filter((g) => !this.visited.has(g.id));
    if (!left.length) return null;
    if (!pose) return left[0];
    return left.reduce((a, b) => (dist(pose, a) <= dist(pose, b) ? a : b));
  }

  _build(m) {
    this._lastModel = m;
    const ph = PHASES[this.phaseIndex];
    const pose = m?.pose;
    const phase = { id: ph.id, title: ph.title, objective: '', targetId: ph.targetId, procedure: ph.procedure };
    const withDist = (t) => {
      if (!t) return '';
      if (!pose) return '';
      phase.distance = dist(pose, t);
      return ` · ${Math.round(phase.distance)} m`;
    };

    if (this.complete) {
      phase.id = 'complete'; phase.title = 'EVA complete'; phase.objective = 'EVA complete';
      phase.targetId = null; phase.procedure = null;
    } else switch (ph.id) {
      case 'egress':
      case 'ingress': {
        const p = m?.proc;
        const prog = isProcedure(p, ph.procedure) && p.def?.steps
          ? ` · step ${Math.min(p.index + 1, p.def.steps.length)}/${p.def.steps.length}` : '';
        phase.objective = `${ph.id === 'egress' ? 'Complete egress at UIA' : 'Ingress at UIA'}${prog}`;
        break;
      }
      case 'nav-ltv':
      case 'return':
        phase.objective = `Walk to ${ph.short}${withDist(this.poi(ph.targetId))}`;
        break;
      case 'ltv-repair':
        phase.step = { index: this.ltvStep, total: LTV_STEPS.length, text: LTV_STEPS[this.ltvStep] };
        phase.objective = `LTV: ${LTV_STEPS[this.ltvStep]} · ${this.ltvStep + 1}/${LTV_STEPS.length}`;
        withDist(this.poi(ph.targetId));
        break;
      case 'geology': {
        const need = Math.min(GEOLOGY_VISITS, this.geology.length);
        phase.visited = [...this.visited];
        phase.sampled = this.sampled;
        if (this.visited.size < need) {
          const g = this._nextGeology(pose);
          phase.targetId = g.id;
          phase.objective = `Visit ${g.label} (${this.visited.size + 1}/${need})${withDist(g)}`;
        } else {
          phase.objective = 'Mark a sample at a geology site';
        }
        break;
      }
    }

    this.state = {
      phaseIndex: this.phaseIndex,
      phase,
      phases: PHASES.map(({ id, title, targetId, procedure }) => ({ id, title, targetId, procedure })),
      log: this.log,
      complete: this.complete,
    };
  }
}

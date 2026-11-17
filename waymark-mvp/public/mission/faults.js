// Client-side fault injector (dev drawer / scripted demos). Never writes to TSS: apply() takes the
// live EVA.json and returns a modified deep copy. Each fault keeps its own state that evolves by
// dt per call, so drains/climbs continue smoothly across frames. A fault "resolves" when the EV
// throws the right DCU switch (TSS error-handling procedures); it stays listed in `active`
// until cleared, so the HUD can show "resolved" — except hrhigh, which self-clears.

export const FAULTS = [
  { id: 'o2leak',    label: 'O2 leak',          description: 'Primary O2 tank drains fast, suit O2 pressure drops.', fix: 'DCU: OXY → SEC, return to lander' },
  { id: 'fanfail',   label: 'Fan failure',      description: 'Primary fan stops (0 rpm).',                         fix: 'DCU: FAN → SEC' },
  { id: 'co2high',   label: 'CO2 scrubber',     description: 'Scrubber A saturates; helmet and suit CO2 climb.',   fix: 'DCU: CO2 → B' },
  { id: 'hrhigh',    label: 'High heart rate',  description: 'Heart rate climbs to ~172 bpm, settles after 45 s.',  fix: 'Slow down, control breathing' },
  { id: 'battlow',   label: 'Low battery',      description: 'Primary battery drops to 18 %.',                     fix: 'DCU: BATT → SEC' },
  { id: 'commsloss', label: 'Comms loss',       description: 'No telemetry: HUD goes stale / limited mode.',       fix: 'Clear fault (link restored)' },
];

const O2_DRAIN_PCT_S = 2;       // o2leak: oxy_pri_storage drain rate
const SCRUB_CLIMB_PCT_S = 3;    // co2high: scrubber A fill rate
const HR_PEAK = 172;
const HR_HOLD_S = 45;           // hrhigh resolves itself ("slowed down") after this
const HR_CLEAR_S = 60;          // ...and drops out of `active` once eased back

/** Exponential approach of x toward target with time constant tau (s). Frame-rate independent. */
const ease = (x, target, dt, tau) => x + (target - x) * (1 - Math.exp(-dt / tau));
const toward = (x, target, rate, dt) => (x < target ? Math.min(target, x + rate * dt) : Math.max(target, x - rate * dt));

export class FaultInjector {
  constructor() { this.faults = new Map(); } // id -> { t, resolved, ...per-fault state }

  get active() { return [...this.faults.keys()]; }

  /** [{id, label, resolved, t}] for the HUD. */
  get status() {
    return [...this.faults].map(([id, s]) => ({ id, label: FAULTS.find((f) => f.id === id).label, resolved: s.resolved, t: s.t }));
  }

  inject(id) {
    if (!FAULTS.some((f) => f.id === id)) throw new Error(`unknown fault ${id}`);
    if (!this.faults.has(id)) this.faults.set(id, { t: 0, resolved: false });
  }

  clear(id) { if (id === 'all') this.clearAll(); else this.faults.delete(id); }
  clearAll() { this.faults.clear(); }

  /** Live eva → modified deep copy (or null for comms loss / no data). Advances fault state by dt. */
  apply(eva, dt = 0) {
    if (this.faults.has('commsloss')) { this.faults.get('commsloss').t += dt; return null; }
    if (!eva) return null;
    if (!this.faults.size) return eva;
    const out = structuredClone(eva);
    const T = (out.telemetry ??= {});
    const E = (out.error ??= {});
    const D = out.dcu ?? {};

    for (const [id, s] of this.faults) {
      s.t += dt;
      switch (id) {
        case 'o2leak': {
          s.level ??= T.oxy_pri_storage ?? 100;
          s.suit ??= T.suit_pressure_oxy ?? 4;
          s.resolved = D.oxy === false;               // on SEC: leak isolated, PRI stays low
          if (!s.resolved) {
            s.level = Math.max(0, s.level - O2_DRAIN_PCT_S * dt);
            s.suit = ease(s.suit, 3.2, dt, 8);
            T.suit_pressure_oxy = s.suit;
            E.oxy_error = true;
          } else {
            s.suit = T.suit_pressure_oxy ?? s.suit;   // SEC supplies the suit again
          }
          T.oxy_pri_storage = Math.min(s.level, T.oxy_pri_storage ?? s.level);
          break;
        }
        case 'fanfail': {
          s.rpm ??= T.fan_pri_rpm ?? 30000;
          s.rpm = ease(s.rpm, 0, dt, 1.5);             // spins down over a few seconds
          T.fan_pri_rpm = s.rpm < 50 ? 0 : s.rpm;
          s.resolved = D.fan === false;
          if (s.resolved) T.fan_sec_rpm = 30000;
          else E.fan_error = true;
          break;
        }
        case 'co2high': {
          s.scrub ??= T.scrubber_a_co2_storage ?? 20;
          s.helmet ??= T.helmet_pressure_co2 ?? 0.05;
          s.suit ??= T.suit_pressure_co2 ?? 0.05;
          s.resolved = D.co2 === false;               // swapped to scrubber B
          if (!s.resolved) {
            s.scrub = toward(s.scrub, 70, SCRUB_CLIMB_PCT_S, dt);
            s.helmet = ease(s.helmet, 0.2, dt, 10);
            s.suit = ease(s.suit, 0.12, dt, 10);
            E.scrubber_error = true;
          } else {
            // A is offline and vents; CO2 partial pressures recover toward the live values.
            s.scrub = ease(s.scrub, T.scrubber_a_co2_storage ?? 0, dt, 10);
            s.helmet = ease(s.helmet, T.helmet_pressure_co2 ?? 0, dt, 5);
            s.suit = ease(s.suit, T.suit_pressure_co2 ?? 0, dt, 5);
          }
          T.scrubber_a_co2_storage = s.scrub;
          T.helmet_pressure_co2 = s.helmet;
          T.suit_pressure_co2 = s.suit;
          break;
        }
        case 'hrhigh': {
          s.hr ??= T.heart_rate ?? 90;
          const live = T.heart_rate ?? 90;
          s.resolved = s.t >= HR_HOLD_S;
          s.hr = ease(s.hr, s.resolved ? live : HR_PEAK, dt, s.resolved ? 4 : 6);
          T.heart_rate = s.hr;
          break;
        }
        case 'battlow': {
          s.level ??= T.primary_battery_level ?? 100;
          s.level = toward(s.level, 18, 10, dt);       // ~10 %/s plunge, then holds at 18
          T.primary_battery_level = Math.min(s.level, T.primary_battery_level ?? s.level);
          s.resolved = D.batt?.ps === false;          // on SEC: secondary carries the load
          if (!s.resolved) E.power_error = true;
          break;
        }
      }
    }
    // hrhigh is the one fault that ends without a switch: drop it once eased back.
    const hr = this.faults.get('hrhigh');
    if (hr && hr.t >= HR_CLEAR_S) this.faults.delete('hrhigh');
    return out;
  }
}

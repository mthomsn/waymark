// Caution & warning engine. Ranges from TSS2027 documents/telemetry_ranges/eva-telemetry-ranges.pdf.
// Ports 1:1 to C# on the headset: pure functions, no DOM.

export const RANGES = {
  primary_battery_level:   { label: 'Batt PRI',        unit: '%',       min: 20,    max: 100,   watch: 'low' },
  secondary_battery_level: { label: 'Batt SEC',        unit: '%',       min: 20,    max: 100,   watch: 'low' },
  oxy_pri_storage:         { label: 'O2 PRI',          unit: '%',       min: 20,    max: 100,   watch: 'low' },
  oxy_sec_storage:         { label: 'O2 SEC',          unit: '%',       min: 20,    max: 100,   watch: 'low' },
  oxy_pri_pressure:        { label: 'O2 PRI press',    unit: 'psi',     min: 600,   max: 3000 },
  oxy_sec_pressure:        { label: 'O2 SEC press',    unit: 'psi',     min: 600,   max: 3000 },
  coolant_storage:         { label: 'Coolant',         unit: '%',       min: 80,    max: 100,   watch: 'low' },
  heart_rate:              { label: 'Heart rate',      unit: 'bpm',     min: 50,    max: 160 },
  oxy_consumption:         { label: 'O2 use',          unit: 'psi/min', min: 0.05,  max: 0.15 },
  co2_production:          { label: 'CO2 prod',        unit: 'psi/min', min: 0.05,  max: 0.15 },
  suit_pressure_oxy:       { label: 'Suit O2',         unit: 'psi',     min: 3.5,   max: 4.1 },
  suit_pressure_co2:       { label: 'Suit CO2',        unit: 'psi',     min: 0,     max: 0.1,   watch: 'high' },
  suit_pressure_other:     { label: 'Suit other',      unit: 'psi',     min: 0,     max: 0.5,   watch: 'high' },
  suit_pressure_total:     { label: 'Suit total',      unit: 'psi',     min: 3.5,   max: 4.5 },
  helmet_pressure_co2:     { label: 'Helmet CO2',      unit: 'psi',     min: 0,     max: 0.15,  watch: 'high' },
  fan_pri_rpm:             { label: 'Fan PRI',         unit: 'rpm',     min: 29000, max: 31000 },
  fan_sec_rpm:             { label: 'Fan SEC',         unit: 'rpm',     min: 29000, max: 31000 },
  scrubber_a_co2_storage:  { label: 'Scrubber A',      unit: '%',       min: 0,     max: 60,    watch: 'high' },
  scrubber_b_co2_storage:  { label: 'Scrubber B',      unit: '%',       min: 0,     max: 60,    watch: 'high' },
  temperature:             { label: 'Suit temp',       unit: '°C',      min: 10,    max: 32 },
  coolant_liquid_pressure: { label: 'Coolant liq',     unit: 'psi',     min: 100,   max: 700 },
  coolant_gas_pressure:    { label: 'Coolant gas',     unit: 'psi',     min: 0,     max: 700,   watch: 'high' },
};

// Suit-system values only meaningful once the suit is pressurized / EVA running.
const ACTIVE_ONLY = new Set(['heart_rate', 'oxy_consumption', 'co2_production', 'suit_pressure_oxy',
  'suit_pressure_co2', 'suit_pressure_other', 'suit_pressure_total', 'helmet_pressure_co2',
  'oxy_pri_pressure', 'oxy_sec_pressure', 'coolant_storage', 'coolant_liquid_pressure', 'temperature']);

const CAUTION_BAND = 0.10;   // "nearing" = within 10 % of the span from a limit
export const STALE_MS = 4000;   // TSS replies every ~1.05 s; allow a couple of misses

// Corrective actions, proposal Table 4 + TSS error-handling procedures.
const ACTIONS = {
  suit_pressure_oxy: 'DCU: OXY → SEC, return to lander',
  oxy_pri_storage: 'DCU: OXY → SEC',
  suit_pressure_co2: 'DCU: swap CO2 scrubber',
  helmet_pressure_co2: 'DCU: FAN → SEC',
  scrubber_a_co2_storage: 'DCU: CO2 → B',
  scrubber_b_co2_storage: 'DCU: CO2 → A',
  fan_pri_rpm: 'DCU: FAN → SEC',
  primary_battery_level: 'DCU: BATT → SEC',
  heart_rate: 'Slow down, control breathing',
  suit_pressure_other: 'Return to lander',
};

const ERROR_FLAGS = {
  oxy_error:      { text: 'O2 system fault',   action: 'DCU: OXY → SEC' },
  fan_error:      { text: 'Fan fault',         action: 'DCU: FAN → SEC' },
  power_error:    { text: 'Power fault',       action: 'DCU: BATT → SEC' },
  scrubber_error: { text: 'CO2 scrubber fault', action: 'DCU: swap CO2 scrubber' },
};

function level(v, r) {
  if (v < r.min || v > r.max) return 'warning';
  const band = (r.max - r.min) * CAUTION_BAND;
  const nearLow = v < r.min + band && r.watch !== 'high' && r.min > 0;
  const nearHigh = v > r.max - band && r.watch !== 'low';
  return nearLow || nearHigh ? 'caution' : 'nominal';
}

/** Evaluate one snapshot. Returns items sorted worst-first. */
export function evaluate(eva, { receivedAt, now, suitActive }) {
  const items = [];
  const t = eva?.telemetry ?? {};
  // Suit-active values (HR, suit pressure, coolant…) only alarm once egress is complete.
  const active = (suitActive ?? true) && eva?.status?.started === true;
  const fanKey = eva?.dcu?.fan === false ? 'fan_sec_rpm' : 'fan_pri_rpm';

  for (const [key, r] of Object.entries(RANGES)) {
    const v = t[key];
    if (typeof v !== 'number') continue;
    let lv = level(v, r);
    if (!active && ACTIVE_ONLY.has(key)) lv = 'nominal';
    if ((key === 'fan_pri_rpm' || key === 'fan_sec_rpm') && key !== fanKey) lv = 'nominal'; // only the selected fan matters
    items.push({ key, label: r.label, value: v, unit: r.unit, min: r.min, max: r.max, level: lv, action: lv !== 'nominal' ? ACTIONS[key] : undefined });
  }

  for (const [key, e] of Object.entries(ERROR_FLAGS)) {
    if (eva?.error?.[key]) items.push({ key, label: e.text, level: 'warning', action: e.action, flag: true });
  }

  const ageMs = receivedAt ? now - receivedAt : Infinity;
  const stale = ageMs > STALE_MS;
  const rank = { warning: 0, caution: 1, nominal: 2 };
  items.sort((a, b) => rank[a.level] - rank[b.level]);
  return { items, stale, ageMs, offNominal: items.filter((i) => i.level !== 'nominal') };
}

export function fmt(v, unit) {
  if (typeof v !== 'number') return String(v);
  const d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toFixed(d)}${unit ? ' ' + unit : ''}`;
}

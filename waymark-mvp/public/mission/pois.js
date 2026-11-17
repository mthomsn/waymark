// Extra geology sites for the scripted traverse (TSS frame, meters). Placed inside the scan
// footprint (x ∈ [-5695,-5585], y ∈ [-10066,-9954]) between the HAB and the LTV task boards.
// Positions are illustrative; nudge them if a site lands on a steep feature.

export const GEOLOGY_POIS = [
  { id: 'geo-1', label: 'Breccia outcrop', kind: 'geology', x: -5660, y: -10030 },
  { id: 'geo-2', label: 'Boulder field',   kind: 'geology', x: -5675, y: -9990 },
  { id: 'geo-3', label: 'Crater rim',      kind: 'geology', x: -5605, y: -10030 },
  { id: 'geo-4', label: 'Regolith patch',  kind: 'geology', x: -5640, y: -10005 },
];

/** world.json POIs + geology sites (world entries win on id clashes). */
export function allPois(worldPois = []) {
  const ids = new Set(worldPois.map((p) => p.id));
  return [...worldPois, ...GEOLOGY_POIS.filter((p) => !ids.has(p.id))];
}

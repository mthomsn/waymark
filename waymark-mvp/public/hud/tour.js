// "Explain-it" guided tour: callout cards that point at HUD elements or highlight world features.
// Text follows the proposal (Technical Section 1–2).

const STEPS = [
  { title: 'WAYMARK: a quiet HUD', text: 'The default view holds three things: a heading strip, a range ring and one alert slot. Everything else appears when you ask and hides again, which keeps the astronaut\'s workload low.' },
  { target: 'heading', title: 'Heading strip', text: 'Shows your compass heading, with diamonds for known sites. When you Find something, an amber chevron points to it and shows the distance, and it sticks to the edge when the target is behind you.' },
  { target: 'alert', title: 'One alert slot', text: 'Every TSS value is checked against NASA\'s nominal ranges on each update. Only the worst problem appears here, together with the fix (e.g. "DCU: FAN → SEC"). Data that stops updating is marked stale, so old values are never mistaken for current ones.' },
  { target: 'range', title: 'Predictive range', text: 'How far you can go and still get back with a 20 % reserve. It is learned from your real O2 and battery drain. If you get too far from the HAB, a "RETURN NOW" alert takes over.' },
  { world: 'trail', title: 'Breadcrumbs', text: 'Your path is recorded as you walk and pinned to the ground. If the laptop link drops, you can follow it back home.' },
  { world: 'hazards', title: 'Hazard outline', text: 'Slopes steeper than 12° are worked out from the terrain mesh. Only their edges are drawn in red, and only near you, like a VR play-area boundary.' },
  { world: 'route', panel: 'find', title: 'Find + best path', text: '"Find LTV" plans an A* route that avoids slopes over 15° and draws it as an amber ribbon on the ground. A beacon marks the target, and the minimap shows the route, your trail and every site.' },
  { world: 'pins', title: 'Mark sample', text: 'Saying "Mark sample" drops a beacon tagged with the time, your position and the XRF reading from TSS. Later, "Find sample" guides you back to it.' },
  { target: 'objective', panel: 'procedure', title: 'Procedures that check themselves', text: 'Egress and ingress go one step at a time. When TSS shows the right UIA or DCU switch, the step advances by itself, and a wrong switch is flagged straight away.' },
  { target: 'link', title: 'Limited mode', text: 'Every safety function runs on the headset. If telemetry or the laptop link drops, a LIMITED MODE banner appears, while warnings, procedures and breadcrumbs keep working. You can try it with Comms loss in the dev drawer.' },
  { title: 'Try it', text: 'Click to walk with WASD. Try "find LTV", "mark sample" or "status". Start the scripted EVA from the dev drawer and inject faults to see the caution and warning in action. Press T to replay this tour, or H for help.' },
];

export function createTour({ root, worldHighlight, show, hideAll }) {
  const dim = document.createElement('div');
  dim.className = 'tour-dim hidden';
  const ring = document.createElement('div');
  ring.className = 'tour-ring hidden';
  const card = document.createElement('div');
  card.className = 'tour-card hidden';
  root.append(dim, ring, card);

  let i = -1;
  const api = { get active() { return i >= 0; }, start, stop, go };

  function start() { document.exitPointerLock?.(); go(0); }
  function stop() {
    i = -1;
    [dim, ring, card].forEach((n) => n.classList.add('hidden'));
    worldHighlight(null);
  }
  function go(n) {
    if (n < 0 || n >= STEPS.length) return stop();
    i = n;
    const s = STEPS[i];
    hideAll();
    if (s.panel) show(s.panel, true);
    worldHighlight(s.world ?? null);
    card.innerHTML = `<div class="n">${i + 1} / ${STEPS.length}</div><h4>${s.title}</h4><p>${s.text}</p>
      <div class="nav"><button class="btn" data-t="exit">Exit</button>${i ? '<button class="btn" data-t="back">◂ Back</button>' : ''}
      <button class="btn on" data-t="next">${i === STEPS.length - 1 ? 'Done' : 'Next ▸'}</button></div>`;
    card.classList.remove('hidden');
    // Let panels finish appearing before measuring.
    requestAnimationFrame(() => requestAnimationFrame(place));
  }

  function place() {
    if (i < 0) return;
    const s = STEPS[i];
    const vw = innerWidth, vh = innerHeight, cw = card.offsetWidth, ch = card.offsetHeight;
    const target = s.target && root.querySelector(`[data-tour="${s.target}"]`);
    if (target) {
      dim.classList.add('hidden');
      const r = target.getBoundingClientRect();
      const pad = 8;
      Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      ring.classList.remove('hidden');
      // Put the card below the target if there is room, else above; clamp horizontally.
      let top = r.bottom + 18;
      if (top + ch > vh - 16) top = Math.max(16, r.top - ch - 18);
      let left = r.left + r.width / 2 - cw / 2;
      left = Math.max(16, Math.min(vw - cw - 16, left));
      Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
    } else {
      ring.classList.add('hidden');
      dim.classList.toggle('hidden', !!s.world); // keep the world visible for world steps
      const top = s.world ? vh - ch - 110 : (vh - ch) / 2;
      Object.assign(card.style, { left: `${(vw - cw) / 2}px`, top: `${Math.max(16, top)}px` });
    }
  }

  card.addEventListener('click', (e) => {
    const a = e.target.closest('[data-t]')?.dataset.t;
    if (a === 'next') go(i + 1);
    if (a === 'back') go(i - 1);
    if (a === 'exit') stop();
  });
  dim.addEventListener('click', () => go(i + 1));
  // Window capture phase + stopImmediatePropagation so the world doesn't also walk/turn on arrows.
  addEventListener('keydown', (e) => {
    if (i < 0) return;
    if (e.key === 'ArrowRight' || e.key === 'Enter') go(i + 1);
    else if (e.key === 'ArrowLeft') go(i - 1);
    else if (e.key === 'Escape') stop();
    else return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  addEventListener('resize', () => i >= 0 && place());

  return api;
}

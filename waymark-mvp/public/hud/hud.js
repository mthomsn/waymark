// WAYMARK v2 HUD overlay. update(model) runs every animation frame, so everything diffs
// before touching the DOM: the heading strip redraws only when heading/markers change,
// panels re-render at ~4 Hz and only when their HTML changes.
import { fmt } from '../cw.js';
import { createTour } from './tour.js';

const PANEL_TIMEOUT_MS = 12000;
const SLOW_MS = 250;
const R = 54, CIRC = 2 * Math.PI * R;           // range ring geometry
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (d) => ((d % 360) + 360) % 360;
const bearing = (from, to) => norm((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

const UIA = [[2001, 'uia.eva1_power', 'EMU1 PWR'], [2002, 'uia.eva1_oxy', 'EV1 O2'], [2003, 'uia.eva1_water_supply', 'EV1 SUPPLY'],
  [2004, 'uia.eva1_water_waste', 'EV1 WASTE'], [2009, 'uia.oxy_vent', 'O2 VENT'], [2010, 'uia.depress', 'DEPRESS']];
const DCU = [[2011, 'dcu.batt.lu', 'BATT LOCAL', 'BATT UMB'], [2013, 'dcu.batt.ps', 'BATT PRI', 'BATT SEC'], [2012, 'dcu.oxy', 'OXY PRI', 'OXY SEC'],
  [2014, 'dcu.fan', 'FAN PRI', 'FAN SEC'], [2015, 'dcu.pump', 'PUMP OPEN', 'PUMP CLOSED'], [2016, 'dcu.co2', 'CO2 A', 'CO2 B']];
const FAULT_BTNS = [['o2leak', 'O2 leak'], ['fanfail', 'Fan fail'], ['co2high', 'CO2 high'], ['hrhigh', 'HR high'], ['battlow', 'Batt low'], ['commsloss', 'Comms loss']];
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

export function createHud({ root, onCommand, worldHighlight = () => {} }) {
  root.innerHTML = `
    <div class="visor"><i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i></div>
    <div class="top" data-tour="heading"><canvas id="heading" width="1440" height="132"></canvas><div class="objective" data-tour="objective"></div></div>
    <div class="chip" data-tour="link"><i></i><span></span></div>
    <div class="limited hidden">LIMITED MODE</div>
    <div class="alert" data-tour="alert"><div class="t"></div><div class="a"></div><div class="m"></div></div>
    <div class="range" data-tour="range">
      <svg viewBox="0 0 132 132"><circle class="bg" cx="66" cy="66" r="${R}"/>
        <circle class="arc" cx="66" cy="66" r="${R}" transform="rotate(-90 66 66)" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}"/>
        <line class="tick" x1="66" y1="4" x2="66" y2="18"/></svg>
      <div class="txt"><div class="big">--</div><div class="small">range</div></div>
    </div>
    <section class="panel right" data-panel="status"><h3>Status <span></span></h3><div class="body"></div></section>
    <section class="panel right" data-panel="find"><h3>Find <span></span></h3><canvas id="minimap" width="640" height="480"></canvas><div class="findinfo"></div></section>
    <section class="panel right" data-panel="range"><h3>Range</h3><div class="body"></div></section>
    <section class="panel left" data-panel="procedure"><h3>Procedure <span></span></h3><div class="body"></div></section>
    <div class="toast"></div>
    <form class="cmd" data-tour="cmd"><span class="wake">Waymark,</span><input autocomplete="off" placeholder="status · find LTV · range · mark sample · procedure  ( / )"><button type="button" class="btn mic">mic</button></form>
    <div class="hint">Click to walk · <b>WASD</b> move · <b>Shift</b> run · <b>T</b> tour · <b>H</b> help</div>
    <div class="overlay help hidden"><div class="card interactive"><h2>Voice commands</h2><table>
      <tr><td>Status</td><td>Suit and vitals, off-nominal first <kbd>S</kbd></td></tr>
      <tr><td>Find &lt;target&gt;</td><td>HAB, LTV, sample, pin, a geology site — direction, distance, route <kbd>F</kbd></td></tr>
      <tr><td>Range</td><td>How far you can go and still return with reserve <kbd>R</kbd></td></tr>
      <tr><td>Mark [sample]</td><td>Drop a pin; "sample" tags it with the XRF reading <kbd>M</kbd></td></tr>
      <tr><td>Procedure</td><td>Current EVA task, one step at a time <kbd>P</kbd></td></tr>
      <tr><td>Next · Back · Done · Repeat</td><td>Inside any panel <kbd>N</kbd> <kbd>B</kbd> <kbd>D</kbd></td></tr>
      <tr><td>Walk</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows, <kbd>Shift</kbd> run, mouse look, <kbd>Esc</kbd> release</td></tr>
      <tr><td>Tour · Help</td><td><kbd>T</kbd> guided tour · <kbd>H</kbd> this card · <kbd>/</kbd> type a command</td></tr>
    </table><div style="text-align:right;margin-top:12px"><button class="btn" data-close>Close</button></div></div></div>
    <details class="dev"><summary>Dev drawer</summary>
      <div class="sec"><h4>EVA</h4><div class="btns"><button class="btn" data-dev="start">Start EVA</button><button class="btn" data-dev="stop">Stop EVA</button>
        <label><input type="checkbox" data-sync> Sync pose → TSS</label></div></div>
      <div class="sec"><h4>UIA</h4><div class="btns">${UIA.map(([c, p, l]) => `<button class="btn" data-dev="cmd:${c}" data-path="${p}">${l}</button>`).join('')}</div></div>
      <div class="sec"><h4>DCU</h4><div class="btns">${DCU.map(([c, p, on, off]) => `<button class="btn" data-dev="cmd:${c}" data-path="${p}" data-on="${on}" data-off="${off}">${on}</button>`).join('')}</div></div>
      <div class="sec"><h4>Inject fault (client-side)</h4><div class="btns">${FAULT_BTNS.map(([id, l]) => `<button class="btn" data-dev="fault:${id}" data-fault="${id}">${l}</button>`).join('')}<button class="btn" data-dev="fault:clear">Clear</button></div></div>
      <div class="sec"><h4>Scenario</h4><div class="btns"><button class="btn" data-dev="scenario:back">◂ Back</button><button class="btn" data-dev="scenario:next">Next ▸</button><button class="btn" data-dev="scenario:reset">Reset</button></div></div>
    </details>`;

  const $ = (s) => root.querySelector(s);
  const el = {
    heading: $('#heading'), objective: $('.objective'), chip: $('.chip'), chipText: $('.chip span'), limited: $('.limited'),
    alert: $('.alert'), alertT: $('.alert .t'), alertA: $('.alert .a'), alertM: $('.alert .m'),
    arc: $('.range .arc'), big: $('.range .big'), small: $('.range .small'),
    toast: $('.toast'), input: $('.cmd input'), mic: $('.mic'), hint: $('.hint'), help: $('.help'), dev: $('.dev'), sync: $('[data-sync]'),
    minimap: $('#minimap'), findinfo: $('.findinfo'),
  };
  const panels = Object.fromEntries([...root.querySelectorAll('[data-panel]')].map((p) => [p.dataset.panel, p]));
  const timers = {};
  const cache = new Map();
  const setHTML = (node, html) => { if (cache.get(node) !== html) { cache.set(node, html); node.innerHTML = html; } };
  const setText = (node, t) => { if (cache.get(node) !== t) { cache.set(node, t); node.textContent = t; } };
  const setClass = (node, c) => { if (node.className !== c) node.className = c; };
  let model = null;
  let showNominal = false;
  let lastSlow = 0;
  let headingKey = '';

  // ---------------------------------------------------------------- panels
  function show(name, sticky = false) {
    const p = panels[name]; if (!p) return;
    const narrow = innerWidth <= 700; // phones: one panel at a time
    for (const [n, q] of Object.entries(panels)) if (n !== name && (narrow || (q.classList.contains('right') && p.classList.contains('right')))) q.classList.remove('on');
    p.classList.add('on');
    clearTimeout(timers[name]);
    if (!sticky) timers[name] = setTimeout(() => p.classList.remove('on'), PANEL_TIMEOUT_MS);
    lastSlow = 0; // render immediately
  }
  function hideAll() { Object.values(panels).forEach((p) => p.classList.remove('on')); el.help.classList.add('hidden'); }
  const isOpen = (n) => panels[n].classList.contains('on');

  let toastTimer;
  function toast(text, { speak = false } = {}) {
    el.toast.textContent = text; el.toast.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('on'), 4500);
    if (speak && viaVoice && 'speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  // ---------------------------------------------------------------- input
  let viaVoice = false;
  $('.cmd').addEventListener('submit', (e) => { e.preventDefault(); viaVoice = false; const v = el.input.value; el.input.value = ''; el.input.blur(); if (v.trim()) onCommand(v); });
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    const rec = new SR(); rec.lang = 'en-US';
    rec.onresult = (e) => { viaVoice = true; onCommand(e.results[0][0].transcript); };
    rec.onend = () => el.mic.classList.remove('live');
    el.mic.onclick = () => { el.mic.classList.add('live'); try { rec.start(); } catch { } };
  } else el.mic.classList.add('hidden');

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dev]');
    if (b) { onCommand(`dev:${b.dataset.dev}`); return; }
    if (e.target.closest('[data-close]')) el.help.classList.add('hidden');
    if (e.target.closest('.collapse')) { showNominal = !showNominal; lastSlow = 0; }
  });
  el.sync.addEventListener('change', () => onCommand(`dev:sync:${el.sync.checked ? 'on' : 'off'}`));

  const KEYS = { s: 'status', f: 'find', r: 'range', m: 'mark sample', p: 'procedure', n: 'next', b: 'back', d: 'done' };
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (tour.active) return; // tour owns arrows/Esc while running
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // While walking with pointer lock, S/D/A/W are movement keys: only non-movement hotkeys apply.
    const walking = !!document.pointerLockElement;
    if (k === '/') { e.preventDefault(); document.exitPointerLock?.(); el.input.focus(); return; }
    if (k === 't') { tour.start(); return; }
    if (k === 'h') { el.help.classList.toggle('hidden'); return; }
    if (k === 'Escape') { hideAll(); onCommand('close'); return; }
    if (walking && 'wasd'.includes(k)) return;
    if (KEYS[k]) { viaVoice = false; onCommand(KEYS[k]); }
  });
  document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement) el.hint.style.opacity = '0'; });
  setTimeout(() => { el.hint.style.opacity = '0'; }, 20000);

  const tour = createTour({ root, worldHighlight, show, hideAll });

  // ---------------------------------------------------------------- heading strip
  const hctx = el.heading.getContext('2d');
  function drawHeading(m) {
    const W = el.heading.width, H = el.heading.height, span = 110, ppd = W / span;
    const h = m.pose?.heading ?? 0;
    const marks = [...(m.pois || []).map((p) => ({ b: bearing(m.pose, p), label: '', kind: p.kind })),
      ...(m.target ? [{ b: bearing(m.pose, m.target), label: `${Math.round(dist(m.pose, m.target))} m`, kind: 'target' }] : [])];
    const key = `${h.toFixed(1)}|${marks.map((x) => x.b.toFixed(0) + x.label).join(',')}`;
    if (key === headingKey) return;
    headingKey = key;
    const g = hctx;
    g.clearRect(0, 0, W, H);
    g.lineCap = 'round';
    const base = 72;
    for (let d = Math.ceil((h - span / 2) / 5) * 5; d <= h + span / 2; d += 5) {
      const x = W / 2 + (d - h) * ppd, n = norm(d), major = n % 30 === 0;
      g.globalAlpha = 1 - (Math.abs(d - h) / (span / 2)) * 0.75;
      g.strokeStyle = '#e3efe9'; g.lineWidth = major ? 4 : 2.5;
      g.beginPath(); g.moveTo(x, base); g.lineTo(x, base - (major ? 22 : 11)); g.stroke();
      if (major) {
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] ?? String(n);
        g.fillStyle = lbl.length === 1 ? '#7be0b0' : '#e3efe9';
        g.font = `700 ${lbl.length === 1 ? 30 : 24}px ui-monospace, Menlo, monospace`; g.textAlign = 'center';
        g.fillText(lbl, x, base - 32);
      }
    }
    g.globalAlpha = 1;
    // center caret + readout
    g.fillStyle = '#e3efe9';
    g.beginPath(); g.moveTo(W / 2 - 12, base + 6); g.lineTo(W / 2 + 12, base + 6); g.lineTo(W / 2, base - 8); g.fill();
    g.font = '700 22px ui-monospace, Menlo, monospace'; g.textAlign = 'center';
    g.fillText(String(Math.round(norm(h))).padStart(3, '0'), W / 2, base + 52);
    // markers: POIs (small diamonds) and target (big chevron, clamps to edge)
    for (const mk of marks) {
      const off = ((mk.b - h + 540) % 360) - 180;
      const isT = mk.kind === 'target';
      if (!isT && Math.abs(off) > span / 2) continue;
      const c = Math.max(-span / 2 + 3, Math.min(span / 2 - 3, off));
      const x = W / 2 + c * ppd;
      g.fillStyle = isT ? '#ffb020' : 'rgba(123,224,176,.8)';
      g.beginPath();
      if (isT && Math.abs(off) > span / 2 - 3) { const s = Math.sign(off); g.moveTo(x + 16 * s, 50); g.lineTo(x - 8 * s, 36); g.lineTo(x - 8 * s, 64); }
      else if (isT) { g.moveTo(x - 16, base + 26); g.lineTo(x + 16, base + 26); g.lineTo(x, base + 6); }
      else { g.moveTo(x, base + 6); g.lineTo(x + 8, base + 15); g.lineTo(x, base + 24); g.lineTo(x - 8, base + 15); }
      g.fill();
      if (isT) { g.font = '700 22px ui-monospace, Menlo, monospace'; g.fillText(mk.label, Math.max(60, Math.min(W - 60, x)), 22); }
    }
  }

  // ---------------------------------------------------------------- fast parts (every frame, diffed)
  function renderAlert(m) {
    const a = m.alerts?.[0];
    if (!a) { el.alert.classList.remove('on'); return; }
    setClass(el.alert, `alert on ${a.level}`);
    setText(el.alertT, a.text); setText(el.alertA, a.action || '');
    setText(el.alertM, m.alerts.length > 1 ? `+${m.alerts.length - 1} more · say "status"` : '');
  }

  function renderLink(m) {
    const bad = m.stale || m.link !== 'ok';
    setClass(el.chip, bad ? 'chip bad' : 'chip');
    const t = m.eva?.telemetry;
    const s = bad ? (m.ageMs < 1e9 ? `TSS ${m.stale ? 'stale' : m.link} · ${Math.round(m.ageMs / 1000)} s` : `TSS ${m.link}`)
      : `TSS · ${m.eva?.status?.started ? 'EVA ' + clock(t?.eva_elapsed_time ?? 0) : 'EVA not started'}`;
    setText(el.chipText, s);
    el.limited.classList.toggle('hidden', !m.stale);
  }

  function renderRange(m) {
    const t = m.eva?.telemetry, e = m.est;
    const pool = t ? Math.max(0, Math.min(1, (t.oxy_pri_storage + t.oxy_sec_storage - 40) / 160)) : 0;
    const off = (CIRC * (1 - pool)).toFixed(1);
    if (el.arc.getAttribute('stroke-dashoffset') !== off) el.arc.setAttribute('stroke-dashoffset', off);
    let cls = 'arc';
    if (e?.minutes != null) {
      setText(el.big, `${Math.round(e.meters)} m`);
      setText(el.small, `${Math.round(e.minutes)} MIN · ${e.limitedBy === 'Battery' ? 'BATT' : e.limitedBy.toUpperCase()}`);
      cls += e.minutes < 10 ? ' warning' : e.minutes < 30 ? ' caution' : '';
    } else {
      setText(el.big, t ? `${Math.round((t.oxy_pri_storage + t.oxy_sec_storage) / 2)}%` : '--');
      setText(el.small, m.eva?.status?.started ? 'O2 · LEARNING' : 'O2 AVG');
    }
    if (el.arc.getAttribute('class') !== cls) el.arc.setAttribute('class', cls);
  }

  function renderObjective(m) {
    const sc = m.scenario, ph = sc?.phase;
    if (!ph) { setHTML(el.objective, ''); return; }
    const total = sc.phases?.length ?? 0;
    const n = ph.id === 'complete' ? total : (sc.phaseIndex ?? 0) + 1;
    setHTML(el.objective, `<b>${esc(ph.title)}</b><span class="sep">${n}/${total}</span>${esc(ph.objective)}`);
  }

  // ---------------------------------------------------------------- slow parts (~4 Hz)
  function renderStatus(m) {
    const cw = m.cw; if (!cw) return;
    const off = cw.offNominal, nom = cw.items.filter((i) => i.level === 'nominal');
    const row = (i) => `<div class="row ${i.level}"><span class="k">${esc(i.label)}${i.action && i.level !== 'nominal' ? `<span class="act">${esc(i.action)}</span>` : ''}</span><span class="v">${i.flag ? 'FAULT' : esc(fmt(i.value, i.unit))}</span></div>`;
    let html = off.length ? off.map(row).join('') : '<div class="row"><span class="k">All values nominal</span></div>';
    html += `<button class="collapse">${showNominal ? '▾' : '▸'} ${nom.length} values nominal</button>`;
    if (showNominal) html += nom.map(row).join('');
    const d = m.eva?.dcu, u = m.eva?.uia;
    if (d) {
      const sw = (on, l) => `<span class="sw ${on ? 'on' : ''}">${l}</span>`;
      html += `<div class="label">DCU</div><div class="sws">${DCU.map(([, p, a, b]) => sw(true, get(m.eva, p) ? a : b)).join('')}</div>`;
      html += `<div class="label">UIA</div><div class="sws">${UIA.map(([, p, l]) => sw(get(m.eva, p), l)).join('')}</div>`;
    }
    setHTML(panels.status.querySelector('h3 span'), off.length ? `${off.length} off-nominal` : '');
    setHTML(panels.status.querySelector('.body'), html);
  }

  function renderRangePanel(m) {
    const e = m.est, t = m.eva?.telemetry, hab = (m.pois || []).find((p) => p.id === 'hab');
    const rows = [
      ['Return radius', e?.meters != null ? `${Math.round(e.meters)} m` : 'learning…'],
      ['Time to reserve', e?.minutes != null ? `${Math.round(e.minutes)} min` : '—'],
      ['Limited by', e?.limitedBy ?? '—'],
      ['HAB', hab ? `${Math.round(dist(m.pose, hab))} m @ ${Math.round(bearing(m.pose, hab))}°` : '—'],
      ['O2 PRI / SEC', t ? `${fmt(t.oxy_pri_storage, '%')} / ${fmt(t.oxy_sec_storage, '%')}` : '—'],
      ['O2 use', t ? fmt(t.oxy_consumption, 'psi/min') : '—'],
      ['Battery PRI', t ? fmt(t.primary_battery_level, '%') : '—'],
    ];
    setHTML(panels.range.querySelector('.body'), rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${esc(v)}</span></div>`).join('') +
      '<div class="note">Headset estimate: linear O2 and battery burn over the last 5 min, 20 % reserve, 40 m/min out and back. The laptop model refines this when linked.</div>');
  }

  function renderProcedure(m) {
    const pr = m.proc, body = panels.procedure.querySelector('.body');
    const sc = m.scenario?.phase;
    // Outside procedure phases, show the scenario objective / LTV sub-steps instead.
    if (!pr || (pr.done && sc && !sc.procedure)) {
      setHTML(panels.procedure.querySelector('h3 span'), esc(sc?.title ?? ''));
      const st = sc?.step;
      setHTML(body, st ? `<div class="proc-group">${esc(sc.title)}</div><div class="proc-step">${esc(st.text)}</div><div class="proc-hint">say "done" when complete</div>
        <div class="proc-bar"><i style="width:${(100 * st.index) / st.total}%"></i></div><div class="proc-count">step ${st.index + 1} of ${st.total}</div>`
        : `<div class="proc-step">${esc(sc?.objective ?? 'No active procedure')}</div>`);
      return;
    }
    setHTML(panels.procedure.querySelector('h3 span'), esc(pr.def.name));
    if (pr.done) { setHTML(body, `<div class="proc-step">Complete ✓</div><div class="proc-bar"><i style="width:100%"></i></div>`); return; }
    const s = pr.step, total = pr.def.steps.length;
    let hint = s.type === 'manual' ? 'say "done" when complete' : s.type === 'switch' ? 'auto-checks from TSS' : '';
    if (s.type === 'wait' && m.eva) hint = s.all.map((c) => `${c.path.split('.').pop().replace(/_/g, ' ')} ${fmt(get(m.eva, c.path))} ${c.op} ${c.value}`).join(' · ');
    const w = pr.wrong && Date.now() - pr.wrong.at < 15000;
    setHTML(body, `<div class="proc-group">${esc(s.group ?? '')}</div><div class="proc-step">${esc(s.text)}</div><div class="proc-hint">${esc(hint)}</div>
      <div class="proc-bar"><i style="width:${(100 * pr.index) / total}%"></i></div><div class="proc-count">step ${pr.index + 1} of ${total}</div>
      ${w ? `<div class="proc-wrong">⚠ ${esc(pr.wrong.path)} changed — not this step</div>` : ''}
      <ol class="proc-next" start="${pr.index + 2}">${pr.def.steps.slice(pr.index + 1, pr.index + 4).map((x) => `<li>${esc(x.text)}</li>`).join('')}</ol>`);
  }

  const mctx = el.minimap.getContext('2d');
  function renderFind(m) {
    const c = el.minimap, g = mctx, W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);
    const p = m.pose;
    const pts = [p, ...(m.pois || []), ...(m.pins || []), ...(m.route || []), ...(m.trail || []).slice(-1500)].filter(Boolean);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const q of pts) { minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
    const span = Math.max(maxX - minX, maxY - minY, 30), pad = 34;
    const k = Math.min((W - 2 * pad) / span, (H - 2 * pad) / span);
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const X = (x) => W / 2 + (x - cx) * k, Y = (y) => H / 2 - (y - cy) * k;
    // grid every 10 m
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (let gx = Math.floor((cx - W / 2 / k) / 10) * 10; gx < cx + W / 2 / k; gx += 10) { g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), H); g.stroke(); }
    for (let gy = Math.floor((cy - H / 2 / k) / 10) * 10; gy < cy + H / 2 / k; gy += 10) { g.beginPath(); g.moveTo(0, Y(gy)); g.lineTo(W, Y(gy)); g.stroke(); }
    // trail
    const tr = (m.trail || []).slice(-1500);
    g.strokeStyle = 'rgba(123,224,176,.7)'; g.lineWidth = 3; g.setLineDash([6, 6]);
    g.beginPath(); tr.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y)))); g.stroke(); g.setLineDash([]);
    // route
    if (m.route?.length > 1) { g.strokeStyle = '#ffb020'; g.lineWidth = 4; g.beginPath(); m.route.forEach((q, i) => (i ? g.lineTo(X(q.x), Y(q.y)) : g.moveTo(X(q.x), Y(q.y)))); g.stroke(); }
    // pois
    g.font = '600 18px ui-monospace, Menlo, monospace'; g.textAlign = 'left';
    for (const q of m.pois || []) {
      const hab = q.kind === 'lander';
      g.fillStyle = hab ? '#e3efe9' : q.kind === 'geology' ? '#c9a7ff' : '#7be0b0';
      if (hab) g.fillRect(X(q.x) - 8, Y(q.y) - 8, 16, 16); else { g.beginPath(); g.arc(X(q.x), Y(q.y), 7, 0, 7); g.fill(); }
      g.fillStyle = 'rgba(227,239,233,.85)'; g.fillText(q.label, X(q.x) + 12, Y(q.y) + 6);
    }
    for (const q of m.pins || []) {
      g.fillStyle = q.sample ? '#ffb020' : '#e3efe9';
      g.beginPath(); g.moveTo(X(q.x), Y(q.y) - 12); g.lineTo(X(q.x) - 8, Y(q.y) + 4); g.lineTo(X(q.x) + 8, Y(q.y) + 4); g.fill();
    }
    if (m.target) { g.strokeStyle = '#ffb020'; g.lineWidth = 3; g.beginPath(); g.arc(X(m.target.x), Y(m.target.y), 14, 0, 7); g.stroke(); }
    // pose: view cone + arrow
    const a = ((p.heading - 90) * Math.PI) / 180;
    g.fillStyle = 'rgba(123,224,176,.18)';
    g.beginPath(); g.moveTo(X(p.x), Y(p.y)); g.arc(X(p.x), Y(p.y), 60, a - 0.5, a + 0.5); g.fill();
    g.save(); g.translate(X(p.x), Y(p.y)); g.rotate((p.heading * Math.PI) / 180);
    g.fillStyle = '#7be0b0'; g.beginPath(); g.moveTo(0, -16); g.lineTo(10, 11); g.lineTo(0, 5); g.lineTo(-10, 11); g.fill(); g.restore();
    // north + scale bar
    g.fillStyle = '#7be0b0'; g.font = '700 18px ui-monospace, Menlo, monospace'; g.fillText('N ↑', W - 52, 26);
    const sb = [5, 10, 20, 25, 50, 100].find((v) => v * k > 70) || 100;
    g.strokeStyle = '#8fa49d'; g.lineWidth = 3; g.beginPath(); g.moveTo(16, H - 16); g.lineTo(16 + sb * k, H - 16); g.stroke();
    g.fillStyle = '#8fa49d'; g.font = '16px ui-monospace, Menlo, monospace'; g.fillText(`${sb} m`, 18, H - 24);

    const t = m.target;
    setHTML(panels.find.querySelector('h3 span'), esc(t?.label ?? ''));
    setHTML(el.findinfo, t ? `${Math.round(dist(p, t))} m · ${Math.round(bearing(p, t))}°<small>${m.route?.length > 1 ? 'route avoids slopes over 15°' : 'no route — direct bearing'}</small>`
      : `${(m.pins || []).length} pins · ${(m.trail || []).length} breadcrumbs<small>say "find HAB", "find LTV", "find sample"</small>`);
  }

  function renderDev(m) {
    if (!el.dev.open) return;
    for (const b of el.dev.querySelectorAll('[data-path]')) {
      const v = get(m.eva, b.dataset.path) === true;
      b.classList.toggle('on', v);
      if (b.dataset.on) setText(b, v ? b.dataset.on : b.dataset.off);
    }
    const act = new Set(m.faults || []);
    for (const b of el.dev.querySelectorAll('[data-fault]')) b.classList.toggle('bad', act.has(b.dataset.fault));
    if (el.sync.checked !== !!m.syncToTss) el.sync.checked = !!m.syncToTss;
  }

  // ---------------------------------------------------------------- update
  function update(m) {
    model = m;
    drawHeading(m);
    renderAlert(m);
    renderLink(m);
    renderRange(m);
    renderObjective(m);
    const now = performance.now();
    if (now - lastSlow < SLOW_MS) return;
    lastSlow = now;
    if (isOpen('status')) renderStatus(m);
    if (isOpen('range')) renderRangePanel(m);
    if (isOpen('procedure')) renderProcedure(m);
    if (isOpen('find')) renderFind(m);
    renderDev(m);
  }

  return { update, toast, show, hideAll, tour, get model() { return model; } };
}

const clock = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;

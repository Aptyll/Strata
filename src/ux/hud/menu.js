// Structure of the Esc settings menu: a summary header, a top row of page tabs,
// and inside each page a second row of section tabs. index.js still builds the
// controls (rows); this file only decides where each group of rows lives and
// keeps the header's at-a-glance numbers fresh. Dependency-free, like index.js.
//
//   +--------------------------------------+
//   |  60 fps   16.7 ms         /\_/\__/\  |  summary header (#strata-menu-summary)
//   |  4.19M simulating  8M stored  32 pl  |
//   |  1920x1080  theme red  boids         |
//   |  scene behaviors look themes perf .. |  page tabs   (role=tablist)
//   |  world  share                        |  section tabs (role=tablist, 2+ sections)
//   |  particles ----|--------             |  the selected section's rows
//   |  reset            stats       ? keys |  footer (index.js)
//   +--------------------------------------+
//
// Accessibility behavior that is not structure (dialog role, focus on open and
// close, focus rings, type scale) is attached separately; see a11y.js.

import { formatCount, formatExact } from './format.js';

/**
 * Pages in tab order. A param lands on a page by its `page` field, else by its
 * `group` through this table, else on "more". A page with no rows hides its tab.
 */
export const PAGES = [
  { id: 'scene', label: 'scene', groups: ['', 'scene', 'world', 'share'] },
  { id: 'behaviors', label: 'behaviors', groups: ['behaviors', 'behavior'] },
  { id: 'look', label: 'look', groups: ['look', 'render', 'depth'] },
  { id: 'themes', label: 'themes', groups: ['theme', 'themes', 'color', 'colour'] },
  { id: 'perf', label: 'perf', groups: ['performance', 'perf', 'display'] },
  { id: 'capture', label: 'capture', groups: ['capture', 'record'] },
  { id: 'more', label: 'more', groups: [] },
];

/** Section tab names for groups whose own name is empty or terse. */
const SECTION_LABELS = { '': 'world', performance: 'frame rate', theme: 'color' };

const FPS_SAMPLES = 120; // 30 s of history at 4 samples a second
const SAMPLE_MS = 250;

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'main';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Wire Left/Right/Home/End across a tablist with automatic activation.
 * Calls preventDefault on keys it handles; never stops propagation.
 * @param {HTMLElement} list
 * @param {(tab: HTMLElement) => void} select
 */
const rove = (list, select) => {
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role=tab]')].filter((t) => !t.hidden);
    const i = tabs.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (i < 0) return;
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (next == null) return;
    e.preventDefault();
    const t = tabs[(next + tabs.length) % tabs.length];
    select(t);
    t.focus();
  });
};

/**
 * @param {Object} src
 * @param {(key: string) => any} src.stat       Current value of a HUD stat ('fps', 'particles', 'total', ...).
 * @param {(id: string) => any} src.param       Current value of a param ('theme', 'targetFps', ...).
 * @param {() => [number, number] | null} [src.resolution]  Drawing buffer size in pixels.
 * @param {string | false} [src.persist]        localStorage key prefix for the last page shown.
 */
export function createMenu(src) {
  const store = src.persist ? src.persist + '.page' : null;
  let remembered = {};
  if (store) { try { remembered = JSON.parse(localStorage.getItem(store) || '{}') || {}; } catch { remembered = {}; } }
  const remember = () => {
    if (!store) return;
    try { localStorage.setItem(store, JSON.stringify({ page: wanted, sections: Object.fromEntries([...pages].map(([id, p]) => [id, p.selected])) })); } catch { /* private mode */ }
  };

  // ---- summary header ---------------------------------------------------
  const summary = el('header', 'sm-summary');
  summary.id = 'strata-menu-summary';
  summary.setAttribute('aria-label', 'Live summary');
  const top = el('div', 'sm-top');
  const fpsBox = el('div', 'sm-fps');
  const fpsNum = el('b', 'sm-fps-num', '-');
  const fpsUnit = el('i', null, 'fps');
  const msEl = el('span', 'sm-ms', '');
  msEl.title = 'Frame time, from the measured frame rate';
  fpsBox.append(fpsNum, fpsUnit, msEl);
  const graph = /** @type {HTMLCanvasElement} */ (el('canvas', 'sm-graph'));
  graph.setAttribute('role', 'img');
  graph.setAttribute('aria-label', 'Frame rate over the last 30 seconds');
  top.append(fpsBox, graph);
  const facts = el('dl', 'sm-facts');
  /** @type {Map<string, {dt: HTMLElement, dd: HTMLElement, shown: string}>} */
  const factEls = new Map();
  const fact = (key, label, title) => {
    const dd = el('dd');
    const dt = el('dt', null, label);
    const wrap = el('div', 'sm-fact');
    wrap.dataset.fact = key;
    if (title) wrap.title = title;
    wrap.append(dd, dt);
    facts.append(wrap);
    factEls.set(key, { dt: wrap, dd, shown: '' });
  };
  fact('particles', 'simulating', 'Particles the GPU stepped and drew last frame (realtime, stored state)');
  fact('total', 'stored', 'Particles held in GPU memory; the frame-rate governor may draw fewer');
  fact('planes', 'planes');
  fact('resolution', 'pixels', 'Drawing buffer size');
  fact('theme', 'theme');
  fact('behavior', 'behavior');
  summary.append(top, facts);

  // ---- page tabs and pages ----------------------------------------------
  const tabs = el('div', 'sm-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Settings pages');
  const body = el('div', 'sm-pages');

  /**
   * @typedef {{ name: string, tab: HTMLElement, panel: HTMLElement, group: HTMLElement }} Section
   * @typedef {{ id: string, tab: HTMLElement, panel: HTMLElement, subtabs: HTMLElement, sections: Map<string, Section>, selected: string | null }} Page
   */
  /** @type {Map<string, Page>} */
  const pages = new Map();
  // `wanted` is the page the visitor last chose; `current` is what is shown, which can differ
  // while the wanted page has no rows yet (params register a few at a time during boot).
  let wanted = remembered.page || PAGES[0].id;
  let current = wanted;
  let serial = 0;

  for (const def of PAGES) {
    const tab = el('button', 'sm-tab', def.label);
    tab.type = 'button';
    tab.id = 'sm-tab-' + def.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'sm-page-' + def.id);
    tab.hidden = true;
    tab.addEventListener('click', () => choosePage(def.id));
    tabs.append(tab);
    const panel = el('section', 'sm-page');
    panel.id = 'sm-page-' + def.id;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.hidden = true;
    const subtabs = el('div', 'sm-subtabs');
    subtabs.setAttribute('role', 'tablist');
    subtabs.setAttribute('aria-label', def.label + ' sections');
    subtabs.hidden = true;
    panel.append(subtabs);
    body.append(panel);
    const page = { id: def.id, tab, panel, subtabs, sections: new Map(), selected: remembered.sections?.[def.id] ?? null };
    pages.set(def.id, page);
    rove(subtabs, (t) => showSection(page, t.dataset.section));
  }
  rove(tabs, (t) => choosePage(t.id.slice('sm-tab-'.length)));

  const pageFor = (group, page) => {
    if (page && pages.has(page)) return page;
    const g = String(group || '').toLowerCase();
    return (PAGES.find((p) => p.groups.includes(g)) || PAGES[PAGES.length - 1]).id;
  };

  const showSection = (page, name) => {
    if (!page.sections.has(name)) name = page.sections.keys().next().value ?? null;
    page.selected = name;
    for (const [n, s] of page.sections) {
      const on = n === name;
      s.tab.setAttribute('aria-selected', String(on));
      s.tab.tabIndex = on ? 0 : -1;
      s.panel.hidden = !on;
    }
    remember();
  };

  const visiblePages = () => PAGES.map((p) => pages.get(p.id)).filter((p) => p.sections.size > 0);

  /** Select a page by id. Falls back to the first page that has rows. */
  const showPage = (id) => {
    let page = pages.get(id);
    if (!page || !page.sections.size) page = visiblePages()[0];
    if (!page) return;
    current = page.id;
    for (const p of pages.values()) {
      const on = p === page;
      p.tab.setAttribute('aria-selected', String(on));
      p.tab.tabIndex = on ? 0 : -1;
      p.panel.hidden = !on;
    }
    showSection(page, page.selected);
  };
  /** A visitor's pick: remembered, and kept as the goal while pages fill in. */
  const choosePage = (id) => { wanted = id; showPage(id); remember(); };

  const refreshPage = (page) => {
    const has = page.sections.size > 0;
    page.tab.hidden = !has;
    const multi = page.sections.size > 1;
    page.subtabs.hidden = !multi;
    page.panel.classList.toggle('has-sub', multi);
    if (page.id === wanted || page.id === current || !pages.get(current)?.sections.size) showPage(wanted);
    else showSection(page, page.selected);
  };

  /**
   * Put a group's element on its page as a section. Called by index.js when a
   * group is created; returns nothing, the element is moved into the menu.
   * @param {HTMLElement} groupNode  The .sh-group element holding the rows.
   * @param {string} name            Group name ('' for ungrouped).
   * @param {string} [pageId]        Explicit page, overriding the group table.
   */
  const place = (groupNode, name, pageId) => {
    const page = pages.get(pageFor(name, pageId));
    const key = name || '';
    const n = serial++;
    const tab = el('button', 'sm-subtab', SECTION_LABELS[key] ?? (key || 'general'));
    tab.type = 'button';
    tab.id = `sm-sub-${page.id}-${n}`;
    tab.dataset.section = key;
    tab.setAttribute('role', 'tab');
    const panel = el('div', 'sm-section');
    panel.id = `sm-sec-${page.id}-${n}-${slug(key)}`;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('click', () => showSection(page, key));
    panel.append(groupNode);
    // Ungrouped rows lead their page, as they led the old single list.
    if (key === '') { page.subtabs.prepend(tab); page.subtabs.after(panel); } else { page.subtabs.append(tab); page.panel.append(panel); }
    page.sections.set(key, { name: key, tab, panel, group: groupNode });
    refreshPage(page);
  };

  /** Drop a group's section (its last row was removed). */
  const unplace = (name) => {
    const key = name || '';
    for (const page of pages.values()) {
      const s = page.sections.get(key);
      if (!s) continue;
      s.tab.remove();
      s.panel.remove();
      page.sections.delete(key);
      refreshPage(page);
      return;
    }
  };

  // ---- live numbers -----------------------------------------------------
  const history = new Float32Array(FPS_SAMPLES);
  let filled = 0;
  let head = 0;
  let lastSample = 0;
  let open = false;

  const setFact = (key, text) => {
    const f = factEls.get(key);
    if (!f) return;
    const t = text == null || text === '' ? '' : String(text);
    f.dt.hidden = !t;
    if (t !== f.shown) { f.shown = t; f.dd.textContent = t; }
  };

  const drawGraph = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.round((graph.clientWidth || 120) * dpr);
    const h = Math.round((graph.clientHeight || 28) * dpr);
    if (graph.width !== w) graph.width = w;
    if (graph.height !== h) graph.height = h;
    const g = graph.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    if (filled < 2) return;
    const fg = getComputedStyle(graph).color || '#fff';
    const target = Number(src.param('targetFps')) || 60;
    let top = target * 1.25;
    for (let i = 0; i < filled; i++) top = Math.max(top, history[i]);
    const y = (v) => h - 1 - (Math.max(0, v) / top) * (h - 2);
    // Target line, dashed and faint.
    g.globalAlpha = 0.35;
    g.strokeStyle = fg;
    g.lineWidth = dpr;
    g.setLineDash([2 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(0, y(target)); g.lineTo(w, y(target)); g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 0.9;
    g.beginPath();
    const step = w / (FPS_SAMPLES - 1);
    const start = FPS_SAMPLES - filled;
    for (let i = 0; i < filled; i++) {
      const v = history[(head - filled + i + FPS_SAMPLES) % FPS_SAMPLES];
      const x = (start + i) * step;
      if (i) g.lineTo(x, y(v)); else g.moveTo(x, y(v));
    }
    g.stroke();
    g.globalAlpha = 1;
  };

  const paintSummary = () => {
    const fps = Number(src.stat('fps'));
    const has = Number.isFinite(fps) && fps > 0;
    fpsNum.textContent = has ? String(Math.round(fps)) : '-';
    msEl.textContent = has ? (1000 / fps).toFixed(1) + ' ms' : '';
    const n = (k) => { const v = src.stat(k); return typeof v === 'number' && Number.isFinite(v) ? v : null; };
    const particles = n('particles');
    const total = n('total');
    setFact('particles', particles == null ? '' : formatCount(particles));
    factEls.get('particles').dt.title = particles == null ? '' : formatExact(particles) + ' particles simulated last frame';
    setFact('total', total == null || total === particles ? '' : formatCount(total));
    setFact('planes', n('planes') == null ? '' : String(n('planes')));
    const res = src.resolution?.();
    setFact('resolution', res ? `${res[0]}×${res[1]}` : '');
    const theme = src.param('theme');
    setFact('theme', theme == null ? '' : String(theme));
    const behavior = src.stat('behavior');
    setFact('behavior', behavior == null ? '' : String(behavior));
    drawGraph();
  };

  /** Call every frame (cheap): samples fps a few times a second, repaints only while open. */
  const update = (now) => {
    if (now - lastSample < SAMPLE_MS) return;
    lastSample = now;
    const fps = Number(src.stat('fps'));
    if (Number.isFinite(fps) && fps > 0) {
      history[head] = fps;
      head = (head + 1) % FPS_SAMPLES;
      filled = Math.min(FPS_SAMPLES, filled + 1);
    }
    if (open) paintSummary();
    if (corner) paintCorner();
  };

  /** Tell the menu whether it is on screen, so it repaints at once on open and idles when closed. */
  const setOpen = (on) => {
    open = !!on;
    if (open) { showPage(wanted); paintSummary(); }
  };

  // ---- optional corner readout: fps and frame time, top left -------------
  let corner = null;
  const paintCorner = () => {
    const fps = Number(src.stat('fps'));
    corner.textContent = Number.isFinite(fps) && fps > 0 ? `${Math.round(fps)} fps  ${(1000 / fps).toFixed(1)} ms` : '- fps';
  };
  /**
   * Show or hide the always-on fps readout in the top-left corner.
   * @param {HTMLElement} host  The HUD root.
   * @param {boolean} on
   */
  const setCorner = (host, on) => {
    if (on && !corner) {
      corner = el('div', 'sm-corner');
      corner.setAttribute('aria-hidden', 'true'); // visual readout; the summary header carries the same number
      host.append(corner);
      paintCorner();
    } else if (!on && corner) {
      corner.remove();
      corner = null;
    }
  };

  return {
    /** Nodes to put in the panel, in order, before the footer. */
    nodes: [summary, tabs, body],
    place,
    unplace,
    update,
    setOpen,
    setCorner,
    showPage: choosePage,
    get page() { return current; },
  };
}

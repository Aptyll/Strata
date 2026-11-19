// Strata HUD: a near-invisible overlay for a black-void particle sim.
// Dependency-free ES module. See docs/ux/hud.md for the design and full API.
//
//   import { createHud } from './ux/hud/index.js';
//   const hud = createHud();
//   hud.setStat('particles', 4_000_000);
//   hud.registerParam({ id: 'bloom', label: 'Bloom', min: 0, max: 2, step: 0.01, value: 0.6,
//                       onChange: v => engine.bloom = v });

import { CSS } from './styles.js';
import { formatCount, formatExact, formatValue, formatTime, decimalsFor } from './format.js';

export { formatCount, formatExact, formatValue, formatTime };

/**
 * @typedef {Object} HudOptions
 * @property {HTMLElement} [parent]       Element to overlay. Default document.body.
 * @property {number}  [idleMs=2500]      Fade out after this long without input. 0 disables.
 * @property {boolean} [hideCursor=true]  Hide the mouse cursor over the parent while idle.
 * @property {HudTokens} [tokens]         Pass TOKENS from src/core/contracts.ts so the HUD follows the shared design tokens.
 * @property {boolean} [stats=false]      Show the stats line on load. Off by default: the page opens on the simulation alone.
 * @property {boolean} [dice=true]        Show the randomize dice.
 * @property {number}  [diceHintMs=6000]  On a first visit, start a slow pulse on the die after this long, until the first roll. 0 disables.
 * @property {(roll:{seed:number, face:number})=>any} [onRandomize]  Called on every roll. See hud.onRandomize.
 * @property {boolean} [autoFps=true]     Measure fps from requestAnimationFrame until the engine calls setStat('fps', n).
 * @property {boolean} [announce=true]    Announce the plane name in the centre when the 'plane' stat changes.
 * @property {string|false} [persist='strata.hud']  localStorage key for param values, or false.
 * @property {boolean} [shortcuts=true]   Install the built-in keyboard shortcuts.
 * @property {boolean} [panelOpen=false]  Start with the settings panel open.
 * @property {EventTarget} [keyTarget]    Where to listen for keys. Default window.
 *
 * @typedef {Object} HudTokens  Structural match for TOKENS in src/core/contracts.ts. Every field is optional.
 * @property {{background?: string, foreground?: string}} [color]
 * @property {string} [font]
 * @property {string} [letterSpacing]
 * @property {number} [opacityStrong]
 * @property {number} [opacityDim]
 * @property {string} [easing]
 * @property {number} [durationMs]
 * @property {number} [unit]
 *
 * @typedef {Object} ParamSpec
 * @property {string} id
 * @property {string} [label]             Defaults to id.
 * @property {'range'|'toggle'|'select'|'action'} [type]  Inferred from value/options/run when omitted.
 * @property {string} [group]             Section heading. Params without one go first.
 * @property {number|boolean|string} [value]
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {'linear'|'log'} [scale]     'log' suits counts spanning orders of magnitude (min must be > 0).
 * @property {Array<string|{value:string,label:string}>} [options]  For select.
 * @property {(v:any)=>string} [format]   Readout formatter for range.
 * @property {(v:any, id:string)=>void} [onChange]
 * @property {()=>void} [run]             For action.
 * @property {boolean} [live=true]        Range: fire onChange while dragging. false fires on release only
 *                                        (use for expensive changes such as reallocating particle buffers).
 * @property {boolean} [persist=true]
 *
 * @typedef {Object} ShortcutSpec
 * @property {string} key                 e.g. 'g', '?', 'space', 'arrowleft', '['. Case-insensitive.
 * @property {string} label               Shown in the help overlay.
 * @property {(e:KeyboardEvent)=>void} run
 * @property {boolean} [hidden]           Leave out of the help overlay.
 */

const STYLE_ID = 'strata-hud-style';
const STAT_FLUSH_MS = 200;

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const normKey = (k) => (k === ' ' ? 'space' : String(k).toLowerCase());
const KEY_NAMES = { space: 'space', arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓', escape: 'esc' };

// '#fff' or '#ffffff' -> '255, 255, 255', the form the stylesheet's rgba() calls need.
const toRgbTriplet = (hex) => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ');
};

/**
 * Create the HUD and attach it to the page.
 * @param {HudOptions} [options]
 */
export function createHud(options = {}) {
  const opt = {
    parent: document.body, idleMs: 2500, hideCursor: true, autoFps: true, announce: true,
    persist: 'strata.hud', shortcuts: true, panelOpen: false, keyTarget: window,
    stats: false, dice: true, onRandomize: null, diceHintMs: 6000,
    ...options,
  };
  const parent = opt.parent;

  if (!document.getElementById(STYLE_ID)) {
    const style = el('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- DOM skeleton ------------------------------------------------------
  const root = el('div', 'strata-hud');
  if (parent === document.body) root.classList.add('is-fixed');
  else if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';

  // Map the shared design tokens onto the stylesheet's custom properties.
  const tk = opt.tokens;
  if (tk) {
    const set = (name, v) => { if (v != null) root.style.setProperty(name, String(v)); };
    set('--hud-fg', toRgbTriplet(tk.color?.foreground));
    set('--hud-bg', toRgbTriplet(tk.color?.background));
    set('--hud-font', tk.font);
    set('--hud-tracking', tk.letterSpacing);
    set('--hud-a-strong', tk.opacityStrong);
    set('--hud-a-dim', tk.opacityDim);
    set('--hud-ease', tk.easing);
    if (tk.durationMs != null) set('--hud-fade-in', tk.durationMs + 'ms');
    if (tk.unit != null) set('--hud-unit', tk.unit + 'px');
  }

  const left = el('div', 'sh-stats sh-left');
  const right = el('div', 'sh-stats sh-right');
  const announceEl = el('div', 'sh-announce');
  const aTitle = el('div', 'sh-a-title');
  const aSub = el('div', 'sh-a-sub');
  announceEl.append(aTitle, aSub);
  announceEl.setAttribute('aria-live', 'polite');
  const panel = el('div', 'sh-panel');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Settings');
  const groupsEl = el('div');
  const foot = el('div', 'sh-foot');
  const resetBtn = el('button', null, 'reset');
  resetBtn.type = 'button';
  const statsBtn = el('button', null, 'stats');
  statsBtn.type = 'button';
  statsBtn.setAttribute('aria-pressed', 'false');
  const hint = el('button', null, '? keys');
  hint.type = 'button';
  foot.append(resetBtn, statsBtn, hint);
  panel.append(groupsEl, foot);
  const dot = el('button', 'sh-dot');
  dot.type = 'button';
  dot.setAttribute('aria-label', 'Settings');
  dot.title = 'Settings (Esc)';
  // The die: a square and the seven pip positions a d6 ever uses.
  const SVG = 'http://www.w3.org/2000/svg';
  const dice = el('button', 'sh-dice');
  dice.type = 'button';
  dice.setAttribute('aria-label', 'Randomize');
  dice.title = 'Randomize (R)';
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('aria-hidden', 'true');
  const face = document.createElementNS(SVG, 'rect');
  for (const [k, v] of Object.entries({ x: 2.5, y: 2.5, width: 23, height: 23, rx: 4 })) face.setAttribute(k, v);
  svg.append(face);
  //            0 TL     1 TR      2 ML      3 C        4 MR      5 BL      6 BR
  const PIPS = [[8.5, 8.5], [19.5, 8.5], [8.5, 14], [14, 14], [19.5, 14], [8.5, 19.5], [19.5, 19.5]].map(([cx, cy]) => {
    const c = document.createElementNS(SVG, 'circle');
    c.setAttribute('cx', cx); c.setAttribute('cy', cy); c.setAttribute('r', 1.7);
    svg.append(c);
    return c;
  });
  const FACES = [[3], [0, 6], [0, 3, 6], [0, 1, 5, 6], [0, 1, 3, 5, 6], [0, 1, 2, 4, 5, 6]];
  dice.append(svg);
  if (!opt.dice) dice.hidden = true;
  const help = el('div', 'sh-help');
  const helpList = el('dl');
  help.append(helpList);
  const jobEl = el('div', 'sh-job');
  jobEl.setAttribute('role', 'status');
  const jobText = el('div', 'sh-job-text');
  const jobBar = el('div', 'sh-job-bar');
  jobBar.append(el('i'));
  jobEl.append(jobText, jobBar);
  const messageEl = el('div', 'sh-message');
  messageEl.setAttribute('role', 'status');
  root.append(left, right, announceEl, jobEl, messageEl, panel, dot, dice, help);
  parent.appendChild(root);

  const listeners = { change: new Set(), panel: new Set(), stats: new Set(), randomize: new Set(), job: new Set() };
  const emit = (type, ...args) => listeners[type].forEach((fn) => { try { fn(...args); } catch (e) { console.error(e); } });
  const disposers = [];
  const listen = (target, type, fn, o) => { target.addEventListener(type, fn, o); disposers.push(() => target.removeEventListener(type, fn, o)); };

  // ---- stats -------------------------------------------------------------
  /** @type {Map<string, any>} */
  const stats = new Map();
  const defineStat = (key, def = {}) => {
    let s = stats.get(key);
    if (!s) {
      s = { key, node: el('span', 'sh-stat'), value: undefined, shown: undefined, dirty: false };
      s.node.dataset.stat = key;
      stats.set(key, s);
    } else if (def.slot && def.slot !== s.slot) s.node.remove();
    Object.assign(s, { label: key, slot: 'left', format: null, ...def });
    if (!s.node.parentNode) (s.slot === 'right' ? right : left).appendChild(s.node);
    s.shown = undefined;
    s.dirty = true;
    return s;
  };
  defineStat('particles', { label: '', format: formatCount, title: (v) => formatExact(v) + ' particles' });
  defineStat('planes', { label: 'planes' });
  defineStat('time', { label: '', format: formatTime });
  defineStat('fps', { label: 'fps', format: (v) => String(Math.round(v)) });
  defineStat('plane', { label: '', slot: 'right' });
  defineStat('behavior', { label: '', slot: 'right' });

  let fpsManual = false;
  let timeManual = false;
  let timeStart = performance.now();
  const resetTimer = () => { timeStart = performance.now(); };
  const setStat = (key, value) => {
    const s = stats.get(key) || defineStat(key);
    if (key === 'fps') fpsManual = true;
    if (key === 'time') timeManual = true;
    if (s.value === value) return;
    const prev = s.value;
    s.value = value;
    s.dirty = true;
    if (key === 'plane' && opt.announce && prev !== undefined && value != null) {
      // Wait a tick so a behaviour name set in the same frame lands in the subtitle.
      queueMicrotask(() => announce(String(value), stats.get('behavior').value));
    }
  };
  const flushStats = () => {
    for (const s of stats.values()) {
      if (!s.dirty) continue;
      s.dirty = false;
      const v = s.value;
      if (v == null || v === '') { s.node.textContent = ''; s.shown = undefined; continue; }
      const text = s.format && typeof v === 'number' ? s.format(v) : String(v);
      if (text !== s.shown) {
        s.shown = text;
        s.node.textContent = '';
        s.node.append(el('b', null, text));
        if (s.label) s.node.append(el('i', null, s.label));
      }
      if (s.title && typeof v === 'number') s.node.title = s.title(v);
    }
  };

  // ---- message: loading, unsupported browser, errors -------------------------
  /** Show a centred message until cleared with message(null). Newlines are kept. */
  const message = (text) => {
    messageEl.textContent = text == null ? '' : String(text);
    root.classList.toggle('has-message', !!messageEl.textContent);
  };

  // ---- status line and jobs (long renders, exports) ---------------------------
  let statusTimer = 0;
  /**
   * One quiet line at the bottom centre, in place of the die. Pass holdMs to
   * have it fade by itself, or status(null) to clear it.
   */
  const status = (text, holdMs = 0) => {
    clearTimeout(statusTimer);
    const on = text != null && text !== '';
    if (on) jobText.textContent = String(text);
    root.classList.toggle('has-status', on);
    if (on && holdMs > 0) statusTimer = setTimeout(() => status(null), holdMs);
  };
  const setProgress = (fraction) => {
    const show = typeof fraction === 'number' && Number.isFinite(fraction);
    root.classList.toggle('has-progress', show);
    if (show) jobBar.firstChild.style.transform = `scaleX(${Math.min(1, Math.max(0, fraction))})`;
  };

  /** @type {{ id: string, abort: AbortController } | null} */
  let activeJob = null;
  /**
   * Add a menu action that launches a long-running job, such as an offline
   * render. One job runs at a time. While it runs the die gives way to a
   * progress line, the action reads "cancel ...", and pressing it (or
   * Escape with the menu closed) aborts the job's signal.
   *
   * run({ signal, progress }) does the work. Call progress(fraction, text)
   * as often as you like. Resolve with a string to show it as the closing line.
   * Throw to report a failure; an AbortError is shown as "cancelled".
   */
  const registerJob = (spec) => {
    const label = spec.label || spec.id;
    const start = () => {
      if (activeJob) {
        if (activeJob.id === spec.id) activeJob.abort.abort();
        else status('another job is running', 2500);
        return;
      }
      const abort = new AbortController();
      activeJob = { id: spec.id, abort };
      const button = params.get(spec.id)?.input;
      if (button) button.textContent = 'cancel ' + label;
      root.classList.add('has-job');
      status(label);
      setProgress(0);
      emit('job', spec.id, true);
      const progress = (fraction, text) => {
        if (activeJob?.abort !== abort) return;
        setProgress(fraction);
        if (text != null) status(text);
      };
      const finish = (text) => {
        activeJob = null;
        root.classList.remove('has-job');
        setProgress(null);
        const b = params.get(spec.id)?.input;
        if (b) b.textContent = label;
        status(text, 5000);
        emit('job', spec.id, false);
      };
      Promise.resolve()
        .then(() => spec.run({ signal: abort.signal, progress }))
        .then(
          (result) => finish(typeof result === 'string' ? result : label + ' done'),
          (err) => {
            if (abort.signal.aborted || err?.name === 'AbortError') return finish(label + ' cancelled');
            console.error(err);
            finish(`${label} failed: ${err?.message ?? err}`);
          },
        );
    };
    registerParam({ id: spec.id, label, group: spec.group, type: 'action', run: start });
    return { id: spec.id, start, cancel: () => { if (activeJob?.id === spec.id) activeJob.abort.abort(); }, remove: () => removeParam(spec.id) };
  };

  // ---- announce ----------------------------------------------------------
  let announceTimer = 0;
  const announce = (title, sub, holdMs = 1800) => {
    aTitle.textContent = title;
    aSub.textContent = sub == null ? '' : String(sub);
    aSub.style.display = sub ? '' : 'none';
    announceEl.classList.add('is-on');
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => announceEl.classList.remove('is-on'), holdMs);
  };

  // ---- persistence -------------------------------------------------------
  let saved = {};
  if (opt.persist) {
    try { saved = JSON.parse(localStorage.getItem(opt.persist) || '{}') || {}; } catch { saved = {}; }
  }
  let saveTimer = 0;
  const save = () => {
    if (!opt.persist) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // Start from what was loaded so params that are not registered yet keep their saved value.
      const out = { ...saved };
      for (const p of params.values()) {
        if (p.persist === false || p.type === 'action') continue;
        if (p.value !== p.initial) out[p.id] = p.value; else delete out[p.id];
      }
      saved = out;
      try { localStorage.setItem(opt.persist, JSON.stringify(out)); } catch { /* private mode, quota */ }
    }, 300);
  };

  // ---- params ------------------------------------------------------------
  /** @type {Map<string, any>} */
  const params = new Map();
  const groups = new Map();
  const groupEl = (name = '') => {
    let g = groups.get(name);
    if (!g) {
      g = el('div', 'sh-group');
      if (name) g.append(el('div', 'sh-group-title', name));
      groups.set(name, g);
      // Ungrouped params always sit at the top.
      if (name === '') groupsEl.prepend(g); else groupsEl.append(g);
    }
    return g;
  };

  const clampRange = (p, v) => {
    v = Number(v);
    if (!Number.isFinite(v)) return p.value;
    if (p.step) v = Math.round((v - p.min) / p.step) * p.step + p.min;
    v = Math.min(p.max, Math.max(p.min, v));
    return Number(v.toFixed(Math.min(decimalsFor(p.step) + 2, 10)));
  };
  // Slider position 0..1 <-> value, linear or log.
  const toT = (p, v) => (p.scale === 'log'
    ? Math.log(v / p.min) / Math.log(p.max / p.min)
    : (v - p.min) / (p.max - p.min));
  const fromT = (p, t) => (p.scale === 'log'
    ? p.min * Math.pow(p.max / p.min, t)
    : p.min + (p.max - p.min) * t);

  const coerce = (p, v) => {
    if (p.type === 'range') return clampRange(p, v);
    if (p.type === 'toggle') return !!v;
    if (p.type === 'select') return p.options.some((o) => o.value === v) ? v : p.value;
    return v;
  };

  const paint = (p) => {
    if (p.type === 'range') {
      const t = Math.min(1, Math.max(0, toT(p, p.value)));
      p.input.value = String(t);
      p.input.style.setProperty('--p', (t * 100).toFixed(2) + '%');
      const text = p.format ? p.format(p.value) : formatValue(p.value, p.step);
      p.readout.textContent = text;
      p.input.setAttribute('aria-valuetext', text);
    } else if (p.type === 'toggle') {
      p.input.setAttribute('aria-checked', String(p.value));
    } else if (p.type === 'select') {
      p.input.value = p.value;
    }
    p.row.classList.toggle('is-changed', p.type !== 'action' && p.value !== p.initial);
  };

  const commit = (p, raw, { silent = false, notify = true } = {}) => {
    // The engine echoing its own value must not yank a slider the person is still dragging.
    // Without this, a live: false range snapped back on every stats refresh mid-drag, and a
    // release after holding still for a moment committed nothing.
    if (silent && p.pending) return p.value;
    const v = coerce(p, raw);
    const changed = v !== p.value;
    p.value = v;
    paint(p);
    if (!changed && !p.pending) return v;
    if (!notify) { p.pending = true; return v; } // dragging a non-live range
    p.pending = false;
    save();
    if (!silent) {
      if (p.onChange) { try { p.onChange(v, p.id); } catch (e) { console.error(e); } }
      emit('change', p.id, v);
    }
    return v;
  };

  /**
   * Add a control to the settings panel. Returns a handle.
   * If a persisted value differs from spec.value, onChange fires once, synchronously.
   * @param {ParamSpec} spec
   */
  const registerParam = (spec) => {
    if (!spec || !spec.id) throw new Error('registerParam: id is required');
    if (params.has(spec.id)) removeParam(spec.id);
    const type = spec.type
      || (spec.run ? 'action' : spec.options ? 'select' : typeof spec.value === 'boolean' ? 'toggle' : 'range');
    const p = { label: spec.id, live: true, ...spec, type };
    const row = el(type === 'action' ? 'div' : 'label', 'sh-row sh-' + type);
    row.dataset.param = p.id;
    p.row = row;

    if (type === 'range') {
      p.min = p.min ?? 0;
      p.max = p.max ?? 1;
      if (p.scale === 'log' && !(p.min > 0)) throw new Error(`registerParam(${p.id}): log scale needs min > 0`);
      if (p.step == null) p.step = p.scale === 'log' ? 0 : (p.max - p.min) / 100;
      p.value = p.initial = clampRange({ ...p, value: p.min }, p.value ?? p.min);
      const input = el('input');
      input.type = 'range';
      input.min = '0'; input.max = '1'; input.step = 'any';
      p.input = input;
      p.readout = el('span', 'sh-value');
      row.append(el('span', 'sh-label', p.label), p.readout, input);
      input.addEventListener('input', () => commit(p, fromT(p, Number(input.value)), { notify: p.live }));
      input.addEventListener('change', () => commit(p, fromT(p, Number(input.value))));
      // Arrow keys move by one step (or 1% on stepless/log scales); shift moves 10x.
      input.addEventListener('keydown', (e) => {
        const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const mult = e.shiftKey ? 10 : 1;
        const next = p.scale === 'log' || !p.step
          ? fromT(p, Math.min(1, Math.max(0, toT(p, p.value) + dir * 0.01 * mult)))
          : p.value + dir * p.step * mult;
        commit(p, next);
      });
    } else if (type === 'toggle') {
      p.value = p.initial = !!p.value;
      const input = el('button', 'sh-switch');
      input.type = 'button';
      input.setAttribute('role', 'switch');
      input.setAttribute('aria-label', p.label);
      p.input = input;
      row.append(el('span', 'sh-label', p.label), input);
      input.addEventListener('click', () => commit(p, !p.value));
    } else if (type === 'select') {
      p.options = (p.options || []).map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
      p.value = p.initial = p.options.some((o) => o.value === p.value) ? p.value : p.options[0]?.value;
      const input = el('select');
      for (const o of p.options) {
        const node = el('option', null, o.label);
        node.value = o.value;
        input.append(node);
      }
      p.input = input;
      row.append(el('span', 'sh-label', p.label), input);
      input.addEventListener('change', () => commit(p, input.value));
    } else {
      const input = el('button', 'sh-act', p.label);
      input.type = 'button';
      p.input = input;
      row.append(input);
      input.addEventListener('click', () => { try { (p.run || p.onChange)?.(); } catch (e) { console.error(e); } });
    }

    // Double-click a label to put the param back to its default.
    if (type !== 'action') {
      row.firstChild.addEventListener('dblclick', (e) => { e.preventDefault(); commit(p, p.initial); });
    }

    groupEl(p.group).append(row);
    params.set(p.id, p);
    paint(p);
    if (p.persist !== false && type !== 'action' && Object.prototype.hasOwnProperty.call(saved, p.id)) {
      commit(p, saved[p.id]);
    }
    return {
      id: p.id,
      get: () => p.value,
      set: (v, o) => commit(p, v, o),
      reset: () => commit(p, p.initial),
      remove: () => removeParam(p.id),
    };
  };

  /** Register several params at once: registerParams([{...}, {...}]). */
  const registerParams = (specs) => specs.map(registerParam);

  const removeParam = (id) => {
    const p = params.get(id);
    if (!p) return;
    const g = p.row.parentNode;
    p.row.remove();
    params.delete(id);
    if (g && !g.querySelector('.sh-row')) { g.remove(); groups.delete(p.group || ''); }
  };
  const getParam = (id) => params.get(id)?.value;
  /**
   * Set a value from the engine side. Pass { silent: true } to skip onChange. A silent set
   * is ignored while the person is mid-drag on that slider (a live: false range).
   */
  const setParam = (id, value, o) => {
    const p = params.get(id);
    return p ? commit(p, value, o) : undefined;
  };
  const getParams = () => Object.fromEntries([...params.values()].filter((p) => p.type !== 'action').map((p) => [p.id, p.value]));
  const resetParams = () => { for (const p of params.values()) if (p.type !== 'action') commit(p, p.initial); };
  resetBtn.addEventListener('click', resetParams);

  // ---- visibility, panel, help -------------------------------------------
  const state = { panel: false, help: false, stats: false, idle: false };
  const setStats = (on) => {
    on = !!on;
    if (on === state.stats) return;
    state.stats = on;
    root.classList.toggle('stats-on', on);
    statsBtn.setAttribute('aria-pressed', String(on));
    if (opt.persist) { try { localStorage.setItem(opt.persist + '.stats', on ? '1' : '0'); } catch { /* private mode */ } }
    left.setAttribute('aria-hidden', String(!on));
    right.setAttribute('aria-hidden', String(!on));
    if (on) flushStats();
    emit('stats', on);
  };
  const setPanel = (open) => {
    open = !!open;
    if (open === state.panel) return;
    state.panel = open;
    root.classList.toggle('panel-open', open);
    if (!open && panel.contains(document.activeElement)) document.activeElement.blur();
    emit('panel', open);
  };
  const setHelp = (open) => {
    state.help = !!open;
    if (state.help) renderHelp();
    root.classList.toggle('help-open', state.help);
  };
  hint.addEventListener('click', () => setHelp(true));
  statsBtn.addEventListener('click', () => setStats(!state.stats));
  help.addEventListener('click', () => setHelp(false));
  dot.addEventListener('click', () => setPanel(!state.panel));

  // ---- dice -------------------------------------------------------------
  let rollTimer = 0;
  let shownFace = 0;
  const showFace = (n) => {
    shownFace = n;
    const on = FACES[n - 1];
    PIPS.forEach((c, i) => c.classList.toggle('is-on', on.includes(i)));
  };
  showFace(5);
  const showName = (r) => {
    if (typeof r === 'string') announce(r);
    else if (r && typeof r === 'object' && r.name) announce(String(r.name), r.detail);
  };
  /**
   * Roll the die. Fires the randomize handlers at once, so the simulation changes while the die is
   * still in the air. Pass a seed to replay a roll; otherwise a random uint32 is drawn.
   */
  // First visit: if the die goes untouched, let it breathe so it gets found. Stops for good at the first roll.
  const ROLLED_KEY = opt.persist ? opt.persist + '.rolled' : null;
  let hintTimer = 0;
  const stopHint = () => {
    clearTimeout(hintTimer);
    dice.classList.remove('is-hinting');
    if (ROLLED_KEY) { try { localStorage.setItem(ROLLED_KEY, '1'); } catch { /* private mode */ } }
  };
  if (opt.dice && opt.diceHintMs > 0) {
    let rolledBefore = false;
    if (ROLLED_KEY) { try { rolledBefore = localStorage.getItem(ROLLED_KEY) === '1'; } catch { /* private mode */ } }
    if (!rolledBefore) hintTimer = setTimeout(() => dice.classList.add('is-hinting'), opt.diceHintMs);
  }

  const randomize = (seed) => {
    if (activeJob) return { seed: 0, face: shownFace }; // the world belongs to the job until it ends
    stopHint();
    if (seed == null) seed = (Math.random() * 0x100000000) >>> 0;
    seed >>>= 0;
    const roll = { seed, face: (seed % 6) + 1 };
    // Tumble through faces, never showing the same one twice running, and land on roll.face.
    clearInterval(rollTimer);
    dice.classList.remove('is-rolling');
    void dice.offsetWidth; // restart the CSS animation on rapid presses
    dice.classList.add('is-rolling');
    let ticks = 6;
    rollTimer = setInterval(() => {
      if (--ticks <= 0) {
        clearInterval(rollTimer);
        showFace(roll.face);
        setTimeout(() => dice.classList.remove('is-rolling'), 200);
        return;
      }
      let n;
      do { n = 1 + Math.floor(Math.random() * 6); } while (n === shownFace || (ticks === 1 && n === roll.face));
      showFace(n);
    }, 70);
    resetTimer();
    const handlers = [...listeners.randomize];
    if (opt.onRandomize) handlers.unshift(opt.onRandomize);
    for (const fn of handlers) {
      try {
        const r = fn(roll);
        if (r && typeof r.then === 'function') r.then(showName, (e) => console.error(e)); else showName(r);
      } catch (e) { console.error(e); }
    }
    return roll;
  };
  dice.addEventListener('click', () => randomize());

  // ---- idle fade ---------------------------------------------------------
  let idleTimer = 0;
  const setIdle = (idle) => {
    if (idle === state.idle) return;
    state.idle = idle;
    root.classList.toggle('is-idle', idle);
    // A class, not an inline style, so it also beats a cursor set on a child such as the canvas.
    if (opt.hideCursor) parent.classList.toggle('strata-hud-idle', idle);
  };
  const wake = () => {
    setIdle(false);
    clearTimeout(idleTimer);
    if (opt.idleMs > 0) {
      idleTimer = setTimeout(() => {
        // Never fade away from under an open menu or help sheet.
        if (state.help || state.panel) return wake();
        setIdle(true);
      }, opt.idleMs);
    }
  };
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown']) {
    listen(window, type, wake, { passive: true, capture: true });
  }
  listen(window, 'touchstart', wake, { passive: true, capture: true });

  // ---- shortcuts ---------------------------------------------------------
  /** @type {Map<string, ShortcutSpec>} */
  const shortcuts = new Map();
  const renderHelp = () => {
    helpList.textContent = '';
    for (const s of shortcuts.values()) {
      if (s.hidden) continue;
      helpList.append(el('dt', null, KEY_NAMES[s.key] || s.key), el('dd', null, s.label));
    }
  };
  /** @param {ShortcutSpec} spec */
  const registerShortcut = (spec) => {
    const key = normKey(spec.key);
    shortcuts.set(key, { ...spec, key });
    if (state.help) renderHelp();
    return () => { if (shortcuts.get(key)?.run === spec.run) shortcuts.delete(key); };
  };
  const toggleFullscreen = () => {
    const target = parent === document.body ? document.documentElement : parent;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else target.requestFullscreen?.().catch(() => {});
  };
  if (opt.shortcuts) {
    if (opt.dice) registerShortcut({ key: 'r', label: 'randomize', run: (e) => { if (!e.repeat) randomize(); } });
    registerShortcut({ key: 'h', label: 'stats', run: () => setStats(!state.stats) });
    registerShortcut({
      key: 'escape', label: 'settings',
      run: () => {
        if (state.help) setHelp(false);
        else if (state.panel) setPanel(false);
        // With nothing else to close, Escape cancels a running job rather than opening the menu over it.
        else if (activeJob) activeJob.abort.abort();
        else setPanel(true);
      },
    });
    registerShortcut({ key: 'f', label: 'fullscreen', run: toggleFullscreen });
    registerShortcut({ key: '?', label: 'keys', run: () => setHelp(!state.help) });
  }
  listen(opt.keyTarget, 'keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const tag = t && t.tagName;
    // Leave typing alone. Sliders, switches and buttons do not take text, so shortcuts still work there.
    if (t && (t.isContentEditable || tag === 'TEXTAREA'
      || (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox'))) return;
    const key = normKey(e.key);
    const s = shortcuts.get(key);
    if (!s) return;
    // A focused select uses letters for type-ahead, and space/enter activate a focused HUD control.
    if (tag === 'SELECT' && key !== 'escape') return;
    if ((key === 'space' || key === 'enter') && root.contains(t)) return;
    e.preventDefault();
    try { s.run(e); } catch (err) { console.error(err); }
  });

  // ---- frame loop: fps + throttled stat writes ---------------------------
  let raf = 0;
  let lastFlush = 0;
  let fpsFrames = 0;
  let fpsSince = 0;
  const loop = (now) => {
    raf = requestAnimationFrame(loop);
    if (opt.autoFps && !fpsManual) {
      fpsFrames++;
      if (!fpsSince) { fpsSince = now; fpsFrames = 0; } else if (now - fpsSince >= 500) {
        const s = stats.get('fps');
        const v = (fpsFrames * 1000) / (now - fpsSince);
        if (s.value !== v) { s.value = v; s.dirty = true; }
        fpsSince = now; fpsFrames = 0;
      }
    }
    if (now - lastFlush >= STAT_FLUSH_MS && state.stats) {
      lastFlush = now;
      if (!timeManual) {
        const s = stats.get('time');
        const v = Math.floor((now - timeStart) / 1000);
        if (s.value !== v) { s.value = v; s.dirty = true; }
      }
      flushStats();
    }
  };
  raf = requestAnimationFrame(loop);

  // An explicit option wins; otherwise restore what the visitor last chose.
  let statsOn = !!opt.stats;
  if (options.stats === undefined && opt.persist) {
    try { statsOn = localStorage.getItem(opt.persist + '.stats') === '1'; } catch { /* private mode */ }
  }
  if (statsOn) setStats(true);
  if (opt.panelOpen) setPanel(true);
  wake();

  return {
    /** The overlay element. Set CSS custom properties on it to retheme. */
    el: root,
    setStat,
    /** Set several stats at once: setStats({ particles, plane, behavior }). */
    setStats: (obj) => { for (const k in obj) setStat(k, obj[k]); },
    defineStat: (key, def) => { defineStat(key, def); },
    announce,
    message,
    status,
    registerJob,
    /** True while a job started through registerJob is running. */
    get busy() { return !!activeJob; },
    registerParam,
    registerParams,
    removeParam,
    getParam,
    setParam,
    getParams,
    resetParams,
    registerShortcut,
    randomize,
    /**
     * Run fn({ seed, face }) on every roll of the dice (click, R key or hud.randomize()).
     * Return a string, or { name, detail }, or a promise of either, to have it announced on screen.
     * Returns an unsubscribe function.
     */
    onRandomize: (fn) => { listeners.randomize.add(fn); return () => listeners.randomize.delete(fn); },
    resetTimer,
    /** Subscribe to 'change' (id, value), 'panel' (open), 'stats' (on), 'randomize' (roll) or 'job' (id, running). Returns an unsubscribe function. */
    on: (type, fn) => { listeners[type].add(fn); return () => listeners[type].delete(fn); },
    openPanel: () => setPanel(true),
    closePanel: () => setPanel(false),
    togglePanel: () => setPanel(!state.panel),
    showStats: () => setStats(true),
    hideStats: () => setStats(false),
    toggleStats: () => setStats(!state.stats),
    toggleHelp: () => setHelp(!state.help),
    wake,
    get panelOpen() { return state.panel; },
    get statsVisible() { return state.stats; },
    get idle() { return state.idle; },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(idleTimer); clearTimeout(announceTimer); clearTimeout(saveTimer); clearInterval(rollTimer); clearTimeout(hintTimer); clearTimeout(statusTimer);
      activeJob?.abort.abort();
      disposers.forEach((d) => d());
      parent.classList.remove('strata-hud-idle');
      root.remove();
    },
  };
}

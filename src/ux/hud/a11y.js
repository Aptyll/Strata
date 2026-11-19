// Accessibility layer for the HUD's Esc menu and keys sheet. See docs/ux/hud-a11y.md.
//
// It attaches to an overlay built by createHud and adds behaviour only: it never builds
// menu structure (that is menu.js's job), so the two can change independently.
//
//   - The settings panel and the keys sheet are dialogs with names.
//   - Opening the panel moves focus to the panel itself (not a control, so an arrow
//     press meant for the camera cannot nudge a slider). Tab then walks the controls
//     and wraps inside the panel. Closing returns focus to where it was.
//   - While a control inside the panel is focused, arrow keys, Home, End, Page keys and
//     Space stay with that control and do not fly the camera.
//   - Any role="tablist" whose own handler did not take the key gets Left/Right
//     (or Up/Down when aria-orientation="vertical"), Home and End.
//   - The menu dot reports aria-expanded and which element it controls.
//   - A stylesheet raises the type size, text contrast and target sizes inside the
//     panel, draws a visible focus ring, and honours prefers-reduced-motion,
//     prefers-contrast, prefers-reduced-transparency and forced colours.

import { A11Y_CSS } from './a11y-styles.js';

const STYLE_ID = 'strata-hud-a11y-style';

/** Keys a focused control keeps for itself instead of letting them reach the camera. */
const CONTROL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', ' ']);

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

let uid = 0;

/**
 * Wire dialog semantics, focus handling and keyboard navigation onto a HUD overlay.
 * Safe to call once per overlay. Returns a dispose function.
 * @param {HTMLElement} root  the .strata-hud element (hud.el)
 * @returns {() => void}
 */
export function attachMenuA11y(root) {
  if (!root || root.dataset.a11y === 'on') return () => {};
  root.dataset.a11y = 'on';
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = A11Y_CSS;
    // After the base HUD stylesheet so equal-specificity rules here win.
    document.head.appendChild(style);
  }

  const panel = root.querySelector('.sh-panel');
  const dot = root.querySelector('.sh-dot');
  const dice = root.querySelector('.sh-dice');
  const help = root.querySelector('.sh-help');
  const offs = [];
  const on = (target, type, fn, opts) => {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    offs.push(() => target.removeEventListener(type, fn, opts));
  };

  // ---- names and roles ---------------------------------------------------
  if (panel) {
    if (!panel.id) panel.id = 'strata-settings-' + ++uid;
    panel.setAttribute('role', 'dialog');
    if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) panel.setAttribute('aria-label', 'Settings');
    panel.tabIndex = -1;
  }
  if (dot) {
    dot.setAttribute('aria-haspopup', 'dialog');
    dot.setAttribute('aria-keyshortcuts', 'Escape');
    if (panel) dot.setAttribute('aria-controls', panel.id);
  }
  if (dice) dice.setAttribute('aria-keyshortcuts', 'R');
  if (help) {
    if (!help.id) help.id = 'strata-keys-' + ++uid;
    help.setAttribute('role', 'dialog');
    help.setAttribute('aria-label', 'Keyboard shortcuts');
    help.tabIndex = -1;
  }

  // ---- open / close: move focus in, give it back --------------------------
  const isUsable = (el) => el && el !== document.body && el.isConnected && typeof el.focus === 'function';
  const focusQuietly = (el) => { try { el.focus({ preventScroll: true }); } catch { el.focus(); } };

  const track = (el, cls) => {
    let open = root.classList.contains(cls);
    let returnTo = null;
    return () => {
      const now = root.classList.contains(cls);
      if (now === open) return;
      open = now;
      if (el === panel && dot) dot.setAttribute('aria-expanded', String(now));
      if (!el) return;
      el.setAttribute('aria-hidden', String(!now));
      if (now) {
        const active = document.activeElement;
        returnTo = el.contains(active) ? null : active;
        focusQuietly(el);
      } else {
        const back = returnTo;
        returnTo = null;
        // Only hand focus back if it is still inside this dialog (or was dropped to the body
        // by the close), so a click elsewhere that closed the menu keeps its own focus.
        const active = document.activeElement;
        const dropped = !active || active === document.body || el.contains(active);
        if (dropped) {
          if (isUsable(back) && !el.contains(back)) focusQuietly(back);
          else if (el.contains(active)) active.blur();
        }
      }
    };
  };
  const syncPanel = track(panel, 'panel-open');
  const syncHelp = track(help, 'help-open');
  if (dot) dot.setAttribute('aria-expanded', String(root.classList.contains('panel-open')));
  if (panel) panel.setAttribute('aria-hidden', String(!root.classList.contains('panel-open')));
  if (help) help.setAttribute('aria-hidden', String(!root.classList.contains('help-open')));
  const observer = new MutationObserver(() => { syncPanel(); syncHelp(); });
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  offs.push(() => observer.disconnect());

  // ---- keyboard inside the panel -----------------------------------------
  const visible = (el) => el.getClientRects().length > 0 && !el.closest('[hidden], [inert]');
  const focusables = (scope) => [...scope.querySelectorAll(FOCUSABLE)].filter((el) =>
    el !== scope && !el.disabled && el.tabIndex >= 0 && visible(el));

  const rove = (e) => {
    const tab = e.target.closest?.('[role=tab]');
    if (!tab || e.defaultPrevented) return false;
    const list = tab.closest('[role=tablist]');
    if (!list) return false;
    const vertical = list.getAttribute('aria-orientation') === 'vertical';
    const step = { [vertical ? 'ArrowDown' : 'ArrowRight']: 1, [vertical ? 'ArrowUp' : 'ArrowLeft']: -1 }[e.key];
    if (!step && e.key !== 'Home' && e.key !== 'End') return false;
    const tabs = [...list.querySelectorAll('[role=tab]')].filter((t) =>
      t.closest('[role=tablist]') === list && !t.disabled && t.getAttribute('aria-disabled') !== 'true' && visible(t));
    if (!tabs.length) return false;
    const i = tabs.indexOf(tab);
    const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1]
      : tabs[(i + step + tabs.length) % tabs.length];
    e.preventDefault();
    for (const t of tabs) t.tabIndex = t === next ? 0 : -1;
    next.focus();
    // Automatic activation: the page follows the focused tab.
    if (next.getAttribute('aria-selected') !== 'true') next.click();
    return true;
  };

  const onPanelKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab') {
      const items = focusables(panel);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel || !panel.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !panel.contains(active))) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.type === 'keydown') rove(e);
    // A focused control keeps its navigation keys; the panel itself does not, so the
    // camera can still be flown with the menu open and nothing selected.
    if (e.target !== panel && CONTROL_KEYS.has(e.key)) e.stopPropagation();
  };
  on(panel, 'keydown', onPanelKey);
  on(panel, 'keyup', (e) => { if (e.target !== panel && CONTROL_KEYS.has(e.key)) e.stopPropagation(); });

  // The keys sheet closes on click; Enter and Space close it too once it has focus.
  on(help, 'keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); help.click(); }
    else if (e.key === 'Tab') e.preventDefault();
  });

  return () => {
    for (const off of offs.splice(0)) off();
    delete root.dataset.a11y;
  };
}

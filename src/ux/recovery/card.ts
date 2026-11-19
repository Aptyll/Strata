/**
 * The card recovery shows over a frozen or failed world: a title, a line or
 * two of plain words, and buttons. Plain DOM, no GPU. One card at a time.
 *
 * It is styled from the design tokens (docs/ux/design.md), like the
 * no-WebGPU note (src/ux/experience/fallback.ts), because it is the same
 * kind of message: a scrim over the picture, which stays visible, a panel,
 * a caption for the title, the body role for the sentences, the fine role
 * for the copied details, and the shared button.
 */

import { TYPE, installTokens } from "../design";

const STYLE_ID = "strata-recovery-style";
const STYLE = `
.strata-recovery{position:fixed;inset:0;z-index:var(--st-z-modal);display:flex;align-items:center;justify-content:center;
padding:var(--st-edge);box-sizing:border-box;background:var(--st-scrim);
opacity:0;transition:opacity var(--st-medium) var(--st-ease)}
.strata-recovery[data-on="1"]{opacity:1}
.strata-recovery-card{${TYPE.body}max-width:34em;width:100%;text-align:center;padding:var(--st-space-8) var(--st-space-6);box-sizing:border-box;
background:var(--st-surface);border:1px solid var(--st-hair);border-radius:var(--st-radius)}
.strata-recovery h2{${TYPE.caption}color:var(--st-strong);margin:0 0 var(--st-space-3);text-indent:var(--st-track-wide)}
.strata-recovery p{margin:0 auto var(--st-space-2);max-width:30em;text-wrap:balance}
.strata-recovery .count{color:var(--st-strong);font-variant-numeric:tabular-nums}
.strata-recovery .hint{margin-top:var(--st-space-4);margin-bottom:0;color:var(--st-faint)}
.strata-recovery .copied{${TYPE.fine}margin:var(--st-space-3) 0 0;white-space:pre-wrap;text-align:left}
.strata-recovery .copied:empty{display:none}
.strata-recovery-actions{display:flex;flex-wrap:wrap;gap:var(--st-space-3);justify-content:center;margin-top:var(--st-space-4)}
`;

export interface CardAction {
  label: string;
  run: () => void;
  /** The action Enter picks: it gets the focus and the brighter outline. */
  primary?: boolean;
}

export interface CardCountdown {
  seconds: number;
  /** The line shown while counting, given the seconds left. */
  label: (secondsLeft: number) => string;
  /** Runs when the count reaches zero. */
  run: () => void;
  /** Label of the action that stops the count. */
  stopLabel: string;
  /** Runs when the person stops the count (the button, or Escape). The card stays open. */
  onStop?: () => void;
}

export interface CardSpec {
  title: string;
  /** One paragraph per entry. */
  body: string[];
  actions: CardAction[];
  /** Small print under the buttons: what to try if it keeps happening. */
  hint?: string;
  /** When given, a "copy details" action puts this text on the clipboard, for a bug report. */
  details?: () => string;
  /** Count down to an action instead of waiting for a press. */
  countdown?: CardCountdown;
}

export interface Card {
  readonly el: HTMLElement;
  close(): void;
}

let open: Card | null = null;

/** Show a card, replacing any card already up. */
export function showCard(spec: CardSpec, parent: HTMLElement = document.body): Card {
  open?.close();
  const doc = parent.ownerDocument;
  const win = doc.defaultView ?? window;
  installTokens(doc);
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }

  const root = doc.createElement("div");
  root.className = "strata-recovery";
  const card = doc.createElement("div");
  card.className = "strata-recovery-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-modal", "true");
  const title = doc.createElement("h2");
  title.id = "strata-recovery-title";
  title.textContent = spec.title;
  card.setAttribute("aria-labelledby", title.id);
  card.append(title);
  for (const text of spec.body) {
    const p = doc.createElement("p");
    p.textContent = text;
    card.append(p);
  }

  const count = doc.createElement("p");
  count.className = "count";
  count.setAttribute("aria-live", "polite");
  const actions = doc.createElement("div");
  actions.className = "strata-recovery-actions";
  const copied = doc.createElement("p");
  copied.className = "copied";
  copied.setAttribute("role", "status");

  let timer = 0;
  let left = spec.countdown?.seconds ?? 0;
  const stopCount = (): void => {
    if (!timer) return;
    win.clearInterval(timer);
    timer = 0;
    count.remove();
  };

  const button = (action: CardAction): HTMLButtonElement => {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.className = action.primary ? "st-button is-primary" : "st-button";
    b.addEventListener("click", () => {
      stopCount();
      action.run();
    });
    actions.append(b);
    return b;
  };
  let focus: HTMLButtonElement | null = null;
  for (const action of spec.actions) {
    const b = button(action);
    if (action.primary && !focus) focus = b;
  }

  let stopButton: HTMLButtonElement | null = null;
  const stop = (): void => {
    if (!timer) return;
    stopCount();
    stopButton?.remove();
    focus?.focus();
    spec.countdown?.onStop?.(); // may replace this card with another
  };
  if (spec.countdown) {
    const cd = spec.countdown;
    count.textContent = cd.label(left);
    card.append(count);
    stopButton = doc.createElement("button");
    stopButton.type = "button";
    stopButton.className = "st-button";
    stopButton.textContent = cd.stopLabel;
    stopButton.addEventListener("click", stop);
    actions.append(stopButton);
    const tick = (): void => {
      // A hidden tab would restart unseen and may lose the device again: wait for the person to come back.
      if (doc.visibilityState === "hidden") return;
      left -= 1;
      if (left <= 0) {
        stopCount();
        cd.run();
      } else {
        count.textContent = cd.label(left);
      }
    };
    timer = win.setInterval(tick, 1000);
  }

  if (spec.details) {
    const details = spec.details;
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "st-button";
    b.textContent = "copy details";
    b.addEventListener("click", () => {
      const text = details();
      const done = (ok: boolean): void => {
        // No clipboard (an old browser, a blocked permission): show the text so it can be selected.
        copied.textContent = ok ? "Details copied. Paste them into a bug report." : text;
        copied.style.textAlign = ok ? "center" : "left";
        copied.style.userSelect = ok ? "" : "text";
      };
      const clipboard = win.navigator.clipboard;
      if (clipboard?.writeText) clipboard.writeText(text).then(() => done(true), () => done(false));
      else done(false);
    });
    actions.append(b);
  }

  card.append(actions);
  if (spec.hint) {
    const hint = doc.createElement("p");
    hint.className = "hint";
    hint.textContent = spec.hint;
    card.append(hint);
  }
  card.append(copied);
  root.append(card);
  parent.append(root);

  // Escape stops the countdown and must not also open the settings menu underneath.
  // Other keys stay with the card too, so R or ] cannot reach a world that is frozen.
  const onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Tab" || e.key === "Enter" || e.key === " ") {
      // Keep focus inside the card.
      if (e.key === "Tab") {
        const buttons = [...card.querySelectorAll("button")];
        const i = buttons.indexOf(doc.activeElement as HTMLButtonElement);
        const next = buttons[(i + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        e.preventDefault();
        next?.focus();
      }
      e.stopPropagation();
      return;
    }
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      stop();
    }
  };
  win.addEventListener("keydown", onKey, true);

  const self: Card = {
    el: root,
    close() {
      stopCount();
      win.removeEventListener("keydown", onKey, true);
      root.remove();
      if (open === self) open = null;
    },
  };
  open = self;
  // Fade in on the next frame; without one (a hidden tab) show it at once.
  win.requestAnimationFrame(() => (root.dataset.on = "1"));
  win.setTimeout(() => (root.dataset.on = "1"), 100);
  (focus ?? stopButton ?? card.querySelector("button"))?.focus();
  return self;
}

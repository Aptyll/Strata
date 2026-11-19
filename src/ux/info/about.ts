/**
 * The about card: one screen that answers "what am I looking at?".
 *
 *   what you are looking at    sheets, behaviors, why brighter means denser
 *   right now, live            particles simulated this frame, stored, per pixel, fps
 *   the trillion               rendered, not simulated, and what that means
 *   the sheets in this world   each behavior in the world with its one sentence
 *
 * The live numbers come from the running world and refresh while the card is
 * open. The definitions are the TERMS in ./words.ts, word for word, so the
 * card, the stats line and the docs cannot drift apart. The only fixed claims
 * are the measured trillion numbers in MEASURED, each quoted with its GPU.
 */
import { census, censusLine, totals, type Sheet } from "./sheets";
import { MEASURED, TERMS, exactCount, perPixel, plural } from "./words";

export interface AboutSources {
  /** The sheets in the world right now. */
  sheets(): readonly Sheet[];
  /** Measured frames per second. */
  fps(): number;
  /** Width and height of the picture in pixels, or null when unknown. */
  pixels(): [number, number] | null;
}

export interface AboutOptions {
  /** Touch wording: no key hints. */
  touch: boolean;
  /** Site root the links start from, with a trailing slash. "/" in dev, "/Strata/" on GitHub Pages. */
  base: string;
  /** Called after the card opens or closes. */
  onChange?(open: boolean): void;
}

export interface About {
  readonly el: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** Bring the live numbers and the list of behaviors up to date. Cheap; call a few times a second while open. */
  refresh(): void;
}

/** Text with some runs emphasised: plain strings, and [text] for the strong ones. */
type Rich = Array<string | [string] | Node>;

export function createAbout(root: HTMLElement, sources: AboutSources, options: AboutOptions): About {
  const doc = root.ownerDocument;
  const h = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const rich = (parts: Rich, tag: "p" | "span" = "p"): HTMLElement => {
    const n = h(tag);
    for (const part of parts) n.append(Array.isArray(part) ? h("b", undefined, part[0]) : part);
    return n;
  };
  /** "Simulated." in strong type, then the sentence that defines it. */
  const define = (term: { word: string; means: string }): Rich => [
    [`${term.word[0].toUpperCase()}${term.word.slice(1)}.`],
    ` ${term.means} `,
  ];
  const link = (text: string, path: string): HTMLAnchorElement => {
    const a = h("a", undefined, text);
    a.href = options.base + path;
    // A new tab, so the world the visitor was watching is still there when they come back.
    a.target = "_blank";
    a.rel = "noopener";
    return a;
  };

  const el = h("div", "si-about");
  el.setAttribute("aria-hidden", "true");
  const card = h("div", "si-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "What you are looking at");
  card.tabIndex = -1;
  const close = h("button", "si-close", "close");
  close.type = "button";

  // ---- what you are looking at ----------------------------------------------
  const sheetCount = h("b");
  const intro = rich([
    "A black void with ",
    sheetCount,
    " floating in it. Each sheet runs its own 2D particle system and follows one rule, its ",
    ["behavior"],
    ". Every dot is one particle. Where particles overlap their light adds up, so brighter means denser.",
  ]);

  // ---- right now, live --------------------------------------------------------
  const numbers = h("dl", "si-numbers");
  const number = (label: string) => {
    const wrap = h("div");
    const dd = h("dd", undefined, "-");
    const dt = h("dt", undefined, label);
    wrap.append(dd, dt);
    numbers.append(wrap);
    return { dd, dt };
  };
  const simulated = number("particles simulated this frame");
  const fps = number("frames per second");
  const stored = number("particles stored");
  const density = number("simulated particles per pixel");
  const live = rich([...define(TERMS.simulated), ...define(TERMS.stored)]);

  // ---- the trillion -------------------------------------------------------------
  const [fast, slow] = MEASURED.trillionFrameSeconds;
  const trillion = rich([
    "The frames with ",
    [exactCount(MEASURED.trillion)],
    " particles are made offline, a different way: a trillion particles do not fit in a graphics card's memory.",
  ]);
  const renderedText = rich([
    ...define(TERMS.rendered),
    `One 4K frame took ${fast} to ${slow} seconds on an ${MEASURED.gpu}.`,
  ]);
  const links = h("p", "si-links");
  links.append(
    link("how the rendering works", "docs/explainers/rendering.html"),
    link("render a frame yourself", "src/offline/web/"),
    link("proof shots", "src/proof/web/"),
  );

  // ---- the sheets in this world -------------------------------------------------
  const legend = h("dl", "si-legend");

  card.append(
    close,
    h("h2", undefined, "what you are looking at"), intro,
    h("h2", undefined, "right now, live"), numbers, live,
    h("h2", undefined, "the trillion is rendered, not simulated"), trillion, renderedText, links,
    h("h2", undefined, "the sheets in this world"), legend,
  );
  // Footer: where the rest of the information lives. Keys only, so a touch screen goes without.
  if (!options.touch) {
    const foot = h("div", "si-foot");
    for (const [key, what] of [["?", "all controls"], ["h", "live numbers"], ["esc", "settings"], ["i", "close"]]) {
      foot.append(rich([[key], what], "span"));
    }
    card.append(foot);
  }
  el.append(card);
  root.append(el);

  const set = (node: HTMLElement, value: string) => {
    if (node.textContent !== value) node.textContent = value;
  };
  let legendKey = "";

  const refresh = () => {
    const sheets = sources.sheets();
    const t = totals(sheets);
    set(sheetCount, plural(t.sheets, "flat sheet"));
    set(simulated.dd, exactCount(t.simulated));
    set(stored.dd, exactCount(t.stored));
    const rate = sources.fps();
    set(fps.dd, rate > 0 ? String(Math.round(rate)) : "-");
    const size = sources.pixels();
    set(density.dd, size ? perPixel(t.simulated, size[0] * size[1]) : "-");
    set(density.dt, size ? `simulated particles per pixel (${size[0]} × ${size[1]})` : "simulated particles per pixel");

    // Rebuild the list only when the cast of behaviors changes (a dice roll, a new sheet count).
    const rows = census(sheets);
    const key = rows.map((r) => `${r.id}:${r.sheets}:${r.stored}`).join("|");
    if (key === legendKey) return;
    legendKey = key;
    legend.textContent = "";
    for (const row of rows) {
      const wrap = h("div");
      const dt = h("dt", undefined, row.name);
      dt.append(h("i", undefined, censusLine(row)));
      wrap.append(dt);
      if (row.description) wrap.append(h("dd", undefined, row.description));
      legend.append(wrap);
    }
  };

  let open = false;
  let returnTo: Element | null = null;
  const setOpen = (on: boolean) => {
    if (on === open) return;
    open = on;
    root.classList.toggle("si-about-open", on);
    el.setAttribute("aria-hidden", String(!on));
    if (on) {
      refresh();
      el.scrollTop = 0;
      returnTo = doc.activeElement;
      card.focus({ preventScroll: true });
    } else {
      // Hand focus back only if it is still inside the card, so a click elsewhere keeps its own.
      const active = doc.activeElement;
      if (active && el.contains(active)) {
        if (returnTo instanceof HTMLElement && returnTo.isConnected && returnTo !== doc.body) returnTo.focus({ preventScroll: true });
        else (active as HTMLElement).blur();
      }
      returnTo = null;
    }
    options.onChange?.(on);
  };

  close.addEventListener("click", () => setOpen(false));
  // A click on the dimmed backdrop closes it. Clicks inside the card do not, so links work and text can be selected.
  el.addEventListener("click", (e) => {
    if (e.target === el) setOpen(false);
  });
  // Tab stays inside the card while it is open.
  card.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const items = [...card.querySelectorAll<HTMLElement>("button, a[href]")];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = doc.activeElement;
    if (e.shiftKey && (active === first || active === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return {
    el,
    get isOpen() {
      return open;
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!open),
    refresh,
  };
}

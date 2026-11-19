/**
 * The about card: one screen that answers "what am I looking at?".
 *
 *   what you are looking at    sheets, behaviors, why brighter means denser
 *   right now, live            particles simulated this frame, stored, frames per second, per pixel
 *   the trillion               rendered, not simulated, and what that means
 *   the sheets in this world   each behavior in the world with its one sentence
 *
 * The live numbers come from the running world and refresh while the card is
 * open. The definitions are the TERMS in ./words.ts, word for word, so the
 * card, the stats line and the docs cannot drift apart. The only fixed claims
 * are the measured trillion frame times in MEASURED, quoted with their GPU,
 * with which of the two ways of adding light each one belongs to, and with
 * how much of the picture the sheets cover.
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

/** Text with some runs emphasised: plain strings, [text] for the strong ones, or a ready-made node. */
type Rich = Array<string | [string] | Node>;

/** The key hints in the card's footer: where the rest of the information lives. ./index.ts makes each key do what it says. */
const FOOTER_KEYS: ReadonlyArray<readonly [key: string, what: string]> = [
  ["?", "all controls"],
  ["h", "live numbers"],
  ["esc", "close"],
];

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
  /** One number with the words that say what it counts: <div><dt>label</dt><dd>value</dd></div>, drawn value first. */
  const number = (list: HTMLElement, label: string) => {
    const wrap = h("div", "si-number");
    const dt = h("dt", undefined, label);
    const dd = h("dd", undefined, "-");
    wrap.append(dt, dd);
    list.append(wrap);
    return { wrap, dd };
  };

  const el = h("div", "si-about");
  el.setAttribute("aria-hidden", "true");
  const card = h("div", "si-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
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
    ". Each particle is drawn as one dot of light. Where particles overlap their light adds up, so brighter means denser.",
  ]);

  // ---- right now, live --------------------------------------------------------
  const hero = h("dl", "si-live si-hero");
  const simulated = number(hero, "particles simulated this frame");
  const facts = h("dl", "si-live si-facts");
  const stored = number(facts, "stored");
  const fps = number(facts, "frames per second");
  const density = number(facts, "simulated per pixel");
  const live = rich([...define(TERMS.simulated), ...define(TERMS.stored)]);

  // ---- the trillion -------------------------------------------------------------
  const { exact, averaged, averagedFull } = MEASURED.trillionFrameSeconds;
  const trillion = rich([
    "The frames with ",
    [exactCount(MEASURED.trillion)],
    " particles are not this live world. They are made offline, one frame at a time, in a different way, because a trillion particles do not fit in a graphics card's memory.",
  ]);
  const renderedText = rich(define(TERMS.rendered));
  const measured = rich([
    `On an ${MEASURED.gpu}, one 4K frame takes about ${exact[0]} to ${exact[1]} seconds when every particle in view adds exactly one unit of light. When far particles are drawn on average instead of one by one, it takes ${averaged[0]} to ${averaged[1]} seconds if the sheets cover part of the picture, and ${averagedFull[0]} to ${averagedFull[1]} seconds if they fill it.`,
  ]);
  const links = h("p", "si-links");
  links.append(
    link("how the rendering works", "docs/explainers/rendering.html"),
    link("render a frame yourself", "src/offline/web/"),
    link("proof shots", "src/proof/web/"),
  );

  // ---- the sheets in this world -------------------------------------------------
  const legend = h("dl", "si-legend");

  const column = (...nodes: Node[]) => {
    const section = h("section");
    section.append(...nodes);
    return section;
  };
  const columns = h("div", "si-cols");
  columns.append(
    column(h("h2", undefined, "what you are looking at"), intro, h("h2", undefined, "right now, live"), hero, facts, live),
    column(h("h2", undefined, "the trillion is rendered, not simulated"), trillion, renderedText, measured, links),
  );
  card.append(close, columns, h("h2", undefined, "the sheets in this world"), legend);
  // Footer: where the rest of the information lives. Keys only, so a touch screen goes without.
  if (!options.touch) {
    const foot = h("div", "si-foot");
    for (const [key, what] of FOOTER_KEYS) foot.append(rich([[key], what], "span"));
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
    // The sum behind the ratio, for anyone who points at it.
    const sum = size ? `${exactCount(t.simulated)} particles simulated ÷ ${exactCount(size[0] * size[1])} pixels (${size[0]} × ${size[1]})` : "";
    if (density.wrap.title !== sum) density.wrap.title = sum;

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

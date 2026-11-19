/**
 * The information layer: what the words on screen tell a viewer about what
 * they are looking at. It adds no controls to the world, only meaning to what
 * is already there. The vocabulary and the rules: docs/ux/information.md.
 *
 *   const info = mountInfo({ hud, app, canvas, rig: camera.rig, key: KEYS.about });
 *
 * What it does, all through the HUD it is given:
 *
 *   stats line (H)   every count says what it counts: "1.21M simulated
 *                    2.00M stored  32 sheets". The second count shows only
 *                    while some sheets rest; when both would read the same,
 *                    one number says it all. The HUD itself is generic and
 *                    knows nothing about Strata; this is where its numbers get
 *                    Strata's words (./words.ts).
 *   sheet label      bottom right: the name of the sheet the camera faces, the
 *                    sentence that describes its behavior, and its particle
 *                    count. With the stats line on, it also names the sheet
 *                    under the pointer (./label.ts).
 *   keys sheet (?)   gains the controls that are not HUD shortcuts: what the
 *                    pointer does and the camera keys (./controls.ts).
 *   about card (I)   one screen: what a sheet is, the live counts, and why the
 *                    trillion is "rendered" and this world is "simulated"
 *                    (./about.ts). Also reachable from the menu footer.
 *
 * It never costs a frame: one timer, five times a second, writes text only
 * when the text changed.
 */
import type { AppContext } from "../../core/contracts";
import { installTokens } from "../design";
import type { Hud } from "../hud/index.js";
import { createAbout, type About } from "./about";
import { controlSections } from "./controls";
import { createSheetLabel, type LabelLevel } from "./label";
import { countsDiffer, findSheet, sheetFacts, totals } from "./sheets";
import { INFO_CSS } from "./styles";
import { TERMS, exactCount, readingMs, shortCount } from "./words";

export * from "./controls";
export * from "./sheets";
export * from "./words";
export type { About } from "./about";

/** The parts of the camera rig (src/ux/camera) this reads. */
export interface InfoRig {
  /** The sheet the camera has flown to and is facing, or null once the person moves away. */
  readonly focused: { center: readonly number[] } | null;
  /** The nearest sheet under a screen position in normalized device coordinates, or null. */
  pick(ndcX: number, ndcY: number): { center: readonly number[] } | null;
}

export interface InfoOptions {
  hud: Hud;
  app: Pick<AppContext, "planes" | "stats">;
  /** The canvas the world is drawn on: where the pointer points, and how many pixels the picture has. */
  canvas: HTMLCanvasElement;
  /** Without a rig there is no sheet label; everything else still works. */
  rig?: InfoRig;
  /** The key that opens the about card, as the HUD names it. Default "i". */
  key?: { key: string; label?: string };
  /** True while something else owns the screen (the opening). The sheet label waits. */
  quiet?: () => boolean | undefined;
  /** Touch wording. Defaults to the (pointer: coarse) media query. */
  touch?: boolean;
  /** Site root for the about card's links, with a trailing slash. Defaults to Vite's base. */
  base?: string;
  /** Milliseconds between refreshes. Default 200. */
  intervalMs?: number;
}

export interface Info {
  readonly about: About;
  /** Refresh now. It also runs by itself a few times a second. */
  update(): void;
  dispose(): void;
}

const STYLE_ID = "strata-info-style";

/** Keys that scroll a page. While the about card is open they scroll the card instead of flying the camera. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function mountInfo(opts: InfoOptions): Info {
  const { hud, app, canvas, rig } = opts;
  const root = hud.el;
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const touch = opts.touch ?? win.matchMedia?.("(pointer: coarse)").matches ?? false;
  const cleanups: Array<() => void> = [];

  installTokens(doc);
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = INFO_CSS;
    doc.head.appendChild(style);
  }

  // ---- stats line: every count says what it counts ------------------------------
  hud.defineStat("particles", {
    label: TERMS.simulated.word,
    format: shortCount,
    title: (v) => `${exactCount(v)} particles simulated this frame`,
  });
  hud.defineStat("total", {
    label: TERMS.stored.word,
    format: shortCount,
    title: (v) => `${exactCount(v)} particles stored in GPU memory`,
  });
  let sheetWord = "";
  const nameSheets = (count: number) => {
    const word = count === 1 ? TERMS.sheet.word : `${TERMS.sheet.word}s`;
    if (word === sheetWord) return;
    sheetWord = word;
    hud.defineStat("planes", { label: word });
  };

  // ---- sheet label ------------------------------------------------------------------
  const label = createSheetLabel(root);
  cleanups.push(() => label.el.remove());
  let px = 0;
  let py = 0;
  let hovering = false;
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    // A pressed pointer is steering the camera or pushing particles, not pointing at a sheet.
    hovering = e.buttons === 0;
    px = e.clientX;
    py = e.clientY;
  };
  const stopHover = () => {
    hovering = false;
  };
  canvas.addEventListener("pointermove", onMove, { passive: true });
  canvas.addEventListener("pointerdown", stopHover);
  canvas.addEventListener("pointerleave", stopHover);
  cleanups.push(() => {
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerdown", stopHover);
    canvas.removeEventListener("pointerleave", stopHover);
  });
  const pointedSheet = () => {
    if (!rig || !hovering) return null;
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    const hit = rig.pick(((px - r.left) / r.width) * 2 - 1, 1 - ((py - r.top) / r.height) * 2);
    return hit ? findSheet(app.planes, hit.center) : null;
  };
  /** The sheet the full label last arrived for, and until when it stays up so it can be read. */
  let announced = "";
  let holdUntil = 0;

  // ---- keys sheet: the controls the HUD does not know about ---------------------------
  const help = root.querySelector(".sh-help");
  if (help) {
    const list = doc.createElement("dl");
    list.className = "si-controls";
    for (const section of controlSections(touch)) {
      const head = doc.createElement("dt");
      head.className = "si-head";
      head.textContent = section.title;
      list.append(head);
      for (const row of section.rows) {
        const dt = doc.createElement("dt");
        dt.textContent = row.input;
        const dd = doc.createElement("dd");
        dd.textContent = row.does;
        list.append(dt, dd);
      }
    }
    // First: how to move comes before the shortcuts.
    help.prepend(list);
    cleanups.push(() => list.remove());
  }

  // ---- about card -----------------------------------------------------------------------
  const about = createAbout(
    root,
    {
      sheets: () => app.planes,
      fps: () => app.stats().fps,
      pixels: () => (canvas.width > 0 && canvas.height > 0 ? [canvas.width, canvas.height] : null),
    },
    {
      touch,
      base: opts.base ?? import.meta.env.BASE_URL,
      onChange: (open) => {
        if (!open) return;
        // One overlay at a time.
        hud.closePanel();
        if (root.classList.contains("help-open")) hud.toggleHelp();
        update();
      },
    },
  );
  cleanups.push(() => about.el.remove());
  cleanups.push(
    hud.registerShortcut({
      key: opts.key?.key ?? "i",
      label: opts.key?.label ?? "what is this",
      run: (e) => {
        if (!e.repeat) about.toggle();
      },
    }),
  );
  cleanups.push(hud.on("panel", (open) => open && about.close()));
  cleanups.push(hud.on("job", (_id, running) => running && about.close()));

  // While the card is open, the keys in its footer do what the footer says, and the keys that
  // scroll a page scroll the card. Capture phase, so this runs before the HUD's own key handler
  // and before the camera's key router (src/app/keys.ts) see the event.
  const onKey = (e: KeyboardEvent) => {
    if (!about.isOpen || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
      // Close the card instead of opening the menu behind it.
      about.close();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key === "?") {
      about.close(); // the HUD then opens the keys sheet
    } else if (e.key === "h" || e.key === "H") {
      about.close();
      // The HUD's H toggles the stats line. If it is already on, leave it on.
      if (hud.statsVisible) e.stopPropagation();
    } else if (SCROLL_KEYS.has(e.key)) {
      e.stopPropagation(); // the browser still scrolls the card
    }
  };
  win.addEventListener("keydown", onKey, true);
  cleanups.push(() => win.removeEventListener("keydown", onKey, true));

  // The way in for people without a keyboard: next to "reset", "stats" and "? keys" in the menu footer.
  const foot = root.querySelector(".sh-foot");
  if (foot) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "si-about-link";
    button.textContent = touch ? "about" : `${opts.key?.key ?? "i"} about`;
    button.addEventListener("click", () => about.open());
    foot.append(button);
    cleanups.push(() => button.remove());
  } else {
    hud.registerParam({ id: "about", label: "what am I looking at", type: "action", run: () => about.open() });
    cleanups.push(() => hud.removeParam("about"));
  }

  // ---- refresh ------------------------------------------------------------------------------
  function update(): void {
    const sheets = app.planes;
    const t = totals(sheets);
    nameSheets(t.sheets);
    // Both counts come from one reading of the world, so they never disagree on screen.
    hud.setStat("particles", t.simulated);
    hud.setStat("total", countsDiffer(t) ? t.stored : null);

    const quiet = about.isOpen || hud.busy || opts.quiet?.() === true;
    let level: LabelLevel = "full";
    let sheet = !quiet && rig?.focused ? findSheet(sheets, rig.focused.center) : null;
    if (!sheet && !quiet && hud.statsVisible) {
      sheet = pointedSheet();
      level = "short";
    }
    const facts = sheet ? sheetFacts(sheets, sheet) : null;
    const now = win.performance.now();
    if (facts) {
      const characters = label.show(facts, level);
      // A label that arrives for a sheet the camera now faces stays long enough to be read,
      // even if the person lets go of the mouse and the rest of the HUD fades.
      const arrival = level === "full" ? `${facts.number}/${facts.of} ${facts.name}` : "";
      if (arrival !== announced) {
        announced = arrival;
        holdUntil = arrival ? now + readingMs(characters) : 0;
      }
      label.hold(now < holdUntil);
    } else {
      label.hide();
      announced = "";
      holdUntil = 0;
    }

    if (about.isOpen) {
      about.refresh();
      hud.wake(); // reading is not idling: keep the cursor
    }
  }
  const timer = win.setInterval(update, opts.intervalMs ?? 200);
  cleanups.push(() => win.clearInterval(timer));
  update();

  return {
    about,
    update,
    dispose() {
      about.close();
      for (const off of cleanups.splice(0)) off();
    },
  };
}

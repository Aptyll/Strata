// Specimen page for the design tokens (../index.ts). Everything here is drawn
// with the tokens and the role classes, so the page is also the reference for
// how to use them. The particles are a still 2D stand-in; no WebGPU.
//
// Keys: 1 2 3 switch the type option (two voices, all mono, all sans), T cycles
// the color theme. Both work by overriding one token on :root, which is the
// point of having tokens.

import { THEMES, applyTheme } from "../../theme";
import { DESIGN, accentOf, contrastOnVoid, installTokens, setAccent, type Role } from "../index";

installTokens();

type Child = Node | string | null | false;
/** h("div.a.b", "text", child, ...) builds an element. */
function h(spec: string, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const c of children) if (c) el.append(c);
  return el;
}

const style = document.createElement("style");
style.textContent = `
body { color: var(--st-dim); }
.sp { max-width: 1120px; margin: 0 auto; padding: var(--st-space-12) var(--st-edge) calc(var(--st-space-12) * 2); }
.sp header { text-align: center; padding: var(--st-space-12) 0 var(--st-space-8); }
.sp header .st-title { margin: 0; text-indent: var(--st-track-title); }
.sp header .st-caption { margin: var(--st-space-4) 0 0; text-indent: var(--st-track-wide); }
.sp section { margin-top: calc(var(--st-space-12) + var(--st-space-6)); }
.sp h2 { margin: 0 0 var(--st-space-2); text-indent: 0; }
.sp .lede { margin: 0 0 var(--st-space-6); max-width: 62ch; }
.sp b { font-weight: inherit; color: var(--st-strong); }
.bar { display: flex; flex-wrap: wrap; gap: var(--st-space-1) var(--st-space-4); align-items: baseline; margin-bottom: var(--st-space-3); }
.bar button { font: var(--st-font-fine); letter-spacing: var(--st-track); color: var(--st-faint); background: none; border: 0;
  border-bottom: 1px solid transparent; padding: var(--st-space-1) 0; min-height: var(--st-hit); cursor: pointer;
  transition: color var(--st-fast) var(--st-ease); }
.bar button:hover { color: var(--st-strong); }
.bar button[aria-pressed=true] { color: var(--st-lit); border-bottom-color: var(--st-mark); }
.bar button:focus-visible { outline: var(--st-focus); outline-offset: 2px; }

/* ---- stages: the chrome over stand-in particles ---- */
.stage { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--st-hair); background: var(--st-void); }
.stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.stage .tag { position: absolute; left: var(--st-space-3); top: var(--st-space-2); z-index: 1; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: var(--st-space-4); margin-top: var(--st-space-4); }
@media (max-width: 760px) { .pair { grid-template-columns: 1fr; } .stage.app { aspect-ratio: 3 / 4; } .stage.stopped, .stage.nogpu { aspect-ratio: 1 / 1; } }
.over { text-shadow: var(--st-halo); }

.dot { position: absolute; right: var(--st-edge); top: var(--st-edge); width: 6px; height: 6px; border-radius: 50%; background: var(--st-lit); }
.die { position: absolute; left: 50%; bottom: var(--st-edge); width: 28px; height: 28px; margin-left: -14px; color: var(--st-faint); }
.die rect { fill: none; stroke: currentColor; }
.die circle { fill: currentColor; }
.stats { position: absolute; bottom: var(--st-edge); display: flex; gap: var(--st-space-4); white-space: nowrap; }
.stats.left { left: var(--st-edge); }
.stats.right { right: var(--st-edge); }
.announce { position: absolute; left: 0; right: 0; bottom: 17%; text-align: center; }
.announce div { text-indent: var(--st-track-wide); }
.announce .name { color: var(--st-strong); letter-spacing: var(--st-track-title); text-indent: var(--st-track-title); }
.hint { position: absolute; left: 0; right: 0; bottom: calc(var(--st-edge) + var(--st-space-12)); text-align: center; text-indent: var(--st-track-wide); }
.card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
.card .st-title { text-indent: var(--st-track-title); font-size: clamp(28px, 4.2vw, 48px); }
.card .st-caption { margin-top: var(--st-space-4); text-indent: var(--st-track-wide); color: var(--st-dim); }

.menu { position: absolute; right: var(--st-edge); top: calc(var(--st-edge) + var(--st-space-6)); width: 312px; max-width: calc(100% - 2 * var(--st-edge));
  background: var(--st-surface); border: 1px solid var(--st-hair); -webkit-backdrop-filter: blur(var(--st-blur)); backdrop-filter: blur(var(--st-blur)); }
.menu > div { padding: var(--st-space-3) var(--st-space-4); }
.menu > div + div { border-top: 1px solid var(--st-hair); }
.menu .fps { display: flex; align-items: baseline; gap: var(--st-space-2); }
.menu .facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--st-space-2); margin-top: var(--st-space-3); }
.menu .facts b, .menu .facts span { display: block; }
.menu .tabs { display: flex; gap: var(--st-space-4); padding-bottom: 0; }
.menu .tabs span { padding-bottom: var(--st-space-2); border-bottom: 1px solid transparent; margin-bottom: -1px; }
.menu .tabs .on { color: var(--st-lit); border-bottom-color: var(--st-mark); }
.menu .row { display: flex; justify-content: space-between; align-items: center; min-height: 28px; }
.menu .track { height: 1px; margin: var(--st-space-1) 0 var(--st-space-3); position: relative;
  background: linear-gradient(var(--st-mark), var(--st-mark)) 0 0 / var(--at) 100% no-repeat, var(--st-stroke); }
.menu .track::after { content: ""; position: absolute; left: var(--at); top: -5px; width: 3px; height: 11px; margin-left: -1px; background: var(--st-mark); }
.menu .switch { width: 10px; height: 10px; border: 1px solid var(--st-stroke); }
.menu .switch.on { background: var(--st-mark); border-color: var(--st-mark); }
.menu .foot { display: flex; justify-content: space-between; }

/* A card that takes over the screen: the scrim dims the picture, the panel holds the words. */
.scrim { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: var(--st-edge); background: var(--st-scrim); }
.panel { max-width: 30em; text-align: center; padding: var(--st-space-8) var(--st-space-6); background: var(--st-surface); border: 1px solid var(--st-hair); }
.panel .st-caption { margin: 0 0 var(--st-space-3); color: var(--st-strong); text-indent: var(--st-track-wide); }
.panel p { margin: 0 auto var(--st-space-2); text-wrap: balance; }
.panel .count { color: var(--st-strong); font-variant-numeric: tabular-nums; }
.actions { display: flex; flex-wrap: wrap; gap: var(--st-space-3); margin-top: var(--st-space-4); }
.panel .actions { justify-content: center; }
/* A note over the picture, with nothing behind it but the halo. */
.note { position: absolute; left: 0; right: 0; bottom: calc(var(--st-edge) + var(--st-space-6)); padding: 0 var(--st-edge); text-align: center; }
.note p { margin: 0 auto; max-width: 34em; text-wrap: balance; }
.note .st-caption { margin-bottom: var(--st-space-3); color: var(--st-dim); text-indent: var(--st-track-wide); }
.note .st-button { margin-top: var(--st-space-4); }

.challenge { position: absolute; left: var(--st-edge); bottom: var(--st-edge); }
.challenge .st-figure { margin: var(--st-space-1) 0 var(--st-space-2); }
.challenge .st-caption { text-indent: 0; }
.challenge .facts { display: flex; gap: var(--st-space-4); }
.challenge .gap { height: var(--st-space-2); }

/* ---- tables of tokens ---- */
.rows { border-top: 1px solid var(--st-hair); }
.rows > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: var(--st-space-6); align-items: center;
  padding: var(--st-space-4) 0; border-bottom: 1px solid var(--st-hair); }
.rows .sample { overflow: hidden; }
.rows .st-title { font-size: clamp(22px, 3.4vw, 40px); }
@media (max-width: 760px) { .rows > div { grid-template-columns: 1fr; gap: var(--st-space-2); } }
.ink { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--st-space-4); }
.ink .chip { height: var(--st-space-12); border-bottom: 1px solid; margin-bottom: var(--st-space-2); display: flex; align-items: flex-end; font: var(--st-font-figure); padding-bottom: var(--st-space-1); }
@media (max-width: 760px) { .ink { grid-template-columns: repeat(2, 1fr); } }
.steps { display: flex; align-items: flex-end; gap: var(--st-space-4); flex-wrap: wrap; }
.steps i { display: block; width: var(--w); height: var(--w); border: 1px solid var(--st-stroke); margin-bottom: var(--st-space-2); }
.actions.above { margin: 0 0 var(--st-space-4); }
.timing { display: grid; grid-template-columns: 9em 1fr; gap: var(--st-space-3) var(--st-space-4); align-items: center; }
.timing .lane { height: 1px; background: var(--st-hair); position: relative; }
.timing .lane i { position: absolute; left: 0; top: -3px; width: 7px; height: 7px; border-radius: 50%; background: var(--st-lit); opacity: var(--st-a-faint);
  transition: left var(--ms) var(--st-ease), opacity var(--ms) var(--st-ease); }
.timing.go .lane i { left: calc(var(--st-travel) * (100% - 7px)); opacity: 1; }
.map { display: grid; grid-template-columns: repeat(3, 1fr); grid-template-rows: repeat(3, 1fr); aspect-ratio: 16 / 7; border: 1px solid var(--st-hair); }
.map div { padding: var(--st-space-3); display: flex; }
.map div:nth-child(3n + 2) { justify-content: center; text-align: center; }
.map div:nth-child(3n) { justify-content: flex-end; text-align: right; }
.map div:nth-child(n + 4):nth-child(-n + 6) { align-items: center; }
.map div:nth-child(n + 7) { align-items: flex-end; }
`;
document.head.append(style);

// ---- stand-in particles ---------------------------------------------------------
/** A still frame of additive white points: sparse drift plus one dense core, so text can be judged over both. */
function particles(canvas: HTMLCanvasElement, seed: number, core: [number, number]): void {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0), ((s ^ (s >>> 13)) >>> 0) / 4294967296);
  const w = (canvas.width = 1280);
  const hgt = (canvas.height = 720);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, hgt);
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  for (let i = 0; i < 26000; i++) {
    const x = rnd() * w;
    const y = rnd() * hgt;
    const band = 0.5 + 0.5 * Math.sin(x * 0.011 + Math.sin(y * 0.013 + seed) * 2.2);
    if (rnd() < band * band) ctx.fillRect(x, y, 1.2, 1.2);
  }
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  for (let i = 0; i < 52000; i++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 1.7) * hgt * 0.34;
    ctx.fillRect(core[0] * w + Math.cos(a) * r * 1.5, core[1] * hgt + Math.sin(a) * r, 1.2, 1.2);
  }
}

const canvases: HTMLCanvasElement[] = [];
function stage(kind: string, label: string, seed: number, core: [number, number], ...chrome: Child[]): HTMLElement {
  const canvas = document.createElement("canvas");
  particles(canvas, seed, core);
  canvases.push(canvas);
  return h(`div.stage.${kind}`, canvas, h("div.tag.st-fine.over", label), ...chrome);
}

const SVG = "http://www.w3.org/2000/svg";
function die(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 28 28");
  svg.setAttribute("class", "die");
  svg.innerHTML =
    '<rect x="2.5" y="2.5" width="23" height="23" rx="4"/>' +
    [[8.5, 8.5], [19.5, 8.5], [14, 14], [8.5, 19.5], [19.5, 19.5]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7"/>`).join("");
  return svg;
}

/** "label value" pairs in the instrument voice: the value strong, the label dim. */
const stat = (value: string, label = "") => h("span", h("b", value), label && ` ${label}`);
const line = (role: Role, ...children: Child[]) => h(`div.st-${role}`, ...children);

/** The one button (.st-button). `primary` marks the action Enter picks. */
function button(label: string, primary = false): HTMLButtonElement {
  const b = h(primary ? "button.st-button.is-primary" : "button.st-button", label) as HTMLButtonElement;
  b.type = "button";
  return b;
}

function slider(label: string, value: string, at: number): HTMLElement[] {
  const track = h("div.track");
  track.style.setProperty("--at", `${at}%`);
  return [h("div.row.st-data", h("span", label), h("b", value)), track];
}

const menu = h(
  "div.menu",
  h(
    "div",
    h("div.fps", h("span.st-figure", "60"), h("span.st-data", "fps"), h("span.st-data", "16.7 ms")),
    h("div.facts.st-data", h("div", h("b", "4.19M"), h("span.st-fine", "simulated")), h("div", h("b", "2560×1440"), h("span.st-fine", "pixels")), h("div", h("b", "boids"), h("span.st-fine", "behavior"))),
  ),
  h("div.tabs.st-data", h("span.on", "scene"), h("span", "behaviors"), h("span", "look"), h("span", "perf")),
  h(
    "div",
    ...slider("particles", "4.19M", 68),
    ...slider("speed", "1.00", 34),
    h("div.row.st-data", h("span", "trails"), h("i.switch.on")),
    h("div.row.st-data", h("span", "pause"), h("i.switch")),
  ),
  h("div.foot.st-fine", h("span", "reset"), h("span", "stats"), h("span", "? keys")),
);

const app = stage(
  "app", "the app, menu open", 7, [0.3, 0.42],
  h("div.dot"),
  menu,
  h("div.announce.over", h("div.st-caption.name", "plane 02"), h("div.st-caption", "boids")),
  die(),
  h("div.stats.left.st-data.over", stat("4.19M"), stat("0:42"), stat("60", "fps")),
  h("div.stats.right.st-data.over", stat("boids"), stat("plane 02")),
);

const opening = stage(
  "open", "first seconds", 21, [0.5, 0.5],
  h("div.card.over", h("div.st-title", "Strata"), h("div.st-caption", "drag to turn · scroll to dive · R for a new world")),
  h("div.hint.st-caption.over", "drag to turn"),
  die(),
);

const challenge = stage(
  "run", "challenge mode", 44, [0.72, 0.4],
  h(
    "div.challenge.over",
    line("caption", "challenge · simulated"),
    line("figure", "148,000,000"),
    h("div.st-data.facts", stat("31.2", "fps"), stat("71.4", "per pixel"), stat("100%", "of tier 1")),
    line("fine", "climbing, trying 160M"),
    h("div.gap"),
    line("fine", "gpu 12.1 ms · 1129 MB state · 1920×1080 · 24 sheets"),
    h("div.st-fine.facts", stat("M", "mode"), stat("R", "restart"), stat("C", "copy result"), stat("I", "hide")),
  ),
);

const stopped = stage(
  "stopped", "a card: the picture stopped", 63, [0.42, 0.5],
  h(
    "div.scrim",
    h(
      "div.panel.st-body",
      h("div.st-caption", "The graphics device stopped"),
      h("p", "The picture is frozen. This often means the GPU ran out of memory."),
      h("p.count", "restarting in 4 s"),
      h("div.actions", button("restart now", true), button("stay here")),
    ),
  ),
);

const noGpu = stage(
  "nogpu", "no WebGPU: one sheet on the CPU", 80, [0.5, 0.36],
  h(
    "div.note.over",
    h("p.st-caption", "One sheet. 24,000 particles."),
    h("p.st-body", "The full world is many sheets and millions of particles. This browser has no WebGPU yet. Chrome or Edge on a desktop computer runs it."),
    button("copy link"),
  ),
);

// ---- switches: each one overrides a token on :root ------------------------------
const root = document.documentElement.style;
function choice(label: string, options: string[], pick: (i: number) => void): { el: HTMLElement; set(i: number): void } {
  const buttons = options.map((text, i) => {
    const b = h("button", text) as HTMLButtonElement;
    b.type = "button";
    b.addEventListener("click", () => set(i));
    return b;
  });
  const set = (i: number) => {
    buttons.forEach((b, j) => b.setAttribute("aria-pressed", String(i === j)));
    pick(i);
  };
  return { el: h("div.bar", h("span.st-fine", label), ...buttons), set };
}

const typeChoice = choice("type", ["1 two voices", "2 all mono", "3 all sans"], (i) => {
  root.removeProperty("--st-sans");
  root.removeProperty("--st-mono");
  if (i === 1) root.setProperty("--st-sans", DESIGN.font.mono);
  if (i === 2) root.setProperty("--st-mono", DESIGN.font.sans);
});
let themeAt = 0;
const themeChoice = choice("theme", THEMES.map((t) => t.label), (i) => {
  themeAt = i;
  for (const c of canvases) applyTheme(c, THEMES[i].id);
  setAccent(accentOf(THEMES[i].stops));
});
addEventListener("keydown", (e) => {
  if (e.key >= "1" && e.key <= "3") typeChoice.set(Number(e.key) - 1);
  if (e.key.toLowerCase() === "t") themeChoice.set((themeAt + 1) % THEMES.length);
});

// ---- the token tables -----------------------------------------------------------
const ROLE_NOTES: Array<[Role, string, string]> = [
  ["title", "Strata", "title: thin sans, fluid 28 to 64px, capitals, 0.5em tracking. The name, or a page's one headline."],
  ["caption", "drag to turn", "caption: sans 11px, capitals, 0.3em tracking. One line spoken to the person: hints, the name of a roll."],
  ["body", "The full world is hundreds of sheets and 64 million particles.", "body: sans 13px, sentence case. Anything longer than a line."],
  ["data", "particles  4.19M", "data: mono 13px, tabular numbers. Stats, the menu, the keys sheet, status lines. Labels lowercase, values keep their case."],
  ["fine", "gpu 12.1 ms · 24 sheets", "fine: mono 11px. Units, section names, footers, the small print of a readout."],
  ["figure", "148,000,000", "figure: thin sans 34px, tabular numbers. One hero number per view."],
];
const INK_NOTES: Record<keyof typeof DESIGN.alpha, string> = {
  strong: "values, titles, anything active",
  dim: "labels, sentences",
  faint: "captions, hints, small print",
  stroke: "outlines of controls",
  hair: "separators, decoration only",
};

const types = h("div.rows", ...ROLE_NOTES.map(([role, sample, note]) => h("div", h(`div.sample.st-${role}`, sample), h("div.st-fine", note))));

const ink = h(
  "div.ink",
  ...(Object.keys(DESIGN.alpha) as Array<keyof typeof DESIGN.alpha>).map((name) => {
    const chip = h("div.chip", "Aa");
    chip.style.color = `var(--st-${name})`;
    return h("div", chip, line("data", h("b", name), ` ${DESIGN.alpha[name]}`), line("fine", `${contrastOnVoid(DESIGN.alpha[name]).toFixed(1)}:1 · ${INK_NOTES[name]}`));
  }),
);

const steps = h(
  "div.steps",
  ...DESIGN.space.map((n) => {
    const box = h("i");
    box.style.setProperty("--w", `var(--st-space-${n})`);
    return h("div", box, line("fine", `space-${n} · ${n * DESIGN.unit}`));
  }),
);

const timing = h("div.timing");
for (const [name, note] of [["fast", "answers an input"], ["medium", "words about what just happened"], ["slow", "arrives unasked, and leaves"]] as const) {
  const lane = h("div.lane", h("i"));
  lane.style.setProperty("--ms", `var(--st-${name})`);
  timing.append(h("div", line("data", h("b", name), ` ${DESIGN.ms[name]}ms`), line("fine", note)), lane);
}
const play = button("play");
play.addEventListener("click", () => timing.classList.toggle("go"));

const MAP = [
  "fps in the corner (optional)", "", "menu dot, the menu opens under it",
  "", "title · message · keys sheet", "",
  "stats (H): count, time, fps · challenge readout", "die · a status line takes its place · captions sit above it", "stats (H): behavior, plane",
];
const map = h("div.map", ...MAP.map((text) => h("div.st-fine", text)));

const section = (title: string, lede: string, ...children: Child[]) => h("section", h("h2.st-caption", title), h("p.lede.st-body", lede), ...children);

document.body.append(
  h(
    "main.sp",
    h("header", h("h1.st-title", "Strata"), h("p.st-caption", "design tokens · specimen")),
    section(
      "in use",
      "The chrome over stand-in particles. Switch the type option or the color theme: each switch overrides one token, and everything follows.",
      typeChoice.el, themeChoice.el, app, h("div.pair", opening, challenge, stopped, noGpu),
    ),
    section("type", "Two voices. Thin wide capitals speak to the person; monospace reports the machine. Large text is thin, so every stroke on screen stays about a pixel wide.", types),
    section("ink", "One color at five strengths, with its contrast on black. Text never drops below faint. A color theme never changes the ink.", ink),
    section("space", "A 4px unit and seven steps. Lines are one pixel, corners are square, and only points are round.", steps),
    section(
      "button",
      "One button for every card and note: a caption in a one pixel outline. The stronger outline marks the action that Enter picks. Controls inside the menu are instruments and stay in the menu's own voice.",
      h("div.actions", button("restart now", true), button("stay here"), button("copy details")),
    ),
    section("motion", "Answer fast, arrive slowly, leave slowly. Only opacity and small moves, so the chrome never costs a frame.", h("div.actions.above", play), timing),
    section("stage", "Where chrome lives. One thing per region at a time, and the middle of the screen belongs to the particles.", map),
  ),
);
typeChoice.set(0);
themeChoice.set(0);

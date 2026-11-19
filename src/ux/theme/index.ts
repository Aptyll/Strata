/**
 * Color themes for the live app: a gradient map applied after the tone map.
 *
 * The tone-mapped canvas is grey (density reads as brightness). Each theme maps
 * that brightness through a small color ramp, so "red" means dark red for a
 * lone particle up to bright red / white-hot where thousands overlap.
 *
 * Cost: zero per particle. It is one SVG filter on the canvas element
 * (luminance, then a per-channel lookup table), run by the browser compositor
 * on the finished frame. The simulation, rasterizer and tone map are untouched,
 * and the "white" theme removes the filter entirely.
 *
 * Wiring (main.ts): `mountThemes(hud, canvas)`. Adds a "theme" select to the
 * Esc menu (saved like other HUD settings), the T key to cycle, and
 * `?theme=<id>` in the URL to share or force a theme.
 */
import type { Hud } from "../hud/index.js";

/** A ramp from black (no particles) to the densest color, as [r, g, b] stops in 0..1. */
export interface Theme {
  id: string;
  label: string;
  stops: Array<[number, number, number]>;
}

export const THEMES: Theme[] = [
  { id: "white", label: "white", stops: [] },
  { id: "red", label: "red", stops: [[0, 0, 0], [0.55, 0.02, 0.02], [1, 0.12, 0.08], [1, 0.75, 0.7]] },
  { id: "blue", label: "blue", stops: [[0, 0, 0], [0.02, 0.08, 0.6], [0.15, 0.4, 1], [0.8, 0.9, 1]] },
  // Duotone: sparse areas blue, dense areas red, the busiest cores white.
  { id: "red-blue", label: "red + blue", stops: [[0, 0, 0], [0.05, 0.15, 0.9], [0.55, 0.1, 0.65], [1, 0.12, 0.15], [1, 0.85, 0.85]] },
  { id: "amber", label: "amber", stops: [[0, 0, 0], [0.5, 0.22, 0], [1, 0.62, 0.1], [1, 0.95, 0.75]] },
  { id: "cyan", label: "cyan", stops: [[0, 0, 0], [0, 0.35, 0.4], [0.1, 0.9, 1], [0.85, 1, 1]] },
  { id: "ice", label: "ice", stops: [[0, 0, 0], [0.25, 0.35, 0.55], [0.6, 0.8, 0.95], [1, 1, 1]] },
  { id: "green", label: "green", stops: [[0, 0, 0], [0, 0.4, 0.08], [0.2, 1, 0.3], [0.85, 1, 0.85]] },
  { id: "violet", label: "violet", stops: [[0, 0, 0], [0.3, 0.05, 0.55], [0.7, 0.35, 1], [0.95, 0.88, 1]] },
  // Heat / infrared: black, deep red, orange, yellow, white.
  { id: "heat", label: "infrared heat", stops: [[0, 0, 0], [0.45, 0, 0.1], [0.95, 0.25, 0], [1, 0.8, 0.1], [1, 1, 1]] },
];

const SVG_NS = "http://www.w3.org/2000/svg";
const FILTER_ID = "strata-theme";

/** Sample a theme's stops into N evenly spaced table values per channel. */
function tables(theme: Theme, n = 17): [string, string, string] {
  const out: number[][] = [[], [], []];
  const last = theme.stops.length - 1;
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * last;
    const a = Math.min(last - 1, Math.floor(t));
    const f = t - a;
    for (let c = 0; c < 3; c++) out[c].push(theme.stops[a][c] * (1 - f) + theme.stops[a + 1][c] * f);
  }
  return out.map((v) => v.map((x) => x.toFixed(3)).join(" ")) as [string, string, string];
}

function ensureFilter(): SVGFilterElement {
  let filter = document.getElementById(FILTER_ID) as SVGFilterElement | null;
  if (filter) return filter;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute";
  filter = document.createElementNS(SVG_NS, "filter");
  filter.id = FILTER_ID;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  // Grey canvas, so luminance is just the brightness the tone map produced.
  const matrix = document.createElementNS(SVG_NS, "feColorMatrix");
  matrix.setAttribute("type", "matrix");
  matrix.setAttribute("values", "0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0");
  const transfer = document.createElementNS(SVG_NS, "feComponentTransfer");
  for (const ch of ["R", "G", "B"]) {
    const fn = document.createElementNS(SVG_NS, `feFunc${ch}`);
    fn.setAttribute("type", "table");
    transfer.appendChild(fn);
  }
  filter.append(matrix, transfer);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return filter;
}

/** Apply a theme by id to an element (the canvas). Unknown ids fall back to white. */
export function applyTheme(target: HTMLElement, id: string): Theme {
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  if (theme.stops.length < 2) {
    target.style.filter = "";
    return theme;
  }
  const filter = ensureFilter();
  const funcs = filter.querySelectorAll("feComponentTransfer > *");
  tables(theme).forEach((values, c) => funcs[c].setAttribute("tableValues", values));
  target.style.filter = `url(#${FILTER_ID})`;
  return theme;
}

/** Esc menu "theme" select, T to cycle, ?theme=<id> to share. */
export function mountThemes(hud: Hud, target: HTMLElement): { set(id: string): void; dispose(): void } {
  const fromUrl = new URLSearchParams(location.search).get("theme");
  let current = "white";
  const onChange = (id: string) => {
    current = applyTheme(target, id).id;
    // Keep a shared link showing the theme; the dice own the hash, so this rides in the query.
    if (new URLSearchParams(location.search).has("theme") || current !== "white") {
      const url = new URL(location.href);
      if (current === "white") url.searchParams.delete("theme");
      else url.searchParams.set("theme", current);
      history.replaceState(history.state, "", url);
    }
  };
  hud.registerParam({
    id: "theme", label: "color theme", type: "select", group: "theme",
    value: "white",
    options: THEMES.map((t) => ({ value: t.id, label: t.label })),
    onChange,
  });
  // A ?theme in the URL wins over the saved choice.
  if (fromUrl && THEMES.some((t) => t.id === fromUrl)) hud.setParam("theme", fromUrl);
  else onChange(String(hud.getParam("theme") ?? "white"));

  const off = hud.registerShortcut({
    key: "t", label: "next color theme",
    run: () => {
      const i = THEMES.findIndex((t) => t.id === current);
      hud.setParam("theme", THEMES[(i + 1) % THEMES.length].id);
    },
  });
  return {
    set: (id) => void hud.setParam("theme", id),
    dispose: () => {
      off();
      target.style.filter = "";
    },
  };
}

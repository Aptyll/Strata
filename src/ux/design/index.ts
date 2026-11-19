/**
 * Strata's design tokens: what the chrome looks like, in one place.
 *
 * "Chrome" is everything on screen that is not particles: the HUD, the Esc
 * menu, hints, the title card, Challenge mode's readout, status lines. All of
 * it takes its font, sizes, colors, spacing and timing from here, as CSS
 * custom properties named `--st-*`. Rules and examples: docs/ux/design.md.
 * Specimen page: /src/ux/design/demo/.
 *
 *   installTokens();   // once per page; safe to call from every module that draws chrome
 *   .my-line { font: var(--st-font-fine); color: var(--st-dim); }
 *
 * The system in five lines:
 *   color   one ink (white) on one void (black) at five strengths; text never changes hue
 *   type    two voices: thin wide capitals speak to the person, monospace reports the machine
 *   space   a 4px unit, one pixel lines, square corners; circles only for points
 *   motion  answer fast, arrive slowly, leave slowly; opacity and small moves only
 *   themes  a color theme recolors the particles and the accent marks, never the text
 */

/** A color as [r, g, b] in 0..1, the form the color themes use for their stops. */
export type Rgb = readonly [number, number, number];

/** The values behind the stylesheet, for code that cannot read CSS (canvas text, tests). */
export const DESIGN = {
  /** The chrome's one color and the void it sits on, as 0..255 channels. */
  ink: [255, 255, 255],
  void: [0, 0, 0],
  /**
   * How much of the ink a thing gets. Contrast on black in brackets (text needs 4.5, marks 3).
   * strong [16.7] values, titles, anything active      dim [8.6] labels, sentences
   * faint [4.9] captions, hints, section titles        stroke [3.1] outlines of controls
   * hair [1.4] separators, decoration only
   */
  alpha: { strong: 0.9, dim: 0.65, faint: 0.48, stroke: 0.36, hair: 0.16 },
  /**
   * Black behind a panel and behind a full-screen sheet, and the blur under a panel in px.
   * With white-hot particles behind them, faint text still reads on a panel and dim text on a sheet.
   */
  surface: { panel: 0.88, scrim: 0.8, blur: 10 },
  font: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  /** The whole type scale in px. Large text is thin, so every stroke stays near a pixel wide. */
  size: { xs: 11, sm: 13, md: 17, lg: 22, xl: 34 },
  display: "clamp(28px, 6vw, 64px)",
  weight: { regular: 400, thin: 200 },
  /** Letter spacing in em: instrument text, wide capitals, the title. */
  track: { data: 0.04, wide: 0.3, title: 0.5 },
  leading: 1.5,
  /** Spacing unit in px and the multiples in use. */
  unit: 4,
  space: [1, 2, 3, 4, 6, 8, 12],
  /** Distance from the viewport edge to chrome, and the smallest target for a pointer or a finger, in px. */
  edge: { wide: 20, narrow: 16 },
  hit: { pointer: 24, touch: 44 },
  /** `out` for anything that answers input, `soft` for slow fades and breathing. */
  ease: { out: "cubic-bezier(0.2, 0, 0, 1)", soft: "cubic-bezier(0.4, 0, 0.6, 1)" },
  /** fast: answer an input. medium: text that answers an input. slow: arrive unasked, and leave. */
  ms: { fast: 180, medium: 480, slow: 1200 },
} as const;

/** The text roles. Every piece of text on screen is exactly one of these. */
export type Role = "title" | "caption" | "body" | "data" | "fine" | "figure";

const D = DESIGN;
const roles: Record<Role, { font: string; ink: string; more?: string }> = {
  // Voice: words spoken to the person.
  title: { font: `${D.weight.thin} var(--st-size-display)/1 var(--st-sans)`, ink: "strong", more: "letter-spacing: var(--st-track-title); text-transform: uppercase;" },
  caption: { font: `${D.weight.regular} var(--st-size-xs)/var(--st-leading) var(--st-sans)`, ink: "faint", more: "letter-spacing: var(--st-track-wide); text-transform: uppercase;" },
  body: { font: `${D.weight.regular} var(--st-size-sm)/var(--st-leading) var(--st-sans)`, ink: "dim" },
  // Instrument: what the machine reports and what the person tunes.
  data: { font: `${D.weight.regular} var(--st-size-sm)/var(--st-leading) var(--st-mono)`, ink: "dim", more: "letter-spacing: var(--st-track); font-variant-numeric: tabular-nums;" },
  fine: { font: `${D.weight.regular} var(--st-size-xs)/var(--st-leading) var(--st-mono)`, ink: "faint", more: "letter-spacing: var(--st-track); font-variant-numeric: tabular-nums;" },
  figure: { font: `${D.weight.thin} var(--st-size-xl)/1 var(--st-sans)`, ink: "strong", more: "font-variant-numeric: tabular-nums;" },
};
const ROLES = Object.keys(roles) as Role[];
const roleCss = (r: Role) => `font: var(--st-font-${r}); ${roles[r].more ?? ""} color: var(--st-${roles[r].ink});`;

/**
 * Each role as CSS declarations, for stylesheets written as strings:
 *   `.strata-hint { ${TYPE.caption} position: absolute; }`
 * Markup can use the classes instead: `<p class="st-caption">`.
 */
export const TYPE = Object.fromEntries(ROLES.map((r) => [r, roleCss(r)])) as Record<Role, string>;

const levels = Object.entries(D.alpha) as Array<[keyof typeof D.alpha, number]>;

/** The stylesheet: every token on :root, the role classes, and what people's system settings change. */
export const TOKENS_CSS = `
:root {
  /* color: one ink on one void */
  --st-void: rgb(${D.void.join(", ")});
  --st-shade: ${D.void.join(", ")};
  --st-ink: ${D.ink.join(", ")};
  --st-accent: var(--st-ink);
${levels.map(([name, a]) => `  --st-a-${name}: ${a};`).join("\n")}
  --st-lit: rgb(var(--st-ink));
${levels.map(([name]) => `  --st-${name}: rgba(var(--st-ink), var(--st-a-${name}));`).join("\n")}
  --st-mark: rgb(var(--st-accent));
  --st-a-surface: ${D.surface.panel};
  --st-surface: rgba(var(--st-shade), var(--st-a-surface));
  --st-scrim: rgba(var(--st-shade), ${D.surface.scrim});
  --st-blur: ${D.surface.blur}px;
  --st-halo: 0 0 6px rgba(var(--st-shade), 0.9), 0 0 12px rgba(var(--st-shade), 0.9);
  --st-focus: 2px solid rgb(var(--st-ink));

  /* type: two families, six sizes, three trackings */
  --st-sans: ${D.font.sans};
  --st-mono: ${D.font.mono};
${Object.entries(D.size).map(([name, px]) => `  --st-size-${name}: ${px}px;`).join("\n")}
  --st-size-display: ${D.display};
  --st-track: ${D.track.data}em;
  --st-track-wide: ${D.track.wide}em;
  --st-track-title: ${D.track.title}em;
  --st-leading: ${D.leading};
${ROLES.map((r) => `  --st-font-${r}: ${roles[r].font};`).join("\n")}

  /* space and shape */
  --st-u: ${D.unit}px;
${D.space.map((n) => `  --st-space-${n}: ${n * D.unit}px;`).join("\n")}
  --st-edge: ${D.edge.wide}px;
  --st-edge-top: calc(var(--st-edge) + env(safe-area-inset-top, 0px));
  --st-edge-right: calc(var(--st-edge) + env(safe-area-inset-right, 0px));
  --st-edge-bottom: calc(var(--st-edge) + env(safe-area-inset-bottom, 0px));
  --st-edge-left: calc(var(--st-edge) + env(safe-area-inset-left, 0px));
  --st-hit: ${D.hit.pointer}px;
  --st-radius: 0px;

  /* motion: 1 = things may travel, 0 = they only fade */
  --st-ease: ${D.ease.out};
  --st-ease-soft: ${D.ease.soft};
  --st-fast: ${D.ms.fast}ms;
  --st-medium: ${D.ms.medium}ms;
  --st-slow: ${D.ms.slow}ms;
  --st-travel: 1;

  /* layers: text over the void, the HUD, anything that must sit above the HUD */
  --st-z-caption: 5;
  --st-z-hud: 10;
  --st-z-top: 20;
}
${ROLES.map((r) => `.st-${r} { ${roleCss(r)} }`).join("\n")}

@media (max-width: 520px) { :root { --st-edge: ${D.edge.narrow}px; } }
@media (pointer: coarse) { :root { --st-hit: ${D.hit.touch}px; } }
@media (prefers-reduced-motion: reduce) {
  :root { --st-medium: var(--st-fast); --st-slow: var(--st-fast); --st-travel: 0; }
}
@media (prefers-contrast: more) {
  :root { --st-a-strong: 1; --st-a-dim: 0.85; --st-a-faint: 0.75; --st-a-stroke: 0.7; --st-a-hair: 0.5; --st-a-surface: 1; --st-blur: 0px; }
}
@media (prefers-reduced-transparency: reduce) { :root { --st-a-surface: 1; --st-blur: 0px; } }
`;

const STYLE_ID = "strata-tokens";

/** Put the tokens on the page. Does nothing the second time. */
export function installTokens(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = TOKENS_CSS;
  doc.head.prepend(style); // first in the head, so any stylesheet after it can override a token
}

/**
 * Give the accent marks a color, or pass null for the ink again. The color
 * themes call this, so a slider's fill and a selected tab match the particles.
 */
export function setAccent(color: Rgb | null, doc: Document = document): void {
  const root = doc.documentElement.style;
  if (color) root.setProperty("--st-accent", color.map((c) => Math.round(c * 255)).join(", "));
  else root.removeProperty("--st-accent");
}

/**
 * A color ramp's signature color: the last stop before its white-hot end.
 * Null for an empty ramp (the white theme), which leaves the marks in the ink.
 */
export function accentOf(stops: ReadonlyArray<Rgb>): Rgb | null {
  if (stops.length === 0) return null;
  return stops[Math.max(0, stops.length - 2)];
}

/** WCAG contrast of a color at `alpha` over the black void. Text needs 4.5, marks and outlines 3. */
export function contrastOnVoid(alpha: number, color: Rgb = [1, 1, 1]): number {
  const linear = (c: number) => {
    const s = c * alpha;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
  return (luminance + 0.05) / 0.05;
}

# Design system

How every piece of chrome in Strata looks. "Chrome" is everything on screen
that is not particles: the HUD, the Esc menu, hints, the title card, Challenge
mode's readout, status lines, the no-WebGPU page.

Code: `src/ux/design/index.ts` (the tokens, about 150 lines). Specimen, with
every token shown in use: `/src/ux/design/demo/` (ships in the production
build, so it is also on the live site).

## The system in five rules

1. **One ink on one void.** White on black, at five strengths. Hierarchy comes
   from strength and size, never from hue.
2. **Two voices.** Thin wide capitals speak to the person (title, hints, the
   name of a roll). Monospace reports the machine (stats, the menu, Challenge).
3. **Points and lines.** Lines are one pixel, corners are square, and only
   points are round (the menu dot, the die's pips). Large text is thin, so
   every stroke on screen stays about a pixel wide.
4. **Answer fast, arrive slowly, leave slowly.** Chrome that answers an input
   takes 180 ms. Chrome that shows up unasked, or goes away, takes 1.2 s. Only
   opacity and small moves, so the chrome never costs a frame.
5. **Themes color the particles and the marks, never the text.** A color
   theme sets one accent. Marks that show a value or a selection take it;
   text stays in the ink, so it reads the same in every theme.

## Using it

Call `installTokens()` from the module that draws the chrome. It is safe to
call from every module; only the first call does anything.

```ts
import { TYPE, installTokens } from "../design";

installTokens();
const CSS = `
.my-line { ${TYPE.fine} position: absolute; left: var(--st-edge-left); bottom: var(--st-edge-bottom); }
.my-line b { color: var(--st-strong); font-weight: inherit; }
`;
```

- **Markup** can use the role classes instead: `<p class="st-caption">`.
- **Inline styles** take the same tokens: `el.style.font = "var(--st-font-fine)"`.
- **Plain JS stylesheets** (the HUD) and **`index.html`** cannot import the
  module, so they write `var(--st-dim, rgba(255, 255, 255, 0.65))` with the
  value as a fallback. The fallback must match the token; the HUD has a test
  for that (`src/ux/hud/tokens.test.js`).
- **Canvas text and tests** read the raw values from `DESIGN`.

## Type

Every piece of text is exactly one of six roles.

| role | looks like | use it for |
| --- | --- | --- |
| `title` | thin sans, 28 to 64 px (fluid), capitals, 0.5em tracking | the name, or a page's one headline |
| `caption` | sans 11 px, capitals, 0.3em tracking, faint | one line spoken to the person: a hint, the name of a roll |
| `body` | sans 13 px, sentence case, dim | anything longer than a line |
| `data` | mono 13 px, tabular numbers, dim | stats, the menu, the keys sheet, status lines |
| `fine` | mono 11 px, tabular numbers, faint | units, section names, footers, small print |
| `figure` | thin sans 34 px, tabular numbers, strong | one hero number per view |

- **Which voice?** If the person is being told something, it is the voice
  (`title`, `caption`, `body`). If the machine is reporting something or the
  person is tuning something, it is the instrument (`data`, `fine`, `figure`).
- **Sizes** are the scale and nothing else: 11, 13, 17, 22, 34 px and the fluid
  display size (`--st-size-xs` to `--st-size-xl`, `--st-size-display`).
  17 and 22 are for pages with headings, such as a landing page.
- **Instrument labels are lowercase; values keep their case.** `1.05M` must
  not become `1.05m`. A value sits in `<b>` and takes `--st-strong`.
- **Counts say what they are.** "simulated" or "rendered" goes next to a
  particle count, in `fine` (see "Honest counting" in `CLAUDE.md`).
- **Centering tracked capitals:** tracking adds a gap after the last letter.
  Add `text-indent` equal to the tracking so the line is optically centered.
- **Tracking of 0.5em marks a title at any size**, for example the first line
  of an announcement.

## Ink

| level | alpha | contrast on black | use it for |
| --- | --- | --- | --- |
| `--st-strong` | 0.9 | 16.7:1 | values, titles, anything active |
| `--st-dim` | 0.65 | 8.6:1 | labels, sentences |
| `--st-faint` | 0.48 | 4.9:1 | captions, hints, small print (the floor for text) |
| `--st-stroke` | 0.36 | 3.1:1 | outlines of controls (the floor for a control) |
| `--st-hair` | 0.16 | 1.4:1 | separators, decoration only |

- `--st-lit` is the ink at full strength: the thing under the pointer, the
  selected thing.
- **Text over the void** (no panel behind it) takes `text-shadow:
  var(--st-halo)`, so it survives dense, bright particles in any theme.
- **A panel** is `background: var(--st-surface)` with a `--st-hair` border and
  `backdrop-filter: blur(var(--st-blur))`. At 0.88 black, faint text stays
  above 4.5:1 even with white-hot particles behind the panel.
- **A full-screen sheet** (the keys sheet) dims the world with `--st-scrim`
  (0.8 black). More of the world shows through than through a panel, so text
  on a sheet is `--st-dim` or stronger.
- `npm test` checks these contrast numbers, so a token edit that breaks them fails.

## Space and shape

- **Unit:** 4 px. Steps: `--st-space-1`, `2`, `3`, `4`, `6`, `8`, `12` (the
  number times 4 px).
- **Edge:** chrome keeps `--st-edge` (20 px, 16 px on a phone) from the
  viewport. Position with `--st-edge-top`, `-right`, `-bottom`, `-left`, which
  add the safe area of a notched screen.
- **Targets:** anything clickable is at least `--st-hit` in both directions
  (24 px with a mouse, 44 px on touch screens).
- **Shape:** one pixel lines, `--st-radius` (0) corners, circles only for
  points. Icons are drawn (SVG strokes or CSS shapes), not typed: a glyph such
  as an arrow or a menu trigram renders differently on every system.
- **Focus:** `outline: var(--st-focus); outline-offset: 2px` on
  `:focus-visible`.

## Motion

| token | value | use it for |
| --- | --- | --- |
| `--st-fast` | 180 ms | answering an input: hover, press, open, close, show after a key |
| `--st-medium` | 480 ms | text that answers an input: the name of a roll |
| `--st-slow` | 1200 ms | arriving unasked (a hint, the title) and every way of leaving |
| `--st-ease` | `cubic-bezier(0.2, 0, 0, 1)` | anything that answers input |
| `--st-ease-soft` | `cubic-bezier(0.4, 0, 0.6, 1)` | slow fades and breathing |

- Animate `opacity` and `transform` only.
- Nothing loops, except the die's first-visit breathing. The die is also the
  one thing that bounces.
- Multiply any distance by `--st-travel`: it is 1 normally and 0 when the
  person asked for reduced motion, where the slower timings also drop to
  `--st-fast`. Chrome then fades quickly and never moves.

## Themes

The color themes (`src/ux/theme`) remap the canvas only. The chrome reacts in
one way: `setAccent(accentOf(theme.stops))` sets `--st-accent` to the theme's
signature color (the last stop before its white-hot end), and `--st-mark`
draws with it. With the white theme the accent is the ink.

Marks take the accent: a slider's fill and thumb, a switch that is on, the
underline of the selected tab, a progress bar, a graph's line. Text, outlines,
the die and the focus ring never do. `npm test` checks that every theme's accent keeps 3:1 on
black.

## System settings

Handled once, in the tokens, so every piece of chrome follows:

| setting | what changes |
| --- | --- |
| reduced motion | no travel, slow timings become fast |
| more contrast | every ink level rises, panels become solid black, no blur |
| reduced transparency | panels become solid black, no blur |
| touch screen | targets grow to 44 px |
| narrow screen | the edge shrinks to 16 px |

## Stage: where chrome lives

One thing per region at a time. The middle of the screen belongs to the
particles.

| region | lives there |
| --- | --- |
| top left | optional fps readout. On a touch screen or a narrow window, the sheet label (under the readout) |
| top center | Challenge mode only: the count, what it is, and its buttons |
| top right | menu dot; the Esc menu opens under it |
| center | title card, a message (loading, unsupported), the keys sheet, the about card (I) |
| bottom left | stats (H): count, time, fps. Challenge mode's readout |
| bottom center | the die; a status line takes its place while a job runs; captions (hints) sit above it; an announcement above those |
| bottom right | the sheet label: what the sheet the camera faces is doing (`src/ux/info`). On a touch screen the menu button takes this corner |

New chrome picks a region from this table. If two things want the same
region, one of them replaces the other (as the status line replaces the die);
they do not stack.

## Checklist for new chrome

- Fonts, sizes, alphas, spacing and timings all come from tokens. No literals.
- Every piece of text is one role.
- Text is `--st-faint` or stronger. Over the void it has the halo.
- It sits in a region from the stage table and keeps the edge.
- Targets are `--st-hit` or larger and show `--st-focus`.
- It fades in and out with the motion tokens and does not move the layout.

## Where it is applied

| surface | file | uses the tokens |
| --- | --- | --- |
| specimen | `src/ux/design/demo/` | yes |
| HUD, Esc menu, keys sheet | `src/ux/hud/*.js` | yes, through `--hud-*` properties that follow the tokens |
| sheet label, about card, keys sheet groups | `src/ux/info/styles.ts` | yes |
| hints, no-WebGPU page | `src/ux/experience/hints.ts`, `fallback.ts` | not yet |
| title card | `index.html` | not yet |
| Challenge count and buttons | `src/challenge/viewer.ts` | yes |
| Challenge readout | `src/challenge/main.ts` | not yet |
| capture status line | `src/capture/app.ts` | not yet |

## Older names

`TOKENS` in `src/core/contracts.ts` is the first, smaller set (one font, two
opacities) and still styles the demo pages. Its values agree with the tokens
here, except `opacityDim` (0.45), which sits just under `--st-faint`.

The HUD keeps its own `--hud-*` names, and each one follows a token (declared
at the top of `src/ux/hud/styles.js`):

| HUD property | token |
| --- | --- |
| `--hud-fg`, `--hud-bg`, `--hud-mark` | `--st-ink`, `--st-shade`, `--st-accent` |
| `--hud-a-strong`, `--hud-a-dim` | `--st-a-strong`, `--st-a-dim` |
| `--hud-a-ghost` | `--st-a-faint` (small print, idle icons) |
| `--hud-a-stroke`, `--hud-a-line` | `--st-a-stroke` (control outlines), `--st-a-hair` (separators) |
| `--hud-a-panel`, `--hud-scrim`, `--hud-blur`, `--hud-halo` | `--st-a-surface`, `--st-scrim`, `--st-blur`, `--st-halo` |
| `--hud-unit`, `--hud-edge` | `--st-u`, `--st-edge` |
| `--hud-fade-in`, `--hud-fade-text`, `--hud-fade-out` | `--st-fast`, `--st-medium`, `--st-slow` |
| `--hud-ease`, `--hud-ease-soft` | `--st-ease`, `--st-ease-soft` |
| `--hud-font`, `--hud-font-fine`, `--hud-font-figure` | `--st-font-data`, `--st-font-fine`, `--st-font-figure` |
| `--hud-font-voice`, `--hud-font-body` | `--st-font-caption`, `--st-font-body` |
| `--hud-tracking`, `--hud-tracking-wide`, `--hud-tracking-title` | `--st-track`, `--st-track-wide`, `--st-track-title` |

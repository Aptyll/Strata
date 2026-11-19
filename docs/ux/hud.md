# HUD and controls

The on-screen interface for Strata. Code lives in `src/ux/hud/`. It is a
dependency-free ES module (plain JS plus `index.d.ts`), so it works with or
without the bundler.

## Principles

1. **The page opens on the simulation and nothing else.** No stats, no panel,
   no title. The only chrome is a small die at the bottom centre and a single
   dot in the top right corner, and both fade out after 2.5 seconds without
   input. The mouse cursor hides with them.
2. **Everything else is one key away.** `H` shows the stats line. `Esc` opens
   the settings menu. `?` lists every key.
3. **One playful control.** The die rerolls the whole system. It is the only
   thing a first-time visitor needs to find, so it is the only thing shown.
4. **White on black, from the design tokens.** Fonts, sizes, text strengths,
   spacing and timings follow `src/ux/design` (rules in `docs/ux/design.md`):
   monospace for what the machine reports, wide capitals for what is said to
   the person. Lines are one pixel. Nothing is filled except a switch that is
   on. There are no rounded panels or shadows. The only colour is the accent
   of the colour theme, on marks that show a value or a selection (a slider's
   fill, the selected tab's underline, the fps graph, a progress bar).
5. **Never cost a frame.** Stats text is written at most five times a second,
   and not at all while the stats line is hidden. The overlay ignores pointer
   events everywhere except on its own controls, so camera drags pass through.

## What is on screen

```
+--------------------------------------------------------------+
|                                                            . |  menu dot (Esc)
|                                              +-------------+ |
|                                              | particles   | |
|                                              | ----|------ | |  settings menu,
|                                              | speed       | |  closed by default
|                                              | --|-------- | |
|                                              +-------------+ |
|                                                              |
|                        P L A N E  0 2                        |  announce: fades in
|                            BOIDS                             |  and out on change
|                                                              |
| 4.19M  0:42  60 fps          [::]              boids plane 02|  stats (H) and die (R)
+--------------------------------------------------------------+
```

| Element | Where | Default | Shown by |
| --- | --- | --- | --- |
| Die | bottom centre | visible, fades when idle | any input |
| Menu dot | top right | visible, fades when idle | any input |
| Stats: particles, time, fps | bottom left | hidden | `H` |
| Stats: plane, behavior | bottom right | hidden | `H` |
| Settings menu | below the dot | closed | `Esc` or the dot |
| Announce | above the die | hidden | plane change, or a named roll |
| Keys sheet | centre | hidden | `?` |

Stats stay on once asked for, idle or not, since asking for them is a
deliberate act. The choice is remembered across visits. On touch screens the
same switch is the `stats` button in the menu footer.

## The die

A 28 px outlined square with pips. Hover tilts it a few degrees. Pressing it
(or `R`) tosses it: it lifts, spins a turn and a quarter, and lands with one
small bounce, while the pips flick through faces every 70 ms and settle on the
final one. The whole toss takes 620 ms. With `prefers-reduced-motion` the spin
is skipped and only the pips change.

The handlers fire at the moment of the press, not when the die lands, so the
simulation is already changing while the die is in the air. Pressing again
mid-toss restarts the animation and fires again.

On a first visit, if the die has not been touched after six seconds, it stays
visible through the idle fade and breathes slowly between dim and bright. The
first roll ends the hint for good.

Each roll carries a random unsigned 32-bit `seed`. The face shown is
`seed % 6 + 1`, so the die is honest about the seed even though six faces
cannot identify it. Rolling also restarts the timer.

```js
hud.onRandomize(({ seed, face }) => {
  const preset = makePreset(seed);       // owned by the behavior thread
  app.loadScene(preset.scene);
  return { name: preset.name, detail: preset.behaviorLabel }; // optional: announced on screen
});
hud.randomize();      // roll from code
hud.randomize(1234);  // replay a roll
```

A handler may return a string, `{ name, detail }`, a promise of either, or
nothing.

## Keys

| Key | Action |
| --- | --- |
| `R` | randomize (roll the die) |
| `H` | show or hide stats |
| `Esc` | open or close settings (closes the keys sheet first; cancels a running job when the menu is closed) |
| `F` | fullscreen |
| `?` | keys sheet |

The engine adds its own with `registerShortcut`, and they appear in the keys
sheet automatically. Suggested: `space` pause, `[` and `]` previous and next
plane. Shortcuts are ignored while a modifier is held, while typing in a text
field, and on a focused dropdown. Space and Enter on a focused HUD control
activate that control instead of a shortcut.

## Settings menu

A 30em column (330 px at the default type size), 78% black with a background
blur and a hairline border, so the simulation stays visible while tuning. It
sits on the right rather than centred for the same reason. While it is open
nothing fades.

Layout (structure in `menu.js`, styles in `menu-styles.js`):

1. **Summary header** (`#strata-menu-summary`): live fps in large type, frame
   time in ms (derived from the measured fps), and a 30 second fps graph with
   the target fps as a dashed line. Below it: particles simulated last frame,
   particles stored (when the governor draws fewer), sheets, drawing buffer
   size and theme, in the words the rest of the app uses. Facts with no value
   are hidden. Other modules add facts, or take one of these over, with
   `hud.setFact`.
2. **Page tabs** (first navbar): scene, behaviors, look, color, perf,
   capture. A page with no controls hides its tab. So does "more", the page
   for controls no other page claims: it only shows when something is
   unplaced. Six tabs fill the line at the default width; a seventh wraps.
3. **Sections.** A page shows its groups as sections, in the order of the
   page's `groups`.
   - On a **stacked** page (`stack: true`; in the app, every page but
     behaviors) the sections sit one under the other, each under a small
     title, so a setting and the button that uses it are on screen together.
     A page's first section goes without a title when it is named like the
     page ("look" on look).
     A section named in the page's `fold` starts folded behind its title
     (`+ advanced`). The title is a button; whether it was opened is
     remembered. In the app every stacked page ends with a folded "advanced"
     section for controls most people never need.
   - Otherwise a page with two or more groups gets **section tabs** (second
     navbar) and shows one group at a time. That suits sections that are
     alternatives, such as one set of sliders per behavior.
4. Footer: reset all (every page, not only the open one), stats, keys.

The last page and section, and which folded sections are open, are remembered
(`strata.hud.page`). Left/Right/Home/End move between tabs.

### Where a control appears, and what it is called

The app keeps the menu's table of contents in one file, `src/app/menu.ts`:
every page, its sections in order, and one row per control. Read `MENU` top to
bottom and you have read the menu.

```ts
{
  id: "perf", label: "perf",
  sections: [
    {
      group: "performance", label: "frame rate",
      rows: [
        { id: "adaptive", hint: "Uses fewer particles when the frame rate falls below the target." },
        { id: "targetFps", needs: "adaptive", hint: "The frame rate to hold." },
      ],
    },
    { group: "advanced", fold: true, rows: [{ id: "rasterizer", label: "draw with", hint: "..." }] },
  ],
}
```

Controls still register wherever they are built (`hud.registerParam` in the
module that owns the setting). The table has the last word on four things, by
control id:

- **where**: the page, the section and the position in the section (`order`,
  the row's index in the table),
- **the name** shown (`label`), so a control can be renamed for the menu
  without touching the module that owns it,
- **`hint`**: one line in plain words, shown as the row's tooltip and read by
  screen readers as its description,
- **`needs`**: the id of a switch the control depends on. While that switch is
  off the row is dimmed and inert, and its tooltip says which switch to turn
  on ("target fps" needs "hold frame rate").

`menuLayout()` turns the table into the HUD's `layout` option:
`createHud({ layout: { pages, params } })`. `layout.pages` replaces the
default `PAGES` table of `menu.js`; `layout.params[id]` overrides `page`,
`group`, `label`, `order`, `needs` and `hint` of the control with that id. The
same six fields can also be given to `registerParam` directly.

A control with no row in the table still shows up. It lands on a page by its
`page` field, else by its `group` through the page table (for example
`performance` goes to perf, `capture` to capture, `theme` to color), else on
"more", and it follows the listed rows of its section. `group: "advanced"`
with a `page` puts it in that page's folded section. Without a `layout` (the
demos) every control is placed this way.

Ids are the stable handle. Other code talks to a control by id
(`hud.setParam`, `hud.getParam`, `data-param` on the row), never by label, so
renaming or moving a row in the table breaks nothing.

FPS is shown in three places: the summary header (with the graph), the H
stats line, and an optional readout in the top-left corner ("fps in corner"
on the perf page, off by default and remembered).

Controls, all built by `registerParam`:

- **range**: a hairline track with a 3 px tick. Linear or log scale. Arrow keys
  move one step, Shift moves ten. `live: false` holds `onChange` until release,
  for expensive changes such as reallocating particle buffers.
- **toggle**: a 9 px square, filled when on.
- **select**: the current value as text, native dropdown on click.
- **action**: a text button with an arrow.

A dot after a label marks a value that differs from its default. Double-click
a label to reset that one. `reset all` in the footer resets all of them. Values
persist in `localStorage` (`strata.hud` by default) and are restored when the
param is registered again, at which point `onChange` fires once so the engine
picks the value up.

## Long jobs: offline renders and exports

Anything that takes over the frame loop for a while launches from the menu
with `registerJob`. The HUD owns the chrome so every job looks the same:

```ts
hud.registerJob({
  id: 'offline.render', group: 'capture', label: 'render offline video',
  async run({ signal, progress }) {
    for (let f = 0; f < frames; f++) {
      if (signal.aborted) throw new DOMException('cancelled', 'AbortError');
      await renderFrame(f);
      progress((f + 1) / frames, `frame ${f + 1} of ${frames}`);
    }
    return 'saved strata.mp4';      // optional closing line
  },
});
```

- The action sits in its `group` in the Esc menu. Use `group: 'capture'` to
  land on the capture page, under its shared resolution, frame rate and length
  settings. In the app, give it a row in `src/app/menu.ts` to place and name
  it exactly: the running label ("cancel ...") follows the name given there.
- While a job runs, the die gives way to one line of text over a 240 px
  hairline progress bar, and the die and `R` are off, since the world belongs
  to the job.
- The action reads `cancel ...` while running. Pressing it, or `Esc` with the
  menu closed, aborts `signal`.
- One job at a time. `hud.busy` and the `job` event (`id`, `running`) tell
  other code to stand down, for example to stop the realtime loop.
- `hud.status(text, holdMs?)` shows the same line without a job, for one-off
  notices such as "saved screenshot".

## Wiring it to the engine

The short way is `mountHud` in `src/ux/hud/wire.ts`. It talks to the engine
only through `AppContext`, so it plugs into any engine that implements the
contract. It:

- puts the design tokens on the page (`installTokens`) and creates the HUD,
  which follows them
- hooks the die to `rollScene` and `startRoll` from `src/ux/behavior-ui/roll.ts`
- feeds `app.stats()` to the stats line
- adds a **particles** slider (log scale, applied on release) that rebuilds the
  world with every plane scaled, through `getScene` and `loadScene`
- adds a **brightness** slider when the engine implements the optional
  `AppContext.setRender`
- adds one section of sliders per behavior in the world, built from each
  behavior's `ParamSpec`s, for the three most used behaviors. A slider sets the
  param on every plane running that behavior. The sections are rebuilt when a
  roll changes the cast, and the sliders follow the values while a roll glides.
  Touching a slider cancels a roll in flight.

- keeps the current roll in the page link (`#r=<seed>`), replays it when the
  page is opened from such a link, and adds a **copy link** action to the menu.
  Every roll starts from the behaviors the world opened with, not from the
  previous roll, so a seed alone identifies a world. Turn off with
  `shareLink: false`. In the app, changing the planes setting writes
  `?planes=` into the link and drops `#r=`, because the rebuilt layout has no
  roll in it.

- leaves out the particle count slider with `particles: false`, for a streamed
  world whose scene lists no planes to scale (the app does this with `?world`).

In `src/main.ts` that is two lines, plus removing the old text overlay:

```ts
import { mountHud } from './ux/hud/wire';

const ui = mountHud(app);          // app: AppContext
// in the frame loop
ui.update(dt);
// more controls and keys go on ui.hud
ui.hud.registerShortcut({ key: 'space', label: 'pause', run: () => togglePause() });
```

The long way, for anything `mountHud` does not cover:

```ts
import { createHud } from './ux/hud/index.js';
import { installTokens } from './ux/design';

installTokens(); // the HUD follows the design tokens; without them it uses the same values as fallbacks
const hud = createHud();

// stats: call as often as you like, writes are throttled
setInterval(() => hud.setStats(app.stats()), 250);   // { fps, particles, planes }
hud.setStats({ plane: 'plane 02', behavior: 'boids' });

// one slider per behavior param, straight from the Behavior contract
for (const [name, spec] of Object.entries(behavior.params)) {
  hud.registerParam({
    id: `${behavior.id}.${name}`, group: behavior.label ?? behavior.id,
    label: spec.label ?? name, min: spec.min, max: spec.max, step: spec.step, value: spec.default,
    onChange: (v) => { plane.desc.params = { ...plane.desc.params, [name]: v }; app.updatePlane(plane); },
  });
}

hud.registerParam({ id: 'brightness', label: 'brightness', group: 'render',
                    min: 0, max: 2, step: 0.01, value: 1, onChange: (v) => setBrightness(v) });
hud.registerShortcut({ key: 'space', label: 'pause', run: () => togglePause() });
```

### API

| Call | Purpose |
| --- | --- |
| `createHud(options?)` | Build and attach. Options: `parent`, `tokens`, `stats`, `dice`, `onRandomize`, `idleMs`, `hideCursor`, `autoFps`, `announce`, `persist`, `shortcuts`, `panelOpen`, `keyTarget`, `layout` (the menu's table of contents, see "Where a control appears"). |
| `setStat(key, value)`, `setStats(obj)` | Built-in keys: `particles`, `planes`, `time`, `fps`, `plane`, `behavior`. Unknown keys are added bottom left. `null` hides one. |
| `defineStat(key, { label, slot, format })` | Add or restyle a stat. |
| `resetTimer()` | Restart the elapsed timer. |
| `announce(title, sub?, holdMs?)` | Fade a title in and out above the die. |
| `message(text \| null)` | Centred message for loading or an unsupported browser. Stays until cleared. |
| `registerParam(spec)`, `registerParams(specs)` | Add controls. Returns handles with `get`, `set`, `reset`, `remove`. Placement fields: `page`, `group`, `order`, `needs`, `hint` (the app sets them from its menu table instead). |
| `getParam(id)`, `setParam(id, v, { silent })`, `getParams()`, `resetParams()`, `removeParam(id)` | Read and write values from the engine side. A silent set is ignored while the person is dragging that slider, so an engine echo never yanks it. |
| `registerView({ id, group, page, order, node })`, `removeView(id)` | Put a block of your own DOM in a menu section, where a param with the same group, page and order would sit: a read-out that is not a control (a table of timings, a chart). A row for its id in the menu's table of contents places it, as it does a control. The HUD only places it; content, styles and updates are yours. |
| `setFact(key, text, { label, title, after })` | Write a fact in the summary header. A new key adds one (after the fact named by `after`); one of the menu's own keys (`particles`, `total`, `planes`, `resolution`, `theme`) takes that fact over until it is given back. `null` hides it, `undefined` gives it back. |
| `onRandomize(fn)`, `randomize(seed?)` | The die. |
| `hintDice(on?)`, `rolled` | Start or stop the die's breathing hint by hand, for an app that schedules its own hints (create the HUD with `diceHintMs: 0`); `rolled` is true once the die has been rolled on this device. |
| `registerJob({ id, label, group, run })`, `status(text, holdMs?)`, `busy` | Long jobs and the status line. See above. |
| `registerShortcut({ key, label, run })` | Add a key. Returns a remover. |
| `on('change' \| 'panel' \| 'stats' \| 'randomize', fn)` | Events. Returns an unsubscribe function. |
| `openPanel()`, `closePanel()`, `togglePanel()`, `showStats()`, `hideStats()`, `toggleStats()`, `toggleHelp()`, `wake()` | Programmatic control. |
| `panelOpen`, `statsVisible`, `idle`, `el` | State and the root element. |
| `destroy()` | Remove the DOM and every listener. |

Notes:

- `fps` and `time` run themselves until the engine sets them. The built-in fps
  counts `requestAnimationFrame` callbacks, which matches the render rate only
  if the engine draws every frame, so prefer `setStat('fps', app.stats().fps)`.
- Changing the `plane` stat announces the new plane, with the `behavior` stat
  as the subtitle. Turn this off with `announce: false`.
- The look comes from the design tokens: every `--hud-*` property in
  `styles.js` follows a `--st-*` token, so change the token to change all
  chrome at once. To change one HUD only, set a property on `hud.el`:
  `--hud-fg`, `--hud-bg`, `--hud-mark` (RGB triplets), the levels
  `--hud-a-strong`, `--hud-a-dim`, `--hud-a-ghost`, `--hud-a-stroke`,
  `--hud-a-line`, the fonts `--hud-font` and `--hud-font-fine`, `--hud-ease`,
  `--hud-fade-in`, `--hud-fade-out`, `--hud-unit`, `--hud-edge`,
  `--hud-panel-w`. New rules take alphas from the levels, never a literal
  (`npm test -- hud` checks this and that each fallback equals its token).

## Demos

Both run today without WebGPU. Start `npm run dev`, then open:

- `/src/ux/hud/demo/`: the HUD exactly as the app mounts it (`mountHud`), over
  a small CPU stand-in that implements the parts of `AppContext` the HUD uses.
  The die really rolls behaviors and the menu really drives them.
- `/src/ux/hud/demo.html`: the bare HUD module with hand-registered params.

## Open questions

- Whether the menu should pause the simulation, as a game's Esc menu would. It
  does not today, because the point of the menu is to tune a running system.

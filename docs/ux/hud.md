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
4. **White on black, one font, two opacities.** The stylesheet defaults mirror
   `TOKENS` in `src/core/contracts.ts`, and `createHud({ tokens: TOKENS })`
   binds them directly. Lines are one pixel. Nothing is filled except the
   active state of a switch. There are no rounded panels, shadows or colours.
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
deliberate act. They are remembered only for the session.

## The die

A 28 px outlined square with pips. Hover tilts it a few degrees. Pressing it
(or `R`) tosses it: it lifts, spins a turn and a quarter, and lands with one
small bounce, while the pips flick through faces every 70 ms and settle on the
final one. The whole toss takes 620 ms. With `prefers-reduced-motion` the spin
is skipped and only the pips change.

The handlers fire at the moment of the press, not when the die lands, so the
simulation is already changing while the die is in the air. Pressing again
mid-toss restarts the animation and fires again.

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
| `Esc` | open or close settings (closes the keys sheet first) |
| `F` | fullscreen |
| `?` | keys sheet |

The engine adds its own with `registerShortcut`, and they appear in the keys
sheet automatically. Suggested: `space` pause, `[` and `]` previous and next
plane. Shortcuts are ignored while a modifier is held, while typing in a text
field, and on a focused dropdown. Space and Enter on a focused HUD control
activate that control instead of a shortcut.

## Settings menu

A 264 px column, 78% black with a background blur and a hairline border, so
the simulation stays visible while tuning. It sits on the right rather than
centred for the same reason. While it is open nothing fades.

Controls, all built by `registerParam`:

- **range**: a hairline track with a 3 px tick. Linear or log scale. Arrow keys
  move one step, Shift moves ten. `live: false` holds `onChange` until release,
  for expensive changes such as reallocating particle buffers.
- **toggle**: a 9 px square, filled when on.
- **select**: the current value as text, native dropdown on click.
- **action**: a text button with an arrow.

A dot after a label marks a value that differs from its default. Double-click
a label to reset that one. `reset` in the footer resets all of them. Values
persist in `localStorage` (`strata.hud` by default) and are restored when the
param is registered again, at which point `onChange` fires once so the engine
picks the value up.

## Wiring it to the engine

The short way is `mountHud` in `src/ux/hud/wire.ts`. It creates the HUD with
the shared `TOKENS`, hooks the die to `rollScene` and `startRoll` from
`src/ux/behavior-ui/roll.ts`, and feeds `app.stats()` to the stats line:

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
import { TOKENS } from './core/contracts';

const hud = createHud({ tokens: TOKENS });

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
| `createHud(options?)` | Build and attach. Options: `parent`, `tokens`, `stats`, `dice`, `onRandomize`, `idleMs`, `hideCursor`, `autoFps`, `announce`, `persist`, `shortcuts`, `panelOpen`, `keyTarget`. |
| `setStat(key, value)`, `setStats(obj)` | Built-in keys: `particles`, `planes`, `time`, `fps`, `plane`, `behavior`. Unknown keys are added bottom left. `null` hides one. |
| `defineStat(key, { label, slot, format })` | Add or restyle a stat. |
| `resetTimer()` | Restart the elapsed timer. |
| `announce(title, sub?, holdMs?)` | Fade a title in and out above the die. |
| `registerParam(spec)`, `registerParams(specs)` | Add controls. Returns handles with `get`, `set`, `reset`, `remove`. |
| `getParam(id)`, `setParam(id, v, { silent })`, `getParams()`, `resetParams()`, `removeParam(id)` | Read and write values from the engine side. |
| `onRandomize(fn)`, `randomize(seed?)` | The die. |
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
- Retheme by setting custom properties on `hud.el`: `--hud-fg`, `--hud-bg`
  (RGB triplets), `--hud-a-strong`, `--hud-a-dim`, `--hud-font`,
  `--hud-tracking`, `--hud-ease`, `--hud-fade-in`, `--hud-fade-out`,
  `--hud-unit`, `--hud-edge`, `--hud-panel-w`.

## Demo

`src/ux/hud/demo.html` runs the HUD over a cheap 2D point field that stands in
for the engine. Run `npm run dev` and open `/src/ux/hud/demo.html`.

## Open questions

- Touch: the die and the dot work by tap, but stats have no touch gesture yet.
  A switch inside the menu is the likely answer.
- Whether the menu should pause the simulation, as a game's Esc menu would. It
  does not today, because the point of the menu is to tune a running system.
- The announce text uses wide letter spacing, which is outside `TOKENS`. It is
  the one deliberate exception, as a title card rather than a label.

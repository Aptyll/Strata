# Information: what the screen tells a viewer

Strata opens on particles and nothing else. That is the right first second,
but it leaves every question unanswered: what is a sheet, how many particles
is that, are they really being simulated, what is the trillion, how do I move.
This page is the plan for answering them without adding chrome: the words the
app uses, how it writes counts, and where each answer lives.

Code: `src/ux/info/` (mounted by one line in `src/app/hud.ts`). Demo without
WebGPU: `/src/ux/info/demo/`. How it looks is the design system's business
(`docs/ux/design.md`); this page is about what it says.

## The questions, and where the answers live

Nothing below is on screen until the viewer asks for it. Each answer is one
key or one gesture away, and each lives in exactly one place.

| the viewer wonders | the answer | how they get it |
| --- | --- | --- |
| what is this sheet doing? | sheet label, bottom right: the behavior's name, one sentence, `sheet 7 of 32 · 62.5K particles simulated` | face a sheet: double-click it, `,` `.` or `G` |
| how many particles is that? | stats line: `1.21M simulated  2.00M stored  32 sheets  0:42  60 fps` | `H` |
| and that sheet over there? | with the stats line on, the label names the sheet under the pointer | `H`, then point |
| how do I move? what can I press? | keys sheet: pointer gestures, camera keys, shortcuts | `?` |
| what am I looking at? is it really a trillion? | about card: sheets and behaviors, the live counts, simulated versus rendered, the behaviors in this world | `I`, or "about" in the menu footer |

The label stays up long enough to be read (about 17 characters a second, 4 to
10 seconds) even if the viewer lets go of the mouse, then fades with the die.
Moving the mouse brings it back while the camera still faces the sheet.

## The words

One word per thing, everywhere a viewer can read it. The definitions are data
(`TERMS` in `src/ux/info/words.ts`); the about card prints them word for word.

| word | means | never call it |
| --- | --- | --- |
| **particle** | One dot of light. Where particles overlap their light adds up, so brighter means denser. | point, dot (as a count) |
| **sheet** | A flat square floating in the void that runs its own 2D particle system. | plane (that is the code's word: `PlaneInstance`, `?planes=`) |
| **behavior** | The one rule a sheet's particles follow. Each has a name no other behavior shares and one sentence saying what a viewer sees (`label` and `description` in `src/core/contracts.ts`). | rule set, mode, preset |
| **simulated** | Every particle has a position and a velocity stored on the graphics card, and each one is moved forward every frame. | active, live, total; and never for the trillion |
| **stored** | Particles held in GPU memory. A sheet that is out of view rests, and a sheet can be thinned to hold the frame rate, so fewer may be simulated than stored. | total, capacity, budget |
| **rendered** | Nothing is stored. For each frame, every particle's position is computed from its number and the time. The ones that land in view add light to the picture, and nothing is kept for the next frame. | simulated |

"Simulated" and "rendered" are the two modes in `CLAUDE.md`, and the rule
there is the rule here: the live world is simulated, the trillion is rendered,
and no count appears without one of the two words (or "stored") beside it.

## Counts

- **A count always says what was done to those particles.** `1.21M simulated`,
  `62.5K particles stored, resting`, `1,000,000,000,000 particles ... rendered`.
  A bare number is the gap this layer exists to close.
- **Simulated means stepped this frame.** It is the sum of each sheet's
  `activeCount`, the number of particles the simulation dispatches for it,
  leaving out paused sheets: a paused sheet (asleep in `?world`) is still
  drawn but not stepped, so it counts as stored only. `app.stats().particles`
  follows the same rule. This number is exact by construction, not a GPU
  tally: every dispatched particle is stepped.
- **Stored is the sum of the sheets' buffer capacities**, read from the live
  planes, not from the particles setting.
- **One number when one number says it all.** The stats line shows `stored`
  only while it would read differently from `simulated` (sheets out of view
  rest; "hold frame rate" thins sheets). Two counts that read the same are one
  number shown twice.
- **Short on lines, exact where the number is the point.** `1.21M` on the
  stats line and the label (three significant digits, `K M B T`, capital
  letters: `1.05M` must not become `1.05m`). `1,209,600` with commas in the
  about card, and always `1,000,000,000,000` for the trillion.
- **Measured numbers come from the README.** The about card may quote only
  what is in `MEASURED` (`words.ts`), and `npm test` fails if `README.md` no
  longer has those numbers. A frame time for the trillion is always quoted
  with the case it was measured for: about 160 to 193 seconds when every
  particle in view adds exactly one unit (count weighting); 161 to 205
  seconds when light falls with distance (flux weighting) and the sheets fill
  the picture; 26 to 52 seconds for the first stills, where the sheets
  covered part of the picture and most far particles added no light. A frame
  takes anywhere from 26 to 205 seconds, so a time without its case misleads.
- **Particles per pixel** in the about card is simulated particles divided by
  the pixels of the drawing buffer (`canvas.width × canvas.height`). Pointing
  at it shows the sum.

## Writing text for the screen

For any new label, hint, menu row or message:

1. Use the words in the table above. If a new thing needs a word, add it to
   `TERMS` with one sentence, then use it.
2. Say what the viewer sees or what happens, not how the code does it:
   "pull its particles", not "apply attractor brush".
3. Lowercase for instrument text (stats, menu rows, the keys sheet). Sentence
   case for sentences. Values keep their case.
4. A control is listed where controls are listed: a HUD shortcut registers
   itself and appears behind `?`; a camera gesture or key gets a row in
   `src/ux/info/controls.ts`. A key nobody can look up does not exist.
5. No claim without a source. A number on screen is read from the running
   world or is a measured number in `MEASURED`.

## What changed in the app (2026-11-19)

- Stats line: `2.00M` became `2.00M simulated`; `total` and `active` became
  `stored` and `simulated`; `planes` became `sheets`. The stat that named the
  world's most common behavior is hidden: it said nothing about the sheet in
  view, and the sheet label does.
- Esc menu: the `planes` slider is labelled `sheets`, `plane crossings` is
  `sheet crossings`, and the row hints say "sheet". `G` reads "go to nearest
  sheet". A test fails when a menu row, a key label or a control row says
  "plane".
- Keys sheet: gained the pointer gestures and the camera keys, in named
  groups. Before, it listed only HUD shortcuts, so turning, panning, diving,
  facing a sheet and pushing particles could not be looked up anywhere.
- New: the sheet label, the about card (`I`).
- Two behaviors shared the name "Gravity wells"; every behavior now has its
  own name and a one-sentence description (PR #112).

## Open

- **`?world` (streamed sheets):** the label works there, but a sheet's number
  ("sheet 7 of 180") is its place among the sheets loaded right now, so it
  changes as sheets stream in and out. A streamed sheet has no lasting number
  yet.
- **Auto camera tour (`C`):** the tour steers the camera without telling the
  rig which sheet it frames, so the label stays hidden during a tour. A tour
  with captions would be a good use of the label.
- **Esc menu header** (`src/ux/hud/menu.js`) still says "simulating" and
  "planes", shows counts in lowercase (`20.0k`) and names the world's most
  common behavior as if it were the one on screen. It reads the same stats,
  so only its own labels and one `text-transform` need to follow. Passed to
  the Esc menu threads on 2026-11-19.
- **Challenge mode** (`/?challenge`) has its own readout and does not mount
  this layer.

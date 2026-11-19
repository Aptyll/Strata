# Coming back: reasons to return

`src/ux/returning/`. What a visitor gets on the second and later visits. A
first visit is left exactly as it is: the opening, the gesture hints and the
die are the first-run experience's job (`docs/ux/experience.md`).

Try it without waiting a day and without WebGPU: `/src/ux/returning/demo/`
under `npm run dev`. Its buttons move the clock ("come back tomorrow") and it
keeps its own storage, apart from the app's.

## What people get

| | how | what it does |
| --- | --- | --- |
| **today's world** | open the site, or **N** | The plain address opens on a roll of the dice that is new every calendar day, with "today's world" and the date on screen. N goes there from anywhere. |
| **keep a world** | **K** | Keeps the world on screen exactly as it is: every sheet's rule and sliders, the layout, the view, the brightness, the particle count and the color theme. Kept worlds are listed in the Esc menu (scene, "your worlds") and survive between visits. Up to 24. |
| **previous world** | **Backspace**, Shift+Backspace for next | Steps back and forward through the worlds seen since the page opened, so a roll can be undone. On arrival the world that was left last time is one step back. |
| **what is new** | by itself, or "what's new" in the menu | One line for each thing added since the last visit, once, two a visit, in quiet moments. |

Touch screens have no keys: the same four actions are rows in the Esc menu.

## Why these four

A visitor comes back when there is something new to see, something of their
own to return to, and nothing they liked can be lost by trying things.

- **Something new, on a schedule.** The dice already make new worlds, but only
  when asked. A world that changes with the date gives the plain address a
  reason to be opened again tomorrow, and two people on the same date can
  talk about the same roll.
- **Something of their own.** The dice were one way: roll past a world you
  liked and it was gone unless you had copied the link in time. K makes a
  world theirs, and Backspace makes rolling safe.
- **Knowing what changed.** The site gains features daily. Without a line
  about them, a returning visitor sees the same void and no reason to press
  anything new.

Not built here, on purpose: accounts, streaks, notifications, or anything that
sends data anywhere. Everything is one record in this browser's
`localStorage`.

## What opens on arrival

Decided once per page load by `decideArrival` (`arrival.ts`), in this order:

| the address | the visitor | opens on |
| --- | --- | --- |
| any query other than `?theme=`, or a hash that is not a roll | anyone | exactly what the address says (`?daily=0` is the plain way to ask for the usual opening) |
| anything | first visit | the usual opening, untouched |
| `#r=<seed>`, and the seed is the day's world this browser opened on an earlier day | returning | today's world: that address is this browser's own stale link, not a world someone shared |
| `#r=<seed>`, any other | returning | that roll, as shared. Once a day a line mentions that today's world is new |
| plain | returning | today's world |

Today's world never overrides an address that names something, so links,
capture runs and development URLs stay deterministic.

Noah chose "today's world, new each day" for the plain address (decision
card, 2026-11-19). The other two choices are still in the code as
`RETURN_OPENS_ON` in `index.ts`: `"last"` reopens the world that was left,
`"same"` always shows the opening.

### What "today's world" is, exactly

- The day is the visitor's **local** calendar day (`dayKey`), so it turns over
  at their own midnight and the date on screen matches their calendar. Two
  people in different time zones share a world while their dates agree.
- Its seed is a pure function of the date text (`dailySeed`, FNV-1a plus a
  finalizer). **Never change that function**: it would give everyone a
  different today than the day before the change.
- It is a normal roll of the dice with that seed, replayed through the HUD
  like a shared link. So it is the same roll for everyone on that date, landing
  on however many sheets their device shows. What a seed picks depends on the
  list of registered behaviors, so a deploy that adds a behavior changes
  today's world from then on. That is the dice's existing property
  (`src/ux/behavior-ui/roll.ts`), not something added here.

## Kept worlds and the worlds seen

- A kept world stores the whole `Scene` (`worlds.ts`, `Snapshot`), not a seed.
  A seed stops meaning the same world when the behavior list changes, and it
  cannot hold moved sliders.
- Keeping the same world again refreshes its view instead of adding a copy.
  "The same world" means the same sheets: rules, sliders, seeds and layout
  (`sameWorld`). The view, the particle count and the brightness are not part
  of that comparison.
- A roll changes the sheets one after another for several seconds. A world
  kept during that time is copied again once it has stopped changing, so the
  kept world is the one that landed, not a mix with the world before.
- The worlds seen since the page opened (`history.ts`) are a list like a
  browser's: a new world drops what lay ahead. A plain roll is stored as its
  seed and replayed through the dice (it glides). The opening, a kept world
  and a roll whose sliders were moved are stored as scenes and loaded (a cut).
- Stepping back or forward changes the sheets and nothing else: the camera,
  the brightness and the particle total stay as they are, as with a roll.
  Opening a kept world brings all of those back as they were kept.
- A streamed world (`?world=`) keeps its sheets outside the scene, so it
  cannot be kept and a stored world is never loaded over it. The dice and
  undoing them work there as everywhere.

## What is stored

One JSON record under `strata.returning.v1` (`store.ts`, `VisitorRecord`):
visit and day counts, how many news lines were told, the last day's world
opened, the kept worlds and the world that was on screen when the page was
last hidden. It is read defensively (`parseRecord` keeps what is valid and
drops the rest), and the page works when storage is missing, blocked or full:
it then treats every visit as the first and keeps worlds only until the tab
closes, and says so.

Someone who visited before this module existed has no record. They are
recognised by the older keys (`strata.ux.v1` counting two or more visits, or a
die that was rolled) and start with every news line untold. Those keys can be
written during the very page load that reads them (the opening counts its
visit as it starts, and a link's roll replayed at load marks the die as
rolled), so the test is deliberately strict: a first visit must never be read
as a return.

## Adding a news line

When you ship something a visitor can do, append one line to `NEWS` in
`news.ts`:

```ts
{ text: "sound made by the particles", key: "press M", touch: "in the menu" },
```

**Append only.** A record stores how many lines its visitor was told, so a new
line goes at the end and an old one is never removed or reordered. Write for a
person: what they can do in a few plain words, then the one key that does it.
First-time visitors are told none of them: everything is new to them.

## One line at a time

Every line from this module goes through `hud.announce`, the same line the
dice use for a world's name. Lines wait for a quiet moment: not during the
opening, not while the menu is open or a render job runs, not while a gesture
hint is up, not within a few seconds of a world changing. A line counts as
told only when it actually appears, so a short visit does not use lines up
unseen.

## Wiring

`src/main.ts` mounts it after the HUD and the hints and calls `update(dt)`
once per frame:

```ts
const returning = mountReturning({
  app, hud: ui.hud,
  isOpening: () => intro?.active ?? false,
  keys: { today: KEYS.todaysWorld, keep: KEYS.keepWorld, previous: KEYS.previousWorld },
});
loop.hooks.push({ afterFrame: (f) => void (f.offline || returning.update(f.dt)) });
```

It changes the world only through the HUD's dice (`hud.randomize`) and
`AppContext.loadScene`, so it needs no hook in the engine. The clock, the
storage and the address are options, which is how the demo and the tests move
time.

Its keys are rows in `KEYS` (`src/app/keys.ts`, owner `returning`) and its
menu rows are the "your worlds" section of the scene page in `MENU`
(`src/app/menu.ts`).

## Checks

`npm test -- returning` (`returning.test.js`, about a tenth of a second, no
DOM, no GPU): the day and its seed, every arrival rule, record sanitizing,
world comparison, the history list, the news drip, and whole visits end to end
against a stand-in HUD, engine, storage, clock and address.

Before merging, two things were also run by hand in headless Chromium:

- the demo page: first visit, tomorrow, keep, roll, undo, redo, the menu and
  the news lines;
- the built app on a software GPU (the way `npm run smoke` runs it), at 20k
  particles: N, K, a keep in the middle of a roll, Backspace to a replayed
  roll and to a stored scene, the kept list in the menu, a second load, and a
  phone-sized first and second visit on the plain address. No page error and
  no WebGPU error. That shows every path runs on the real engine. It says
  nothing about speed or about how it looks.

## Not verified, and open

- **On a real GPU, by eye.** Today's world starts as a roll at load, under the
  opening, the same path a shared `#r=` link takes. The sheets change rule one
  after another during the first seconds. Nobody has watched that on a real
  GPU yet.
- **The die's hint.** Replaying a roll at load (a shared link, and now today's
  world) marks the die as rolled, which retires its first-visit breathing
  hint. Follow-up: tell a person's roll from a replay in the HUD.
- **The title card** (`index.html`) shows on every plain visit, returning ones
  included, above the day line. A returning visitor could get the date there
  instead of the controls.
- **Kept worlds and the planes setting.** Opening a kept world with a
  different sheet count leaves the menu's planes slider on its old number.
- Kept worlds are not shareable as one link yet: a link carries a seed, and a
  kept world is a scene. The seed-links work can pick that up.

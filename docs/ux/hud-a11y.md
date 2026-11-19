# Esc menu accessibility

Code: `src/ux/hud/a11y.js` (behaviour) and `src/ux/hud/a11y-styles.js` (CSS).
`createHud` calls `attachMenuA11y(root)` once. The layer adds behaviour and
sizes only; menu structure (tabs, pages, summary header) belongs to
`src/ux/hud/menu.js`.

## Keyboard

| Key | Where | Does |
| --- | --- | --- |
| `Esc` | anywhere | opens the menu; closes the keys sheet or the menu if open |
| `Tab` / `Shift+Tab` | menu open | walks the menu's controls and wraps inside the menu |
| `Left` / `Right`, `Home` / `End` | on a tab | moves between tabs; the page follows (automatic activation) |
| arrows, `Page Up/Down`, `Home/End`, `Space` | on a control | stay with that control (slider, select, button) and do not fly the camera |
| arrows, WASD, `Space` | menu open, no control focused | still fly the camera; `Space` toggles the idle drift |
| `Space`, `Enter` | on the die or the menu dot, reached with `Tab` | press it (roll, open the menu) |
| `?` | anywhere | keys sheet; `Esc`, `Enter`, `Space` or a click close it |

Opening the menu focuses the menu itself, not its first control, so an arrow
press meant for the camera can never nudge a slider. Closing hands focus back
to whatever had it before (the menu dot, if it was reached with `Tab`).

A mouse or touch press never focuses the die or the menu dot, so after
clicking them `Space` still reaches the camera. Key releases are never held
back: the camera acts only on presses, and a release it missed would leave it
flying. Outside the menu, the app's key router (`src/app/keys.ts`) applies the
same rule to any focused control.

## Semantics

- `.sh-panel` is `role="dialog"` named "Settings" (non-modal: the world keeps
  running and stays clickable). `aria-hidden` follows open/closed.
- The menu dot has `aria-haspopup="dialog"`, `aria-controls`, `aria-expanded`
  and `aria-keyshortcuts="Escape"`; the die has `aria-keyshortcuts="R"`.
- The keys sheet is `role="dialog"` named "Keyboard shortcuts".
- Tabs come from `menu.js` with `role="tablist"`, `role="tab"` and
  `role="tabpanel"`. If a tablist's own handler does not take a key (does not
  call `preventDefault`), this layer provides the arrow/Home/End handling.

## Readability

- Type sizes and text strengths come from the design tokens
  (`docs/ux/design.md`), so they are the same in every piece of chrome: stats,
  menu and keys sheet 13px, small print (fact labels, section titles, footer)
  11px. Size menu spacing in `em` so it follows.
- Text strength: values 0.90 (16.7:1 on black), labels 0.65 (8.6:1), small
  print 0.48 (4.9:1, the floor for text). Control outlines 0.36 (3.1:1). The
  colour themes only remap the canvas and keep the void black, so these hold
  for every theme. The menu backing is 0.88 black, which keeps small print
  above 4.5:1 even over white-hot particles; the keys sheet dims the world
  with 0.8 black and uses labels or stronger. `npm test` checks these numbers.
- Text with no panel behind it (stats, announce, status line) gets a dark halo
  so it stays legible over dense, bright particles.
- Targets are at least 24px tall (rows 28px).
- Visible 2px focus ring on every control (`:focus-visible`, so mouse clicks
  do not draw it). Focused dot and die stay visible through the idle fade.

## User preferences

- `prefers-reduced-motion`: no panel slide, no die toss or hint pulse, no
  announce fade.
- `prefers-contrast: more`: full-strength text, solid black menu.
- `prefers-reduced-transparency`: solid menu, no blur.
- `forced-colors`: system colours for the menu, focus ring and switches.

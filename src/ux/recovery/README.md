# src/ux/recovery

What the app does when the GPU fails after the page is up, so a visitor never
sits in front of a frozen or black page with no reason on it.

| situation | what happens |
| --- | --- |
| the GPU device is lost (driver reset, out of memory, sleep) | a card says so and the page restarts by itself after 5 s, once. A loss right after boot or after a particle count change restarts with fewer particles. A second loss within two minutes waits for the person, so it never loops. A running record render is never interrupted by an automatic restart. |
| a particle or plane count the GPU cannot hold | the last world that fit goes back, the camera stays, and the status line says which count failed |
| an out-of-memory error from anywhere else | one status line |
| `startApp` throws after the GPU came up | a card with a reload button (`reportBootFailure`) |

Every card has "copy details": adapter, browser, particle count and the first
GPU error lines, as text for a bug report. Nothing is sent anywhere.

No WebGPU at all is a different case: that is the CPU plane in
`src/ux/experience/fallback.ts`.

| file | what |
| --- | --- |
| `index.ts` | `mountRecovery` (wraps `scenes.loadScene`, listens for device loss and uncaptured errors), `reportBootFailure` |
| `policy.ts` | pure decisions: restart by itself or not, with how many particles; the restart log in sessionStorage |
| `card.ts` | the card: title, a line or two, buttons, optional countdown. Styled from the design tokens (`src/ux/design`) |
| `demo/` | every card on a stand-in device, no WebGPU needed: `/src/ux/recovery/demo/` |
| `test/` | `npm test -- recovery` |

Wired in `src/main.ts`: `mountRecovery` just before `loop.start()`, and
`reportBootFailure` in the catch of `startApp`.

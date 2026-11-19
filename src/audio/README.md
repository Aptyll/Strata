# src/audio

A quiet generative soundtrack driven by what is on screen: the particle count, how dense the frame is, the camera and the dice. It plays live in the app (off on every load, `M` or the "sound" switch in the Esc menu turns it on) and renders offline to WAV in step with fixed-step video frames. See `docs/audio.md`.

- **Key files:** `app.ts` (`mountSound`: the app's switch, key and per-frame hook), `live.ts` (the Web Audio graph that plays it), `composer.ts` and `performance.ts` (turn scene readings into notes), `sense.ts` (reads count, density and camera from the scene), `harmony.ts` (the chords), `offline.ts` and `timeline.ts` (render a score offline), `wav.ts`, `loudness.ts`.
- **`demo/`:** the soundtrack on its own with sliders for a pretend scene, no WebGPU (`/src/audio/demo/`).
- **`test/`:** `audio.test.js`, run by `npm test`.
- **Depends on:** `src/core/contracts.ts` and the HUD's types (`src/ux/hud`). No GPU code.
- **Used by:** the app, through `src/main.ts` (`mountSound` and an `afterFrame` hook); its key is the `sound` row in `src/app/keys.ts`.
- **Status:** live in the app, off by default.

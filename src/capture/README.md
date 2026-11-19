# src/capture

PNG stills and MP4 video straight from the canvas, encoded in the browser (WebCodecs + Mediabunny, no server). See `docs/capture.md`.

- **Entry points:** `index.ts` (public API), `app.ts` (`mountCapture`: P screenshot, V live recording, and a capture section in the settings menu).
- **Key files:** `still.ts` (screenshots, supersampled and tiled posters), `recorder.ts` (MP4), `offline.ts` (fixed-step offline video: a 5 fps scene still comes out as smooth 60 fps), `cameraPath.ts` (scripted, deterministic camera paths), `controller.ts` and `capturePass.ts` (hotkeys and frame-graph `capture` pass), `gpuReadback.ts` (texture to `VideoFrame`), `util.ts`.
- **`demo/`:** standalone test bed (`/src/capture/demo/`), driven headlessly by `npm run verify:capture`.
- **Depends on:** `src/core/contracts.ts`, `src/ux/hud`, `mediabunny`.
- **Used by:** `src/main.ts`, `src/record`.
- **Status:** live in the app.

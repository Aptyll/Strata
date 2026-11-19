/**
 * Auto camera tour for the live app: the camera picks interesting sheets and
 * clusters on its own and glides between them (orbits, slow pull-backs,
 * edge-on reveals, drifting inside a cluster, wide establishing shots).
 *
 * Wiring (main.ts):
 *   const autocam = mountAutoCam({ hud, canvas, camera, planes: () => sim.planes, busy: () => intro?.active });
 *   loop.hooks.push({ beforeCamera: (f) => autocam.step(f.dt) });
 *
 * Turn it on with C, the "auto camera tour" switch in the Esc menu, or
 * `?autocam=1` in the URL. Any camera input (click or drag on the canvas,
 * the wheel, a camera key) hands control straight back, with the camera left
 * exactly where the tour had it. Keys that do not move the camera (Esc, H,
 * F, ?, P screenshot, V record, T theme, R dice, [ ] - =) leave the tour
 * running, so you can record it or change the look while it plays.
 *
 * The director itself is DOM-free (./director.ts, ./shots.ts). Design notes:
 * docs/ux/autocam.md.
 */

import type { PlaneInstance } from "../../core/contracts";
import type { EngineCamera } from "../camera";
import type { Hud } from "../hud/index.js";
import { AutoCamDirector } from "./director";
import type { DirectorOptions } from "./director";
import { sheetsFrom } from "./shots";

export { AutoCamDirector } from "./director";
export type { DirectorOptions, DirectorView } from "./director";
export * from "./shots";

export interface AutoCamOptions {
  hud: Hud;
  canvas: HTMLElement;
  camera: EngineCamera;
  planes: () => readonly PlaneInstance[];
  /** True while something else owns the camera (the opening). The tour waits. */
  busy?: () => boolean | undefined;
  director?: DirectorOptions;
  /** The toggle key, as the HUD names it. Default "c". */
  key?: { key: string; label?: string };
}

export interface AutoCam {
  readonly director: AutoCamDirector;
  readonly active: boolean;
  setActive(on: boolean): void;
  toggle(): void;
  /** Call once per frame before the camera updates. */
  step(dt: number): void;
  dispose(): void;
}

const PARAM = "autocam";

/** Keys that never stop the tour: they open menus, capture, or change the look, not the view. */
const PASSTHROUGH = new Set([
  "KeyC", "Escape", "KeyH", "KeyF", "Slash", "KeyP", "KeyV", "KeyT", "KeyR",
  "BracketLeft", "BracketRight", "Minus", "Equal", "Tab",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

export function mountAutoCam(opts: AutoCamOptions): AutoCam {
  const { hud, canvas, camera } = opts;
  const rig = camera.rig;
  const director = new AutoCamDirector(opts.director);
  let wanted = false;

  const sync = () => hud.setParam(PARAM, wanted, { silent: true });

  const setActive = (on: boolean, why?: "input") => {
    if (on === wanted) return;
    wanted = on;
    if (!on) director.stop();
    sync();
    hud.status(on ? "auto camera: move to take over" : why === "input" ? "you have the camera" : "auto camera off", 2200);
  };

  hud.registerParam({
    id: PARAM, label: "auto camera tour", type: "toggle", group: "camera", value: false,
    // Never start a visit with the camera already taken away.
    persist: false,
    onChange: (on) => setActive(on),
  });
  const offShortcut = hud.registerShortcut({
    key: opts.key?.key ?? "c",
    label: opts.key?.label ?? "auto camera tour",
    run: () => setActive(!wanted),
  });

  // Any camera input hands control back.
  const takeOver = () => {
    if (wanted) setActive(false, "input");
  };
  const onKey = (e: KeyboardEvent) => {
    if (PASSTHROUGH.has(e.code)) return;
    const t = e.target as HTMLElement | null;
    // Typing in a settings field is not camera input.
    if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    takeOver();
  };
  canvas.addEventListener("pointerdown", takeOver);
  canvas.addEventListener("wheel", takeOver, { passive: true });
  window.addEventListener("keydown", onKey);

  if (new URLSearchParams(location.search).get("autocam") === "1") setActive(true);

  return {
    director,
    get active() {
      return wanted;
    },
    setActive: (on) => setActive(on),
    toggle: () => setActive(!wanted),
    step(dt) {
      if (!wanted || opts.busy?.()) return;
      // Start from wherever the camera is now, including idle drift, so taking over never jumps.
      if (!director.active) director.start(rig.getPose());
      const pose = director.step(dt, () => ({
        sheets: sheetsFrom(opts.planes()),
        fovY: rig.options.fovY,
        aspect: canvas.clientWidth / Math.max(1, canvas.clientHeight) || 16 / 9,
      }));
      // Full authority each frame; the rig's own smoothing still rounds off the motion.
      if (pose) rig.steer(pose, 1);
    },
    dispose() {
      offShortcut();
      hud.removeParam(PARAM);
      canvas.removeEventListener("pointerdown", takeOver);
      canvas.removeEventListener("wheel", takeOver);
      window.removeEventListener("keydown", onKey);
      director.stop();
    },
  };
}

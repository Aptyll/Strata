/**
 * Mounts the first-run opening (src/ux/experience/intro-runner.ts) on the
 * app's own camera and frame loop: one plane lights up particle by particle,
 * then the camera pulls back while the rest of the world ignites.
 *
 * The runner is pure; this file is the adapter. It works with every
 * rasterizer because planes are revealed through their particle count, not
 * through a per-plane brightness that only some rasterizers read.
 */
import type { CameraState, PlaneInstance } from "../core/contracts";
import { planeFromDesc } from "../ux/experience/camera-rig";
import { loadMemory, saveMemory } from "../ux/experience/hints";
import { createIntroRunner, type IntroRunner } from "../ux/experience/intro-runner";

export interface IntroCamera {
  state: CameraState;
}

export interface MountedIntro {
  /** True until the opening has finished or was dropped. */
  readonly active: boolean;
  /**
   * Advance the opening and steer the camera while it still owns it. Call
   * before the camera's own update. Returns the brightness multiplier for
   * this frame (1 once the opening is over).
   */
  step(dt: number, planes: readonly PlaneInstance[]): number;
  /** Thin a budget's per-plane counts to what the opening has revealed so far. In place. */
  reveal(counts: number[]): void;
  /** Fast-forward the rest of the opening; the camera eases out of it. */
  skip(): void;
  dispose(): void;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Shortest way round from angle a to angle b. */
const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((((b - a) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return a + d * t;
};
/** Squared, so the first particles arrive one by one and the rest in a flood. */
const gainToCount = (count: number, gain: number) =>
  gain <= 0 ? 0 : gain >= 1 ? count : Math.max(1, Math.round(count * gain * gain));

export interface MountIntroOptions {
  /**
   * Where the camera's own key presses arrive (the key router's cameraTarget).
   * A camera key hands the camera over at once, like a press or a scroll.
   */
  cameraKeys?: EventTarget;
}

export function mountIntro(
  target: HTMLElement,
  camera: IntroCamera,
  planes: readonly PlaneInstance[],
  aspect: () => number,
  options: MountIntroOptions = {},
): MountedIntro {
  const memory = loadMemory();
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  saveMemory({ ...memory, visits: memory.visits + 1 });

  let runner: IntroRunner | null = planes.length
    ? createIntroRunner({
        planes: planes.map((p) => planeFromDesc(p.desc)),
        variant: reduced ? "reduced" : memory.visits > 0 ? "short" : "full",
        fovY: camera.state.fovY,
        aspect,
      })
    : null;
  const planeCount = planes.length;
  let gain: Float32Array | null = null;
  let heroFraction = 1;

  /** Set once the person moves the camera themselves: from then on the opening never steers it. */
  let released = false;
  const skip = () => runner?.skip();
  // A press, a scroll or a camera key means the person is moving the camera right now. Let go
  // at once: easing out over the director's 0.4 s release would overwrite the start of their drag.
  const takeOver = () => {
    released = true;
    skip();
  };
  const onCameraKey = (e: Event) => {
    const k = e as KeyboardEvent;
    // Shift on its own and Ctrl, Alt or Meta shortcuts move nothing, so those only fast-forward.
    if (k.ctrlKey || k.altKey || k.metaKey || k.code.startsWith("Shift")) skip();
    else takeOver();
  };
  const listeners: Array<[EventTarget, string, (e: Event) => void, AddEventListenerOptions?]> = [
    [target, "pointerdown", takeOver],
    [target, "wheel", takeOver, { passive: true }],
    // Every key fast-forwards the opening. Keys that are not the camera's (H, Esc, R) let the
    // camera ease out of it; camera keys arrive below and let go of it at once.
    [window, "keydown", skip],
  ];
  if (options.cameraKeys) listeners.push([options.cameraKeys, "keydown", onCameraKey]);
  for (const [t, type, fn, o] of listeners) t.addEventListener(type, fn, o);
  const dispose = () => {
    runner = null;
    gain = null;
    for (const [t, type, fn, o] of listeners) t.removeEventListener(type, fn, o);
  };

  return {
    get active() {
      return runner !== null;
    },
    skip,
    dispose,
    step(dt, live) {
      if (!runner) return 1;
      // The world was rebuilt under the opening (a roll, a new plane count): its plan no longer fits.
      if (live.length !== planeCount) {
        dispose();
        return 1;
      }
      const s = runner.step(dt);
      gain = s.planeGain;
      heroFraction = s.heroFraction;
      if (s.cameraWeight > 0 && !released) {
        const w = Math.min(1, s.cameraWeight);
        const now = camera.state;
        camera.state = {
          target: [
            lerp(now.target[0], s.pose.target[0], w),
            lerp(now.target[1], s.pose.target[1], w),
            lerp(now.target[2], s.pose.target[2], w),
          ],
          yaw: lerpAngle(now.yaw, s.pose.yaw, w),
          // The runner's pitch is the eye's elevation; CameraState pitch is the view direction's.
          pitch: lerp(now.pitch, -s.pose.pitch, w),
          distance: lerp(now.distance, s.pose.distance, w),
          fovY: now.fovY,
        };
      }
      const exposure = s.exposure;
      if (s.done) dispose();
      return exposure;
    },
    reveal(counts) {
      if (!runner || !gain || counts.length !== planeCount) return;
      const hero = runner.heroIndex;
      for (let i = 0; i < counts.length; i++) {
        if (i !== hero) counts[i] = gainToCount(counts[i], gain[i]);
        // heroFraction is already eased: a single particle first, then the flood.
        else counts[i] = heroFraction <= 0 ? 0 : Math.max(1, Math.round(counts[i] * Math.min(1, heroFraction)));
      }
    },
  };
}

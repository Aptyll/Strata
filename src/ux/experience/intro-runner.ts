// The opening, for an app that owns its own camera and frame loop.
//
// step(dt) returns what to show this frame: a brightness multiplier, a gain
// per plane (write it to PlaneDesc.brightness), and the camera pose the
// opening would like, with a weight saying how much it still cares. Nothing
// here touches the DOM, the GPU or a camera, so it mounts anywhere.
//
//   const intro = createIntroRunner({ planes: descs.map(planeFromDesc), aspect });
//   canvas.addEventListener('pointerdown', () => intro.skip(), { once: true });
//   // each frame:
//   const s = intro.step(dt);
//   brightness = scene.render.brightness * s.exposure;
//   planes.forEach((p, i) => (p.desc.brightness = s.planeGain[i]));
//   if (s.cameraWeight > 0) camera.state = { ...camera.state, ...s.pose };

import type { CameraPose, Plane } from './camera-rig';
import { IntroDirector, ignitionRanks, planeIgnition, type IntroPhase, type IntroVariant } from './intro';
import { lerp, v3 } from './math';

export interface IntroRunnerOptions {
  planes: readonly Plane[];
  /** The plane the opening starts on. Default: the one nearest the world's centre. */
  heroIndex?: number;
  variant?: IntroVariant;
  /** Vertical field of view in radians (default 50 degrees). */
  fovY?: number;
  /** Viewport width / height. May be a function if it can change. */
  aspect: number | (() => number);
  /** Camera distance for the final wide shot. Default: frames most of the world. */
  overviewDistance?: number;
}

export interface IntroFrame {
  phase: IntroPhase;
  /** 0..1 multiplier for RenderSettings.brightness. */
  exposure: number;
  /** 0..1 per plane, for PlaneDesc.brightness. Reused between frames. */
  planeGain: Float32Array;
  /** 0..1 fraction of the hero plane's particles to run (1 particle at the start). */
  heroFraction: number;
  /** Where the opening wants the camera. Fields match CameraState. */
  pose: CameraPose;
  /** 1 while the opening owns the camera, falling to 0 as it lets go. */
  cameraWeight: number;
  done: boolean;
}

export interface IntroRunner {
  step(dt: number): IntroFrame;
  /** The person did something: release the camera and fast-forward the rest. */
  skip(): void;
  restart(variant?: IntroVariant): void;
  readonly done: boolean;
  readonly heroIndex: number;
}

export function createIntroRunner(opts: IntroRunnerOptions): IntroRunner {
  const { planes } = opts;
  const fovY = opts.fovY ?? (50 * Math.PI) / 180;
  const aspect = typeof opts.aspect === 'function' ? opts.aspect : () => opts.aspect as number;

  let heroIndex = opts.heroIndex ?? -1;
  if (heroIndex < 0) {
    // Nearest to the centroid, so ignition spreads in every direction.
    const c = planes.reduce((a, p) => v3.add(a, p.center), [0, 0, 0]);
    const centroid = v3.scale(c, 1 / Math.max(1, planes.length));
    let best = Infinity;
    planes.forEach((p, i) => {
      const d = v3.length(v3.sub(p.center, centroid));
      if (d < best) { best = d; heroIndex = i; }
    });
  }
  const hero = planes[heroIndex];
  const ranks = ignitionRanks(planes, heroIndex);
  const planeGain = new Float32Array(planes.length);
  const director = new IntroDirector({ variant: opts.variant });

  const heroYaw = Math.atan2(hero.normal[0], hero.normal[2]);
  const heroPitch = Math.asin(Math.max(-1, Math.min(1, hero.normal[1])));
  let worldRadius = 0;
  for (const p of planes) {
    worldRadius = Math.max(worldRadius,
      v3.length(v3.sub(p.center, hero.center)) + Math.hypot(p.halfSize[0], p.halfSize[1]));
  }
  const overview = opts.overviewDistance ?? (worldRadius / Math.sin(fovY / 2)) * 0.72;
  // Close enough that the hero plane overfills the view, so it reads as flat.
  const close = (): number => {
    const tanY = Math.tan(fovY / 2);
    return Math.min(hero.halfSize[1] / tanY, hero.halfSize[0] / (tanY * aspect())) * 0.8;
  };

  return {
    heroIndex,
    get done() { return director.done; },
    skip: () => director.skip(),
    restart: (variant) => director.restart(variant),
    step(dt) {
      const s = director.update(dt);
      for (let i = 0; i < planes.length; i++) {
        planeGain[i] = i === heroIndex ? 1 : planeIgnition(s.spread, ranks[i]);
      }
      return {
        phase: s.phase,
        exposure: s.exposure,
        planeGain,
        // Squared, so the first particles arrive one by one and the rest in a flood.
        heroFraction: s.sparkAlpha <= 0 ? 0 : Math.max(1e-9, s.heroBloom * s.heroBloom),
        pose: {
          target: [hero.center[0], hero.center[1], hero.center[2]],
          yaw: heroYaw + s.pose.yaw,
          pitch: heroPitch + s.pose.pitch,
          distance: Math.exp(lerp(Math.log(close()), Math.log(overview), s.pose.distance)),
        },
        cameraWeight: s.cameraWeight,
        done: s.done,
      };
    },
  };
}

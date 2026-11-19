// The experience layer: everything between the person and the simulation.
//
// createExperience() owns the intro, the camera, input, the force brushes and
// the hints. It knows nothing about WebGPU. Once per frame the engine calls
// frame() and gets back plain numbers to put in its uniforms:
//
//   const xp = createExperience({ canvas, overlay, planes, heroIndex });
//   function tick(now) {
//     const f = xp.frame(now);
//     engine.render({
//       viewProj: f.viewProj,           // Float32Array(16)
//       exposure: f.exposure,           // 0..1
//       planeGain: f.planeGain,         // Float32Array(planes.length), 0..1 each
//       heroBloom: f.heroBloom,         // 0..1 reveal radius on the hero plane
//       brushes: f.brushes,             // Float32Array(32), see force-brush.js
//     });
//   }

import type { Mat4, Vec3 } from '../../core/contracts';
import { CameraRig, type CameraPose, type Plane } from './camera-rig';
import { ForceBrush, MAX_BRUSHES, BRUSH_DEFAULTS, packBrushes, type BrushOutput } from './force-brush';
import { bindGestures } from './gestures';
import { DEFAULT_HINTS, HintScheduler, createHintView, loadMemory, saveMemory } from './hints';
import { IntroDirector, ignitionRanks, planeIgnition, type IntroPhase, type IntroVariant } from './intro';
import { damp, lerp, v3 } from './math';
import { clientToNdc, pickPlane, screenToRay, worldPerPixel, type PlaneHit } from './pointer-ray';

export * from './camera-rig';
export * from './capability';
export * from './fallback';
export * from './force-brush';
export * from './gestures';
export * from './hints';
export * from './intro';
export * from './pointer-ray';

export interface ExperienceOptions {
  /** Element that receives input. */
  canvas: HTMLElement;
  /** Positioned element for hints. Omit for no hints. */
  overlay?: HTMLElement;
  /** The world's sheets. Build from PlaneDesc with planeFromDesc(). */
  planes: Plane[];
  /** The plane the intro opens on. */
  heroIndex?: number;
  touch?: boolean;
  reducedMotion?: boolean;
  /** Override the automatic choice of intro. */
  intro?: IntroVariant;
  /** Camera distance for the wide shot. */
  overviewDistance?: number;
  /** Remember learned hints and visits across sessions (default true). */
  persist?: boolean;
  /** Listen for keys on window (default true). */
  keyboard?: boolean;
}

/** Everything the renderer needs from the experience layer for one frame. */
export interface ExperienceFrame {
  /** Seconds since the previous frame, clamped. */
  dt: number;
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  eye: Vec3;
  /** 0..1 multiplier for RenderSettings.brightness. */
  exposure: number;
  /** 0..1 brightness of the lone first particle. */
  sparkAlpha: number;
  /** 0..1 how much of the hero plane has appeared. */
  heroBloom: number;
  /** 0..1 per plane: how lit it is. Reused between frames; do not keep. */
  planeGain: Float32Array;
  /** Packed brushes for a uniform buffer, see packBrushes(). Reused between frames. */
  brushes: Float32Array;
  brushOutputs: ReadonlyArray<BrushOutput | null>;
  /** Plane being viewed face-on, or -1. */
  focusedPlane: number;
  /** Plane under the pointer, or -1. */
  hoverPlane: number;
  /** 1 at the moment a plane is focused, decaying to 0. For a brief highlight. */
  focusGlow: number;
  phase: IntroPhase;
  introDone: boolean;
  /** Id of the hint on screen, if any. */
  hint: string | null;
}

interface PointerEntry {
  x: number;
  y: number;
  brush: ForceBrush;
  slot: number;
  held: boolean;
}

export type Experience = ReturnType<typeof createExperience>;

export function createExperience(opts: ExperienceOptions) {
  const { canvas, planes } = opts;
  const heroIndex = opts.heroIndex ?? 0;
  const hero = planes[heroIndex];
  const persist = opts.persist ?? true;
  const win = canvas.ownerDocument.defaultView ?? window;

  const memory = persist ? loadMemory() : { visits: 0, learned: [] };
  const variant: IntroVariant = opts.intro ??
    (opts.reducedMotion ? 'reduced' : memory.visits > 0 ? 'short' : 'full');
  if (persist) saveMemory({ ...memory, visits: memory.visits + 1 });

  const rig = new CameraRig();
  const intro = new IntroDirector({ variant });
  const ranks = ignitionRanks(planes, heroIndex);
  const planeGain = new Float32Array(planes.length);
  const hints = new HintScheduler(DEFAULT_HINTS, { learned: memory.learned });
  const hintView = opts.overlay ? createHintView(opts.overlay, { touch: opts.touch }) : null;

  let rect = canvas.getBoundingClientRect();
  const aspect = () => rect.width / Math.max(1, rect.height);

  // Camera distances for the two ends of the intro: close enough that the
  // hero plane overfills the view (no edges, so it reads as a flat 2D sim),
  // and far enough to take in a good part of the stack.
  const closeDistance = () => {
    const tanY = Math.tan(rig.fovY / 2);
    return Math.min(hero.halfSize[1] / tanY, hero.halfSize[0] / (tanY * aspect())) * 0.8;
  };
  // The wide shot frames most of the world around the hero plane, cropped a
  // little so the edges run off screen and the world reads as bigger than
  // the view.
  let worldRadius = 0;
  for (const p of planes) {
    worldRadius = Math.max(worldRadius,
      v3.length(v3.sub(p.center, hero.center)) + Math.hypot(p.halfSize[0], p.halfSize[1]));
  }
  const overviewDistance = opts.overviewDistance ??
    Math.min(rig.maxDistance, (worldRadius / Math.sin(rig.fovY / 2)) * 0.72);
  const heroYaw = Math.atan2(hero.normal[0], hero.normal[2]);
  const heroPitch = Math.asin(Math.max(-1, Math.min(1, hero.normal[1])));
  const overviewPose = (): CameraPose => ({
    target: [hero.center[0], hero.center[1], hero.center[2]], yaw: heroYaw + 0.62, pitch: heroPitch + 0.2,
    distance: overviewDistance,
  });
  rig.snap({ target: hero.center, yaw: heroYaw, pitch: heroPitch, distance: closeDistance() });

  const pointers = new Map<number, PointerEntry>();
  const freeSlots = Array.from({ length: MAX_BRUSHES }, (_, i) => i);
  const brushOutputs: Array<BrushOutput | null> = new Array(MAX_BRUSHES).fill(null);
  // Brushes that have been let go but are still playing out a release burst.
  const fading: Array<{ p: PointerEntry; ttl: number }> = [];
  const brushes = packBrushes([]);

  let focused = -1;
  let hoverPlane = -1;
  let focusGlow = 0;
  let last = 0;
  let cam = rig.matrices(aspect());
  let gesturing = 0; // seconds since the last gesture activity

  function learn(id: string): void {
    if (hints.learn(id) && persist) {
      const m = loadMemory();
      saveMemory({ ...m, learned: [...new Set([...m.learned, id])] });
    }
  }

  function pointerFor(id: number, x: number, y: number): PointerEntry | null {
    let p = pointers.get(id);
    if (!p) {
      if (!freeSlots.length) return null;
      p = { x, y, brush: new ForceBrush(), slot: freeSlots.shift()!, held: false };
      pointers.set(id, p);
    }
    p.x = x;
    p.y = y;
    return p;
  }

  function dropPointer(id: number): void {
    const p = pointers.get(id);
    if (!p) return;
    pointers.delete(id);
    p.brush.release();
    // Keep updating it until its burst has finished, then free the slot.
    fading.push({ p, ttl: BRUSH_DEFAULTS.burstSeconds + 0.1 });
  }

  function hitAt(x: number, y: number): PlaneHit | null {
    const [nx, ny] = clientToNdc(x, y, rect);
    const ray = screenToRay(nx, ny, cam.invViewProj);
    return pickPlane(ray, planes, { focused, visible: (i) => planeGain[i] > 0.2 });
  }

  const gestures = bindGestures(canvas, {
    onIntent() {
      intro.skip();
      gesturing = 0;
    },
    onOrbit(dx, dy) {
      rig.orbit(dx, dy, rect.height);
      learn('orbit');
    },
    onZoom(factor) {
      rig.zoom(factor);
      // Backing well away from a focused sheet means the person is done with it.
      if (focused >= 0 && rig.goal.distance > overviewDistance * 0.6) focused = -1;
      learn('zoom');
    },
    onHover(x, y, id) {
      pointerFor(id, x, y);
    },
    onHoverEnd(id) {
      if (pointers.has(id)) dropPointer(id);
    },
    onHoldStart(x, y, id, mode) {
      const p = pointerFor(id, x, y);
      if (!p) return;
      p.held = true;
      p.brush.press(mode);
    },
    onHoldMove(x, y, id) {
      pointerFor(id, x, y);
    },
    onHoldEnd(id) {
      const p = pointers.get(id);
      if (!p) return;
      p.held = false;
      // Only count it as learned if it did something to a sheet.
      if (p.brush.charge > 0.2 && p.brush.plane >= 0) learn('hold');
      p.brush.release();
    },
    // Same as the camera module (docs/ux/camera.md): a double click or
    // double tap faces a sheet, and on empty space it returns to the wide shot.
    onDoubleTap(x, y) {
      const hit = hitAt(x, y);
      if (hit && hit.index !== focused) focus(hit.index);
      else overview();
    },
  });

  function focus(index: number): void {
    if (index < 0 || index >= planes.length) return;
    intro.skip();
    focused = index;
    focusGlow = 1;
    rig.focusPlane(planes[index], aspect());
    learn('focus');
  }

  function overview(): void {
    focused = -1;
    rig.flyTo(overviewPose());
  }

  function onKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey) return;
    const step = rect.height * 0.12;
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': rig.orbit(step, 0, rect.height); learn('orbit'); break;
      case 'ArrowRight': rig.orbit(-step, 0, rect.height); learn('orbit'); break;
      case 'ArrowUp': rig.orbit(0, step, rect.height); learn('orbit'); break;
      case 'ArrowDown': rig.orbit(0, -step, rect.height); learn('orbit'); break;
      case '+': case '=': rig.zoom(0.8); learn('zoom'); break;
      case '-': case '_': rig.zoom(1.25); learn('zoom'); break;
      case ']': focus(((focused < 0 ? heroIndex : focused) + 1) % planes.length); break;
      case '[': focus(((focused < 0 ? heroIndex : focused) - 1 + planes.length) % planes.length); break;
      // Esc belongs to the HUD's settings menu (docs/ux/hud.md).
      case 'Home': overview(); break;
      default: used = false;
    }
    if (used) {
      intro.skip();
      gesturing = 0;
      e.preventDefault();
    }
  }
  if (opts.keyboard ?? true) win.addEventListener('keydown', onKey);

  /**
   * Advance one frame.
   * @param now milliseconds, as given to requestAnimationFrame
   */
  function frame(now: number): ExperienceFrame {
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 1 / 60);
    last = now;
    rect = canvas.getBoundingClientRect();
    gestures.tick(now);
    gesturing += dt;

    // Intro: brightness, ignition, and (until it lets go) the camera.
    const s = intro.update(dt);
    for (let i = 0; i < planes.length; i++) {
      planeGain[i] = i === heroIndex ? 1 : planeIgnition(s.spread, ranks[i]);
    }
    // A sheet being studied face-on should hold still; the wide view may wander.
    rig.driftEnabled = focused < 0;
    const o = overviewPose();
    rig.update(dt, s.cameraWeight > 0 ? {
      weight: s.cameraWeight,
      pose: {
        target: o.target,
        yaw: heroYaw + s.pose.yaw,
        pitch: heroPitch + s.pose.pitch,
        // Log-space, so the retreat has constant apparent speed.
        distance: Math.exp(lerp(Math.log(closeDistance()), Math.log(o.distance), s.pose.distance)),
      },
    } : undefined);
    rig.aspect = aspect();
    cam = rig.matrices(rig.aspect);

    // Brushes: cast each pointer into the world and update its force.
    const forward = v3.scale(rig.direction(), -1);
    hoverPlane = -1;
    brushOutputs.fill(null);
    const castBrush = (p: PointerEntry, live: boolean): void => {
      const hit = live ? hitAt(p.x, p.y) : null;
      let radius = 0;
      if (hit) {
        const plane = planes[hit.index];
        const wpp = worldPerPixel(hit.point, cam.eye, forward, rig.fovY, rect.height);
        const minHalf = Math.min(plane.halfSize[0], plane.halfSize[1]);
        radius = Math.min(BRUSH_DEFAULTS.radiusPx * wpp / minHalf, BRUSH_DEFAULTS.maxRadiusFrac);
        if (hoverPlane < 0) hoverPlane = hit.index;
      }
      brushOutputs[p.slot] = p.brush.update(dt, hit, radius);
    };
    // No forces until the hero plane has bloomed: there is nothing to push yet.
    const forcesLive = s.heroBloom > 0.5;
    for (const p of pointers.values()) castBrush(p, forcesLive);
    for (let i = fading.length - 1; i >= 0; i--) {
      const f = fading[i];
      f.ttl -= dt;
      castBrush(f.p, false);
      if (f.ttl <= 0) {
        freeSlots.push(f.p.slot);
        fading.splice(i, 1);
      }
    }
    packBrushes(brushOutputs, brushes);

    focusGlow = damp(focusGlow, 0, 0.5, dt);

    // Hints wait for the intro to finish and for the hands to be still.
    const hint = hints.update(dt, intro.done && gesturing > 1.5);
    hintView?.show(hint);

    return {
      dt,
      view: cam.view,
      proj: cam.proj,
      viewProj: cam.viewProj,
      eye: cam.eye,
      exposure: s.exposure,
      sparkAlpha: s.sparkAlpha,
      heroBloom: s.heroBloom,
      planeGain,
      brushes,
      brushOutputs,
      focusedPlane: focused,
      hoverPlane,
      focusGlow,
      phase: s.phase,
      introDone: intro.done,
      hint: hint?.id ?? null,
    };
  }

  return {
    frame,
    rig,
    intro,
    hints,
    focus,
    overview,
    /** Replay the opening. */
    replay(v: IntroVariant = 'full'): void {
      focused = -1;
      intro.restart(v);
      rig.snap({ target: hero.center, yaw: heroYaw, pitch: heroPitch, distance: closeDistance() });
    },
    dispose(): void {
      gestures.dispose();
      hintView?.dispose();
      win.removeEventListener('keydown', onKey);
    },
  };
}

/**
 * How many of a plane's particles to run for a given gain, so the intro can
 * be played with the existing contracts alone: scale each PlaneInstance's
 * activeCount by this, and RenderSettings.brightness by frame.exposure.
 * With gain near zero a lit plane still shows a single particle, which is
 * exactly the opening spark.
 */
export function gainToActiveCount(capacity: number, gain: number): number {
  if (gain <= 0) return 0;
  // Squared, so the first particles arrive one by one and the rest in a flood.
  return Math.max(1, Math.min(capacity, Math.round(capacity * gain * gain)));
}

/**
 * A default world layout for prototyping: parallel sheets stacked along Z,
 * like pages standing in a box. The scene owner decides the real layout.
 */
export function stackedPlanes(
  count: number,
  opts: { spacing?: number; halfSize?: [number, number] } = {},
): Plane[] {
  const spacing = opts.spacing ?? 0.4;
  const halfSize = opts.halfSize ?? [1, 1];
  return Array.from({ length: count }, (_, i): Plane => ({
    center: [0, 0, (i - (count - 1) / 2) * spacing],
    normal: [0, 0, 1],
    u: [1, 0, 0],
    v: [0, 1, 0],
    halfSize: [halfSize[0], halfSize[1]],
  }));
}

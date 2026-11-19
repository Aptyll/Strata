// Pointer forces for the real engine.
//
// Listens on the canvas next to whatever camera input is attached, and each
// frame returns the packed brushes for `writeGlobals({ brushes })`. It owns
// no camera: it reads the view from the CameraController it is given.
//
// The rule is the same as in the standalone demo: a press that travels is the
// camera's, a press that stays still becomes a force. Once a hold has begun,
// this module swallows that pointer's moves so the camera does not also turn.

import { BRUSH_FLOATS, MAX_BRUSHES, type CameraController, type PlaneInstance } from '../../core/contracts';
import { planeFromDesc, type Plane } from './camera-rig';
import { BRUSH_DEFAULTS, ForceBrush } from './force-brush';
import { GESTURE_DEFAULTS, GestureCore, type PointerSample } from './gestures';
import { m4, v3 } from './math';
import { clientToNdc, pickPlane, screenToRay, worldPerPixel } from './pointer-ray';

export interface EngineBrushes {
  /**
   * Advance the brushes and return them packed for the Globals uniform.
   * The returned array is reused between frames.
   * @param dt seconds
   * @param now milliseconds, as given to requestAnimationFrame
   */
  update(dt: number, now: number): Float32Array;
  dispose(): void;
}

interface Entry {
  x: number;
  y: number;
  brush: ForceBrush;
  /** Seconds left to live after the pointer has gone, for the release burst. */
  ttl: number;
}

export function attachBrushes(
  canvas: HTMLCanvasElement,
  camera: CameraController,
  getPlanes: () => readonly PlaneInstance[],
): EngineBrushes {
  const out = new Float32Array(MAX_BRUSHES * BRUSH_FLOATS);
  const entries = new Map<number, Entry>();
  const holding = new Set<number>();

  // Plane geometry is rebuilt only when the plane list changes.
  let cachedFrom: readonly PlaneInstance[] | null = null;
  let cachedCount = -1;
  let planes: Plane[] = [];
  const currentPlanes = (): Plane[] => {
    const list = getPlanes();
    if (list !== cachedFrom || list.length !== cachedCount) {
      cachedFrom = list;
      cachedCount = list.length;
      planes = list.map((p) => planeFromDesc(p.desc));
    }
    return planes;
  };

  const entryFor = (id: number, x: number, y: number): Entry | null => {
    let e = entries.get(id);
    if (!e) {
      if (entries.size >= MAX_BRUSHES) return null;
      e = { x, y, brush: new ForceBrush(), ttl: Infinity };
      entries.set(id, e);
    }
    e.x = x;
    e.y = y;
    e.ttl = Infinity;
    return e;
  };
  const retire = (id: number): void => {
    const e = entries.get(id);
    if (!e) return;
    e.brush.release();
    e.ttl = BRUSH_DEFAULTS.burstSeconds + 0.1;
  };

  const core = new GestureCore({
    onHover: (x, y, id) => { entryFor(id, x, y); },
    onHoverEnd: (id) => retire(id),
    onHoldStart: (x, y, id, mode) => {
      holding.add(id);
      entryFor(id, x, y)?.brush.press(mode);
    },
    onHoldMove: (x, y, id) => { entryFor(id, x, y); },
    onHoldEnd: (id) => {
      holding.delete(id);
      entries.get(id)?.brush.release();
    },
  }, {
    // The app camera pans on a right drag (src/ux/camera/input.ts). A push that
    // started at once would swallow that drag, so the right button waits for the
    // hold like any other press: right drag pans, right hold pushes.
    holdSecondary: GESTURE_DEFAULTS.holdMouse,
  });

  const sample = (e: PointerEvent): PointerSample => ({
    id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType,
    button: e.button, shift: e.shiftKey, alt: e.altKey,
  });
  const onDown = (e: PointerEvent) => { if (e.target === canvas) core.down(sample(e), e.timeStamp); };
  const onMove = (e: PointerEvent) => {
    if (e.target !== canvas && !core.pointers.has(e.pointerId)) return;
    core.move(sample(e), e.timeStamp);
    // This pointer is a force now. Keep the camera from reading it as a drag.
    if (holding.has(e.pointerId)) e.stopImmediatePropagation();
  };
  const onUp = (e: PointerEvent) => core.up(sample(e), e.timeStamp);
  const onCancel = (e: PointerEvent) => core.cancel({ id: e.pointerId });
  const onLeave = (e: PointerEvent) => { if (!core.pointers.has(e.pointerId)) retire(e.pointerId); };

  // Capture phase on window, so these run before the camera's own listeners.
  const win = canvas.ownerDocument.defaultView ?? window;
  win.addEventListener('pointerdown', onDown, true);
  win.addEventListener('pointermove', onMove, true);
  win.addEventListener('pointerup', onUp, true);
  win.addEventListener('pointercancel', onCancel, true);
  canvas.addEventListener('pointerleave', onLeave);

  function update(dt: number, now: number): Float32Array {
    core.tick(now);
    const rect = canvas.getBoundingClientRect();
    const list = getPlanes();
    const geo = currentPlanes();
    const viewProj = camera.viewProjection(rect.width / Math.max(1, rect.height));
    const inv = m4.invert(viewProj);
    const eye = camera.eye();
    const forward = v3.normalize(v3.sub(camera.state.target, eye));

    let slot = 0;
    out.fill(0);
    for (let k = 0; k < MAX_BRUSHES; k++) out[k * BRUSH_FLOATS + 6] = -1;

    for (const [id, e] of entries) {
      const live = e.ttl === Infinity;
      let hit = null;
      if (live && inv) {
        const [nx, ny] = clientToNdc(e.x, e.y, rect);
        hit = pickPlane(screenToRay(nx, ny, inv), geo, {
          visible: (i) => list[i].activeCount > 0 && !list[i].paused,
        });
      }
      let radius = 0;
      if (hit) {
        const p = geo[hit.index];
        const wpp = worldPerPixel(hit.point, eye, forward, camera.state.fovY, rect.height);
        radius = Math.min(
          (BRUSH_DEFAULTS.radiusPx * wpp) / Math.min(p.halfSize[0], p.halfSize[1]),
          BRUSH_DEFAULTS.maxRadiusFrac,
        );
      }
      const b = e.brush.update(dt, hit, radius);
      if (b.plane >= 0 && b.plane < list.length && slot < MAX_BRUSHES) {
        const o = slot++ * BRUSH_FLOATS;
        out[o] = b.u; out[o + 1] = b.v; out[o + 2] = b.radius; out[o + 3] = b.strength;
        out[o + 4] = b.du; out[o + 5] = b.dv;
        // The GPU matches a brush to its plane by seed, see Brush in the contracts.
        out[o + 6] = list[b.plane].desc.seed;
        out[o + 7] = b.charge;
      }
      if (!live) {
        e.ttl -= dt;
        if (e.ttl <= 0) entries.delete(id);
      }
    }
    return out;
  }

  return {
    update,
    dispose() {
      win.removeEventListener('pointerdown', onDown, true);
      win.removeEventListener('pointermove', onMove, true);
      win.removeEventListener('pointerup', onUp, true);
      win.removeEventListener('pointercancel', onCancel, true);
      canvas.removeEventListener('pointerleave', onLeave);
    },
  };
}

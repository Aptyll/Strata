/**
 * DOM bindings for CameraRig: mouse, trackpad, touch, pen, keyboard.
 *
 *   const detach = attachCameraInput(canvas, camera);
 *
 * The controller itself never touches the DOM, so the engine can replace this
 * file with its own bindings without losing any of the camera feel.
 */

import type { CameraRig } from "./rig";

export interface CameraInputOptions {
  /** Element that receives key events. Defaults to window. */
  keyTarget?: Window | HTMLElement;
  /** Keep the controller's aspect ratio in sync with the element. Default true. */
  observeResize?: boolean;
  /** Read prefers-reduced-motion and pass it to the controller. Default true. */
  respectReducedMotion?: boolean;
  /** Wheel and pinch sensitivity multiplier. Default 1. */
  zoomSpeed?: number;
  /** Drag rotation sensitivity multiplier. Default 1. */
  rotateSpeed?: number;
  /** Called after a double click or double tap that hit no plane. Default: fly home. */
  onEmptyDoubleTap?: () => void;
}

interface Pointer {
  x: number;
  y: number;
  type: string;
}

const TAP_MAX_MOVE = 6; // px
const TAP_MAX_TIME = 300; // ms
const DOUBLE_TAP_TIME = 350; // ms
const DOUBLE_TAP_DIST = 30; // px

const MOVE_KEYS: Record<string, [number, number, number]> = {
  KeyW: [0, 0, 1],
  ArrowUp: [0, 0, 1],
  KeyS: [0, 0, -1],
  ArrowDown: [0, 0, -1],
  KeyA: [-1, 0, 0],
  ArrowLeft: [-1, 0, 0],
  KeyD: [1, 0, 0],
  ArrowRight: [1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
};

export function attachCameraInput(
  element: HTMLElement,
  camera: CameraRig,
  options: CameraInputOptions = {},
): () => void {
  const zoomSpeed = options.zoomSpeed ?? 1;
  const rotateSpeed = options.rotateSpeed ?? 1;
  const keyTarget: Window | HTMLElement = options.keyTarget ?? window;

  const pointers = new Map<number, Pointer>();
  const keys = new Set<string>();
  let panDrag = false;
  /** The pan in progress has been scaled to what it started on (CameraRig.grab). */
  let panGrabbed = false;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let moved = 0;
  let lastTapTime = -Infinity;
  let lastTapX = 0;
  let lastTapY = 0;
  let pinchDist = 0;
  let pinchX = 0;
  let pinchY = 0;
  let trackpadUntil = 0;
  /** A Shift + two-finger scroll pan is in progress until this time. */
  let scrollPanUntil = 0;

  const prevTouchAction = element.style.touchAction;
  element.style.touchAction = "none";

  const rect = () => element.getBoundingClientRect();
  const toNdc = (clientX: number, clientY: number): [number, number] => {
    const r = rect();
    return [
      ((clientX - r.left) / Math.max(r.width, 1)) * 2 - 1,
      1 - ((clientY - r.top) / Math.max(r.height, 1)) * 2,
    ];
  };

  const syncSize = () => {
    const r = rect();
    camera.setViewport(r.width, r.height);
  };

  /** Rotate so the scene follows the hand, in both orbit and fly modes. */
  const dragRotate = (dx: number, dy: number, forceLook: boolean) => {
    const h = Math.max(rect().height, 1);
    if (forceLook || camera.mode === "fly") {
      // Looking around in place: one viewport height sweeps one field of view,
      // so the point under the pointer stays under the pointer.
      const k = (camera.options.fovY / h) * rotateSpeed;
      camera.rotate(dx * k, dy * k, "eye");
    } else {
      // Orbiting: one viewport height is half a turn.
      const k = (Math.PI / h) * rotateSpeed;
      camera.rotate(-dx * k, -dy * k, "target");
    }
  };

  const dragPan = (dx: number, dy: number) => {
    const r = rect();
    camera.pan((dx / Math.max(r.width, 1)) * 2, (-dy / Math.max(r.height, 1)) * 2);
  };

  const pinchState = () => {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    pinchX = (a.x + b.x) / 2;
    pinchY = (a.y + b.y) / 2;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (pointers.size === 0) {
      camera.beginGesture();
      downX = e.clientX;
      downY = e.clientY;
      downTime = e.timeStamp;
      moved = 0;
      panDrag =
        e.pointerType === "mouse" && (e.button === 1 || e.button === 2 || e.shiftKey);
      panGrabbed = false;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (pointers.size === 2) {
      pinchState();
      // Two fingers pan and pinch whatever lies between them.
      camera.grab(...toNdc(pinchX, pinchY));
    }
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic events. Dragging still works inside the element.
    }
    if (e.pointerType === "mouse") e.preventDefault();
  };

  const onPointerMove = (e: PointerEvent) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);

    if (pointers.size === 1) {
      if (panDrag) {
        // Scale the pan to the sheet the press landed on, so that sheet stays under the pointer.
        // Done on the first move, not on the press: a press that never moves is not a pan.
        if (!panGrabbed) {
          panGrabbed = true;
          camera.grab(...toNdc(downX, downY));
        }
        dragPan(dx, dy);
      } else dragRotate(dx, dy, e.altKey);
    } else if (pointers.size === 2) {
      const prevDist = pinchDist;
      const prevX = pinchX;
      const prevY = pinchY;
      pinchState();
      dragPan(pinchX - prevX, pinchY - prevY);
      if (prevDist > 0 && pinchDist > 0) {
        const [nx, ny] = toNdc(pinchX, pinchY);
        camera.zoom(Math.log(prevDist / pinchDist) * zoomSpeed, nx, ny);
      }
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!pointers.delete(e.pointerId)) return;
    try {
      element.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (pointers.size > 0) return;
    camera.endGesture();

    const isTap =
      e.type === "pointerup" &&
      moved <= TAP_MAX_MOVE &&
      e.timeStamp - downTime <= TAP_MAX_TIME;
    if (!isTap) {
      lastTapTime = -Infinity;
      return;
    }
    const isDouble =
      e.timeStamp - lastTapTime <= DOUBLE_TAP_TIME &&
      Math.hypot(downX - lastTapX, downY - lastTapY) <= DOUBLE_TAP_DIST;
    if (isDouble) {
      lastTapTime = -Infinity;
      const [nx, ny] = toNdc(e.clientX, e.clientY);
      // A sheet: face it. Open space: back to the view the scene opened on, the way out of
      // any spot where nothing is in sight.
      if (!camera.focusAt(nx, ny)) {
        if (options.onEmptyDoubleTap) options.onEmptyDoubleTap();
        else camera.flyHome();
      }
    } else {
      lastTapTime = e.timeStamp;
      lastTapX = downX;
      lastTapY = downY;
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [nx, ny] = toNdc(e.clientX, e.clientY);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect().height : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;

    // Browsers report a trackpad pinch as a wheel event with ctrlKey set.
    if (e.ctrlKey || e.metaKey) {
      camera.zoom(clampAbs(dy * 0.01, 0.5) * zoomSpeed, nx, ny);
      return;
    }

    // Tell a trackpad two-finger scroll from a mouse wheel. There is no real
    // API for this, so it is a heuristic: trackpads send small pixel deltas,
    // often with a horizontal part. Once seen, stay in trackpad mode briefly
    // so one gesture is never split between two behaviors.
    const looksLikeTrackpad =
      e.deltaMode === 0 && (dx !== 0 || (Math.abs(dy) < 50 && !Number.isInteger(dy)));
    if (looksLikeTrackpad) trackpadUntil = e.timeStamp + 400;
    if (e.timeStamp < trackpadUntil) {
      if (e.shiftKey) {
        // Scale the pan to what it starts on, once per gesture: the scene slides under a
        // pointer that stays put, so grabbing again mid-gesture would change the pace.
        if (e.timeStamp > scrollPanUntil) camera.grab(nx, ny);
        scrollPanUntil = e.timeStamp + 250;
        dragPan(-dx, -dy);
      } else dragRotate(-dx, -dy, false);
      return;
    }

    // Mouse wheel: each notch (about 100 px) scales distance by roughly 16%.
    camera.zoom(clampAbs(dy * 0.0015, 0.5) * zoomSpeed, nx, ny);
  };

  const applyKeys = () => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const code of keys) {
      const m = MOVE_KEYS[code];
      if (!m) continue;
      x += m[0];
      y += m[1];
      z += m[2];
    }
    camera.setMove(
      Math.sign(x),
      Math.sign(y),
      Math.sign(z),
      keys.has("ShiftLeft") || keys.has("ShiftRight"),
    );
  };

  const isTyping = (e: Event): boolean => {
    const t = e.target as HTMLElement | null;
    if (!t || !("tagName" in t)) return false;
    return (
      t.tagName === "INPUT" ||
      t.tagName === "TEXTAREA" ||
      t.tagName === "SELECT" ||
      t.isContentEditable === true
    );
  };

  const onKeyDown = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code in MOVE_KEYS || e.code === "ShiftLeft" || e.code === "ShiftRight") {
      keys.add(e.code);
      applyKeys();
      if (e.code.startsWith("Arrow")) e.preventDefault();
      return;
    }
    if (e.repeat) return;
    switch (e.code) {
      case "KeyF":
        camera.focusNearest();
        break;
      case "Period":
        camera.focusNext(1);
        break;
      case "Comma":
        camera.focusNext(-1);
        break;
      case "KeyH":
      case "Home":
        camera.flyHome();
        break;
      case "Space":
        camera.options.idle.enabled = !camera.options.idle.enabled;
        e.preventDefault();
        break;
      default:
        break;
    }
  };

  const onKeyUp = (ev: Event) => {
    const e = ev as KeyboardEvent;
    if (keys.delete(e.code)) applyKeys();
  };

  const onBlur = () => {
    if (keys.size === 0) return;
    keys.clear();
    applyKeys();
  };

  const onContextMenu = (e: Event) => e.preventDefault();

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  element.addEventListener("wheel", onWheel, { passive: false });
  element.addEventListener("contextmenu", onContextMenu);
  keyTarget.addEventListener("keydown", onKeyDown);
  keyTarget.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);

  let resizeObserver: ResizeObserver | null = null;
  if (options.observeResize !== false) {
    syncSize();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(syncSize);
      resizeObserver.observe(element);
    }
  }

  let motionQuery: MediaQueryList | null = null;
  const onMotionChange = () => {
    if (motionQuery) camera.options.reducedMotion = motionQuery.matches;
  };
  if (options.respectReducedMotion !== false && typeof matchMedia === "function") {
    motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    onMotionChange();
    motionQuery.addEventListener("change", onMotionChange);
  }

  return () => {
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerUp);
    element.removeEventListener("pointercancel", onPointerUp);
    element.removeEventListener("wheel", onWheel);
    element.removeEventListener("contextmenu", onContextMenu);
    keyTarget.removeEventListener("keydown", onKeyDown);
    keyTarget.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    resizeObserver?.disconnect();
    motionQuery?.removeEventListener("change", onMotionChange);
    element.style.touchAction = prevTouchAction;
    camera.setMove(0, 0, 0);
    if (pointers.size > 0) camera.endGesture();
    pointers.clear();
  };
}

const clampAbs = (x: number, max: number): number =>
  x > max ? max : x < -max ? -max : x;

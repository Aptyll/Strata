// One gesture vocabulary for mouse, pen and touch.
//
// The rule that makes it work on every device:
//     move to look, hold still to touch.
// A pointer that goes down and travels is steering the camera. A pointer that
// goes down and stays put on something becomes a force on the particles, and
// once it has stayed put a little longer it can move freely, dragging the
// force with it. A press that pauses and then travels before that is still a
// camera drag: nobody should lose a turn of the camera to a moment's hesitation.
//
// GestureCore is pure: feed it down/move/up/tick with timestamps and it emits
// events. bindGestures() wires it to a DOM element.

export const GESTURE_DEFAULTS = Object.freeze({
  /** Pixels of travel before a press counts as a drag. */
  slopMouse: 5,
  slopTouch: 10,
  /** Milliseconds a pointer must stay put to become a hold. */
  holdMouse: 170,
  holdTouch: 230,
  /**
   * Milliseconds a hold must then last, pointer still inside the slop radius,
   * before it is settled. A settled hold can be dragged about. One that
   * travels sooner was a camera drag that began with a pause: the hold is
   * called off and the drag carries on. 0 settles every hold at once.
   */
  holdSettle: 220,
  /**
   * Milliseconds the right button must stay put to become a push. 0 pushes at
   * once, which suits a host where a right drag means nothing. The app's
   * camera pans on a right drag, so it waits like any other press there.
   */
  holdSecondary: 0,
  /** Two taps within this time and distance make a double tap. */
  doubleTapMs: 320,
  doubleTapPx: 28,
});

export type GestureConfig = { -readonly [K in keyof typeof GESTURE_DEFAULTS]: number };
export type HoldMode = 'attract' | 'repel';

export interface GestureHandlers {
  /** Drag, in pixels. */
  onOrbit?(dx: number, dy: number): void;
  /** factor < 1 moves in. */
  onZoom?(factor: number, x: number, y: number): void;
  /** Pointer position with nothing pressed. */
  onHover?(x: number, y: number, id: number): void;
  onHoverEnd?(id: number): void;
  /**
   * Return false when there is nothing to touch at (x, y). The press then
   * stays a camera press, and is asked again on every tick while it stays put.
   */
  canHold?(x: number, y: number, id: number): boolean;
  onHoldStart?(x: number, y: number, id: number, mode: HoldMode): void;
  /** The hold has lasted holdSettle: from here on, moving the pointer drags the force. */
  onHoldSettle?(id: number): void;
  onHoldMove?(x: number, y: number, id: number): void;
  /** `calledOff` is true when the press turned out to be a camera drag (see holdSettle). */
  onHoldEnd?(id: number, calledOff?: boolean): void;
  onTap?(x: number, y: number): void;
  onDoubleTap?(x: number, y: number): void;
  /** Any deliberate input. Used to skip the intro. */
  onIntent?(kind: 'press' | 'wheel'): void;
}

/** A pointer event reduced to what the recogniser needs. */
export interface PointerSample {
  id: number;
  x: number;
  y: number;
  /** 'mouse' | 'pen' | 'touch' */
  type?: string;
  button?: number;
  shift?: boolean;
  alt?: boolean;
}

interface Tracked {
  id: number;
  x: number;
  y: number;
  x0: number;
  y0: number;
  t0: number;
  touch: boolean;
  /** Pressed with the right button. */
  secondary: boolean;
  state: 'pending' | 'drag' | 'hold' | 'pinch';
  mode: HoldMode;
  /** When the hold began, milliseconds. */
  heldAt: number;
  /** The hold has lasted holdSettle (see GESTURE_DEFAULTS). */
  settled: boolean;
}

export class GestureCore {
  h: GestureHandlers;
  cfg: GestureConfig;
  pointers = new Map<number, Tracked>();
  private pinch: { a: Tracked; b: Tracked; dist: number } | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;

  constructor(handlers: GestureHandlers = {}, opts: Partial<GestureConfig> = {}) {
    this.h = handlers;
    this.cfg = { ...GESTURE_DEFAULTS, ...opts };
  }

  /** @param now milliseconds */
  down(e: PointerSample, now: number): void {
    const touch = e.type === 'touch';
    const secondary = e.button === 2 || !!e.shift || !!e.alt;
    const p: Tracked = {
      id: e.id, x: e.x, y: e.y, x0: e.x, y0: e.y, t0: now,
      touch, secondary: e.button === 2, state: 'pending', mode: secondary ? 'repel' : 'attract',
      heldAt: 0, settled: false,
    };
    this.pointers.set(e.id, p);
    this.h.onIntent?.('press');

    if (p.secondary && this.cfg.holdSecondary <= 0) {
      // No camera meaning for a right drag in this host, so the push need not wait.
      this.startHold(p, now);
      return;
    }
    if (this.pointers.size === 2) this.beginPinch();
  }

  move(e: PointerSample, now: number): void {
    const p = this.pointers.get(e.id);
    if (!p) {
      this.h.onHover?.(e.x, e.y, e.id);
      return;
    }
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    p.x = e.x;
    p.y = e.y;

    if (this.pinch && p.state === 'pinch') {
      this.updatePinch();
      return;
    }
    const slop = p.touch ? this.cfg.slopTouch : this.cfg.slopMouse;
    const travelled = Math.hypot(p.x - p.x0, p.y - p.y0) > slop;
    if (p.state === 'pending') {
      if (travelled) {
        p.state = 'drag';
        // Do not lose the travel that happened inside the slop radius.
        this.h.onOrbit?.(p.x - p.x0, p.y - p.y0);
      }
      return;
    }
    if (p.state === 'drag') {
      this.h.onOrbit?.(dx, dy);
      return;
    }
    if (p.state !== 'hold') return;
    if (!p.settled && now - p.heldAt >= this.cfg.holdSettle) this.settle(p);
    if (!p.settled && travelled) {
      // It set off before the hold settled: a camera drag that began with a pause.
      p.state = 'drag';
      this.h.onHoldEnd?.(p.id, true);
      this.h.onOrbit?.(p.x - p.x0, p.y - p.y0);
      return;
    }
    this.h.onHoldMove?.(p.x, p.y, p.id);
  }

  up(e: PointerSample, now: number): void {
    const p = this.pointers.get(e.id);
    if (!p) return;
    this.pointers.delete(e.id);

    if (p.state === 'hold') {
      this.h.onHoldEnd?.(p.id);
    } else if (p.state === 'pending') {
      const last = this.lastTap;
      if (last && now - last.t < this.cfg.doubleTapMs &&
          Math.hypot(p.x - last.x, p.y - last.y) < this.cfg.doubleTapPx) {
        this.lastTap = null;
        this.h.onDoubleTap?.(p.x, p.y);
      } else {
        this.lastTap = { t: now, x: p.x, y: p.y };
        this.h.onTap?.(p.x, p.y);
      }
    } else if (p.state === 'pinch') {
      this.endPinch();
    }
    if (p.touch) this.h.onHoverEnd?.(p.id);
  }

  cancel(e: Pick<PointerSample, 'id'>): void {
    const p = this.pointers.get(e.id);
    if (!p) return;
    this.pointers.delete(e.id);
    if (p.state === 'hold') this.h.onHoldEnd?.(p.id);
    if (p.state === 'pinch') this.endPinch();
    this.h.onHoverEnd?.(p.id);
  }

  /** Call every frame so holds can begin while the pointer is motionless. */
  tick(now: number): void {
    for (const p of this.pointers.values()) {
      if (p.state === 'hold' && !p.settled && now - p.heldAt >= this.cfg.holdSettle) this.settle(p);
      if (p.state !== 'pending') continue;
      const delay = p.secondary ? this.cfg.holdSecondary : p.touch ? this.cfg.holdTouch : this.cfg.holdMouse;
      if (now - p.t0 >= delay) this.startHold(p, now);
    }
  }

  /** Wheel or trackpad scroll. deltaY in pixels; positive moves away. */
  wheel(deltaY: number, x: number, y: number): void {
    this.h.onIntent?.('wheel');
    this.h.onZoom?.(Math.exp(deltaY * 0.0015), x, y);
  }

  private startHold(p: Tracked, now: number): void {
    if (this.h.canHold && !this.h.canHold(p.x, p.y, p.id)) return;
    p.state = 'hold';
    p.heldAt = now;
    this.h.onHoldStart?.(p.x, p.y, p.id, p.mode);
    if (this.cfg.holdSettle <= 0) this.settle(p);
  }

  private settle(p: Tracked): void {
    p.settled = true;
    this.h.onHoldSettle?.(p.id);
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    // A second finger turns whatever the first was doing into a pinch.
    for (const p of [a, b]) {
      if (p.state === 'hold') this.h.onHoldEnd?.(p.id);
      p.state = 'pinch';
    }
    this.pinch = { a, b, dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  }

  private endPinch(): void {
    this.pinch = null;
    // The finger left behind carries on as a camera drag, never as a tap or
    // a hold: lifting one finger of a pinch should not fire anything.
    for (const q of this.pointers.values()) if (q.state === 'pinch') q.state = 'drag';
  }

  private updatePinch(): void {
    if (!this.pinch) return;
    const { a, b } = this.pinch;
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    // Fingers apart = move in, matching every map and photo app.
    this.h.onZoom?.(this.pinch.dist / dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    this.pinch.dist = dist;
  }
}

/**
 * Attach a GestureCore to an element using Pointer Events.
 * The element should have `touch-action: none` (set here) so the browser
 * does not scroll, zoom or pull-to-refresh underneath us.
 */
export function bindGestures(
  el: HTMLElement,
  handlers: GestureHandlers,
  opts?: Partial<GestureConfig>,
): { core: GestureCore; tick: (now: number) => void; dispose: () => void } {
  const core = new GestureCore(handlers, opts);
  const ev = (e: PointerEvent): PointerSample => ({
    id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType,
    button: e.button, shift: e.shiftKey, alt: e.altKey,
  });
  const prevTouchAction = el.style.touchAction;
  el.style.touchAction = 'none';

  const down = (e: PointerEvent) => {
    try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    core.down(ev(e), e.timeStamp);
  };
  const move = (e: PointerEvent) => core.move(ev(e), e.timeStamp);
  const up = (e: PointerEvent) => core.up(ev(e), e.timeStamp);
  const cancel = (e: PointerEvent) => core.cancel(ev(e));
  const leave = (e: PointerEvent) => {
    if (!core.pointers.has(e.pointerId)) handlers.onHoverEnd?.(e.pointerId);
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    // Line and page scroll modes report tiny numbers; scale them to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    core.wheel(e.deltaY * unit * (e.ctrlKey ? 6 : 1), e.clientX, e.clientY);
  };
  const menu = (e: Event) => e.preventDefault();

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('wheel', wheel, { passive: false });
  el.addEventListener('contextmenu', menu);
  return {
    core,
    tick: (now) => core.tick(now),
    dispose() {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', menu);
      el.style.touchAction = prevTouchAction;
    },
  };
}

// Hints inside the app: the experience's one-line gesture hints and the HUD's
// breathing die, on one schedule.
//
// At most one is on screen. None plays during the opening, during a gesture,
// with the settings menu open or while a long job runs. Each is retired for
// good the first time the person does the thing (remembered in localStorage)
// and shows at most once per visit. The die comes after the first drag: a
// stranger first learns that the world turns, then that it can be rerolled.
//
//   const hints = mountAppHints({ canvas, hud, isOpening: () => intro?.active ?? false, canHold: brushes.touches });
//   mountHud(app, { hud: { diceHintMs: 0 } });   // the schedule owns the die hint
//   // each frame:
//   hints.update(dt);
//
// Gestures are read from the canvas with the same thresholds and the same
// "is there a sheet to touch here" test the pointer forces use, and never
// consumed, so this file needs no hooks in the camera.

import { GESTURE_DEFAULTS, GestureCore, type PointerSample } from './gestures';
import { DEFAULT_HINTS, HintScheduler, createHintView, loadMemory, saveMemory, type HintDef } from './hints';

/** The die's turn. No text: the HUD makes the die breathe instead. */
export const ROLL_HINT: HintDef = { id: 'roll', text: '', delay: 3, after: ['orbit'], duration: 9 };

/** The gesture hints with the die slotted in right after the first drag. */
export const APP_HINTS: HintDef[] = DEFAULT_HINTS.flatMap((h) => (h.id === 'orbit' ? [h, ROLL_HINT] : [h]));

/** The parts of the HUD (src/ux/hud) this uses. */
export interface HintHud {
  hintDice(on: boolean): void;
  onRandomize(fn: () => void): () => void;
  readonly rolled: boolean;
  readonly panelOpen: boolean;
  readonly busy: boolean;
}

export interface AppHintsOptions {
  /** The element the camera listens on. */
  canvas: HTMLElement;
  hud?: HintHud;
  /** True while the opening plays. */
  isOpening?: () => boolean;
  /**
   * Whether a still press at this point of the page (client pixels) touches a
   * sheet, as the pointer forces see it (EngineBrushes.touches). Without it,
   * every still press counts as a hold.
   */
  canHold?: (x: number, y: number) => boolean;
  /** Touch wording. Defaults to the (pointer: coarse) media query. */
  touch?: boolean;
  /** Where the hint line goes. Default document.body. */
  root?: HTMLElement;
  /** Seconds without a press before a hint may appear. Default 1.5. */
  quiet?: number;
}

export interface AppHints {
  /** Call once per frame. @param dt seconds */
  update(dt: number): void;
  /** Retire a hint by hand, for a gesture this file cannot see. */
  learn(id: string): void;
  dispose(): void;
}

export function mountAppHints(opts: AppHintsOptions): AppHints {
  const { canvas, hud } = opts;
  const doc = canvas.ownerDocument;
  const win = doc.defaultView ?? window;
  const touch = opts.touch ?? win.matchMedia?.('(pointer: coarse)').matches ?? false;
  const quiet = opts.quiet ?? 1.5;

  const learned = new Set(loadMemory().learned);
  if (hud?.rolled) learned.add(ROLL_HINT.id);
  const scheduler = new HintScheduler(APP_HINTS, { learned });
  const view = createHintView(opts.root ?? doc.body, { touch });

  const learn = (id: string): void => {
    if (!scheduler.learn(id)) return;
    const m = loadMemory(); // re-read: the opening keeps its visit count in the same record
    saveMemory({ ...m, learned: [...new Set([...m.learned, id])] });
  };

  // Same hold delays and the same sheet test as the pointer forces in
  // engine-brushes.ts, so a press is classified the same way by both. A hold
  // counts once it has settled: one called off was a camera drag.
  const core = new GestureCore({
    onOrbit: () => learn('orbit'),
    onZoom: () => learn('zoom'),
    canHold: opts.canHold,
    onHoldSettle: () => learn('hold'),
    onDoubleTap: () => learn('focus'),
  }, { holdSecondary: GESTURE_DEFAULTS.holdMouse });

  let sincePress = 0;
  const sample = (e: PointerEvent): PointerSample => ({
    id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType,
    button: e.button, shift: e.shiftKey, alt: e.altKey,
  });
  const onDown = (e: PointerEvent) => { sincePress = 0; core.down(sample(e), e.timeStamp); };
  const onMove = (e: PointerEvent) => { if (core.pointers.has(e.pointerId)) core.move(sample(e), e.timeStamp); };
  const onUp = (e: PointerEvent) => core.up(sample(e), e.timeStamp);
  const onCancel = (e: PointerEvent) => core.cancel({ id: e.pointerId });
  const onWheel = () => { sincePress = 0; learn('zoom'); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  const offRoll = hud?.onRandomize(() => learn(ROLL_HINT.id));

  let shown: string | null = null;
  const show = (id: string | null): void => {
    if (id === shown) return;
    if (shown === ROLL_HINT.id) hud?.hintDice(false);
    if (id === ROLL_HINT.id) hud?.hintDice(true);
    shown = id;
  };

  return {
    learn,
    update(dt) {
      core.tick(win.performance.now());
      sincePress = core.pointers.size > 0 ? 0 : sincePress + dt;
      const eligible =
        sincePress >= quiet && !opts.isOpening?.() && !hud?.panelOpen && !hud?.busy;
      const hint = scheduler.update(dt, eligible);
      show(hint?.id ?? null);
      view.show(hint && hint.id !== ROLL_HINT.id ? hint : null);
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('wheel', onWheel);
      offRoll?.();
      show(null);
      view.dispose();
    },
  };
}

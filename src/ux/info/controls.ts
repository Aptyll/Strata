/**
 * Every control that is not a HUD shortcut, as data: what the pointer does and
 * which keys fly the camera. The HUD's keys sheet (?) lists only the shortcuts
 * registered with it, so without this a visitor could not look up how to turn,
 * pan, dive, face a sheet or push particles around.
 *
 * These rows describe code that lives elsewhere. Keep them true to it:
 *   pointer    src/ux/camera/input.ts (turn, pan, zoom, trackpad scroll, double click on a sheet or on empty space)
 *              src/ux/experience/gestures.ts (hold to pull, right button / Shift / Alt to push)
 *   keys       src/ux/camera/input.ts (MOVE_KEYS and the switch below it), minus
 *              the keys the HUD owns in the app (KEYS in src/app/keys.ts)
 */

export interface ControlRow {
  /** What the person does, as shown in the left column. */
  input: string;
  /** What happens. */
  does: string;
}

/** With a mouse, trackpad or pen. */
export const POINTER_CONTROLS: readonly ControlRow[] = [
  { input: "drag", does: "turn" },
  { input: "right drag, or shift + drag", does: "pan" },
  { input: "alt + drag", does: "look around in place" },
  { input: "wheel or pinch", does: "dive in and out" },
  { input: "two fingers on a trackpad", does: "turn, with shift pan" },
  { input: "double-click a sheet", does: "fly to it and face it" },
  { input: "double-click empty space", does: "fly home" },
  { input: "hold still on a sheet", does: "pull its particles" },
  { input: "hold with right button, shift or alt", does: "push them away" },
];

/** On a touch screen. */
export const TOUCH_CONTROLS: readonly ControlRow[] = [
  { input: "drag", does: "turn" },
  { input: "drag with two fingers", does: "pan" },
  { input: "pinch", does: "dive in and out" },
  { input: "double-tap a sheet", does: "fly to it and face it" },
  { input: "double-tap empty space", does: "fly home" },
  { input: "press and hold on a sheet", does: "pull its particles" },
];

/** Keys the camera answers to in the app. */
export const CAMERA_KEYS: readonly ControlRow[] = [
  { input: "w a s d, arrows", does: "fly" },
  { input: "q e", does: "down, up" },
  { input: "shift", does: "fly faster" },
  { input: ", .", does: "previous, next sheet" },
  { input: "home", does: "fly home" },
  { input: "space", does: "stop or start the idle drift" },
];

export interface ControlSection {
  title: string;
  rows: readonly ControlRow[];
}

/** The sections to show for this device. A touch screen has no camera keys worth listing. */
export const controlSections = (touch: boolean): ControlSection[] =>
  touch
    ? [{ title: "touch", rows: TOUCH_CONTROLS }]
    : [
        { title: "pointer", rows: POINTER_CONTROLS },
        { title: "camera keys", rows: CAMERA_KEYS },
      ];

/**
 * Every key the app answers to, and the one module that owns it.
 *
 * The HUD (src/ux/hud) listens on the window and matches KeyboardEvent.key.
 * The camera (src/ux/camera/input.ts) matches KeyboardEvent.code, and it
 * listens on a detached element instead of the window: the router below
 * forwards it every key that no other module owns. So to give a key to the
 * HUD or a feature, add a row to KEYS and register it from that row; the
 * camera stops seeing it automatically.
 *
 * A key the focused element uses stays with it: typing in a field, arrows and
 * Home or End on a slider, Space or Enter on a button or switch.
 *
 * Camera keys (owned by src/ux/camera/input.ts, everything not in KEYS):
 *   W A S D, arrows, Q E   fly          Shift   faster
 *   , .                    previous / next plane
 *   Home                   fly home     Space   toggle idle drift
 * The camera also binds F (nearest plane) and H (home), but in the app the
 * HUD owns those two; G and Home do the same camera moves.
 */
import type { ShortcutSpec } from "../ux/hud/index.js";

export type KeyOwner =
  | "hud" // built into the HUD (src/ux/hud/index.js); listed here, registered there
  | "app" // registered from these rows by src/app/hud.ts
  | "capture" // registered by src/capture/app.ts with the rows main.ts passes in
  | "theme" // src/ux/theme/index.ts registers it itself; keep the row in sync
  | "autocam" // src/ux/autocam/index.ts registers the row main.ts passes in
  | "panels" // src/ui/index.ts, only while a src/ui/*.panel.ts exists
  | "sound"; // src/audio/app.ts registers the row main.ts passes in

export interface KeyBinding {
  /** KeyboardEvent.key, as the HUD names it: "g", "]", "escape", "?". */
  key: string;
  /** KeyboardEvent.code of the same key on a US layout. The camera never sees it. */
  code: string;
  owner: KeyOwner;
  /** Shown in the HUD's keys sheet (?). */
  label: string;
}

export const KEYS = {
  randomize: { key: "r", code: "KeyR", owner: "hud", label: "randomize" },
  stats: { key: "h", code: "KeyH", owner: "hud", label: "stats" },
  settings: { key: "escape", code: "Escape", owner: "hud", label: "settings" },
  fullscreen: { key: "f", code: "KeyF", owner: "hud", label: "fullscreen" },
  help: { key: "?", code: "Slash", owner: "hud", label: "keys" },

  moreParticles: { key: "]", code: "BracketRight", owner: "app", label: "double particles" },
  fewerParticles: { key: "[", code: "BracketLeft", owner: "app", label: "halve particles" },
  brighter: { key: "=", code: "Equal", owner: "app", label: "brighter" },
  dimmer: { key: "-", code: "Minus", owner: "app", label: "dimmer" },
  nearestPlane: { key: "g", code: "KeyG", owner: "app", label: "go to nearest plane" },

  screenshot: { key: "p", code: "KeyP", owner: "capture", label: "screenshot" },
  record: { key: "v", code: "KeyV", owner: "capture", label: "record video" },

  nextTheme: { key: "t", code: "KeyT", owner: "theme", label: "next color theme" },

  autoCamera: { key: "c", code: "KeyC", owner: "autocam", label: "auto camera tour" },

  sound: { key: "m", code: "KeyM", owner: "sound", label: "sound on or off" },

  panels: { key: "tab", code: "Tab", owner: "panels", label: "panels" },
} as const satisfies Record<string, KeyBinding>;

/** A HUD shortcut for one row of KEYS. */
export const shortcut = (binding: KeyBinding, run: ShortcutSpec["run"]): ShortcutSpec => ({
  key: binding.key,
  label: binding.label,
  run,
});

/** KeyboardEvent.code values some module other than the camera owns. */
const OWNED = new Set<string>(Object.values(KEYS).map((k) => k.code));

/** Keys a focused slider uses itself: one step, or a jump to either end. */
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
/** Keys that press a focused button, switch or checkbox. */
const PRESS_KEYS = new Set(["Space", "Enter", "NumpadEnter"]);
/** Elements those keys press. A focused panel or dialog is not one, so Space still reaches the camera. */
const PRESSABLE =
  "button, a[href], summary, input[type=checkbox], [role=button], [role=switch], [role=checkbox], [role=tab], [role=menuitem]";

/**
 * True when the focused element takes this key press itself, so the camera
 * must not act on it as well. With nothing focused (the page or the canvas),
 * every key not in KEYS is the camera's.
 */
function keptByFocus(e: KeyboardEvent): boolean {
  // Its own handler used it already: a HUD slider steps on the arrows and cancels the default.
  if (e.defaultPrevented) return true;
  const t = e.target as HTMLElement | null;
  const tag = t?.tagName;
  if (!t || !tag) return false;
  // Typing in a field must not fly the camera.
  if (t.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    if (type === "range") return SLIDER_KEYS.has(e.code);
    if (type !== "checkbox") return true;
  }
  // Space and Enter press the focused control: Tab to the die, Space rolls it.
  // Letters and the other arrows still fly the camera from a button or a slider.
  return PRESS_KEYS.has(e.code) && t.matches(PRESSABLE);
}

export interface KeyRouter {
  /** Pass as `keyTarget` to attachCameraInput. */
  cameraTarget: HTMLElement;
  dispose(): void;
}

export function createKeyRouter(source: Window = window): KeyRouter {
  const cameraTarget = document.createElement("div");

  const forward = (e: KeyboardEvent) => {
    if (OWNED.has(e.code)) return;
    // Key-ups always go through, so the camera is never left holding a key whose
    // release happened while focus sat in a field.
    if (e.type === "keydown" && keptByFocus(e)) return;

    const copy = new KeyboardEvent(e.type, {
      key: e.key, code: e.code, repeat: e.repeat, cancelable: true,
      shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey,
    });
    cameraTarget.dispatchEvent(copy);
    if (copy.defaultPrevented) e.preventDefault();
  };

  source.addEventListener("keydown", forward);
  source.addEventListener("keyup", forward);
  return {
    cameraTarget,
    dispose() {
      source.removeEventListener("keydown", forward);
      source.removeEventListener("keyup", forward);
    },
  };
}

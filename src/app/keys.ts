/**
 * One place that decides which module owns which key, so modules written in
 * parallel do not both react to the same press.
 *
 *   HUD     R dice, H stats, Esc settings, F fullscreen, ? keys, plus the app
 *           shortcuts registered in main.ts ([ ] - = G P V)
 *   camera  WASD / arrows / Q E / Shift to fly, , . previous and next plane,
 *           Home to fly home, Space to toggle idle drift
 *
 * The camera input module listens on a key target. Instead of the window it
 * gets a detached element that only receives the keys the camera owns.
 */

/** KeyboardEvent.code values the HUD and app shortcuts own; the camera never sees them. */
const RESERVED = new Set(["KeyH", "Escape", "KeyF", "KeyR", "KeyG", "BracketLeft", "BracketRight", "Minus", "Equal", "KeyP", "KeyV"]);

export interface KeyRouter {
  /** Pass as `keyTarget` to attachCameraInput. */
  cameraTarget: HTMLElement;
  dispose(): void;
}

export function createKeyRouter(source: Window = window): KeyRouter {
  const cameraTarget = document.createElement("div");

  const forward = (e: KeyboardEvent) => {
    if (RESERVED.has(e.code)) return;
    // Typing in a settings field must not fly the camera. Sliders and switches are fine.
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (t?.isContentEditable || tag === "TEXTAREA" || tag === "SELECT") return;
    if (tag === "INPUT" && !["range", "checkbox"].includes((t as HTMLInputElement).type)) return;

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

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
  | "info" // src/ux/info/index.ts registers the row src/app/hud.ts passes in
  | "panels"; // src/ui/index.ts, only while a src/ui/*.panel.ts exists

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
  nearestPlane: { key: "g", code: "KeyG", owner: "app", label: "go to nearest sheet" },

  screenshot: { key: "p", code: "KeyP", owner: "capture", label: "screenshot" },
  record: { key: "v", code: "KeyV", owner: "capture", label: "record video" },

  nextTheme: { key: "t", code: "KeyT", owner: "theme", label: "next color theme" },

  autoCamera: { key: "c", code: "KeyC", owner: "autocam", label: "auto camera tour" },

  about: { key: "i", code: "KeyI", owner: "info", label: "what is this" },

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

export interface KeyRouter {
  /** Pass as `keyTarget` to attachCameraInput. */
  cameraTarget: HTMLElement;
  dispose(): void;
}

export function createKeyRouter(source: Window = window): KeyRouter {
  const cameraTarget = document.createElement("div");

  const forward = (e: KeyboardEvent) => {
    if (OWNED.has(e.code)) return;
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

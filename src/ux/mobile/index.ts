/**
 * Phones and tablets: a particle budget that fits the device, and a tap target
 * for the settings menu (phones have no Esc key).
 *
 * Touch camera gestures already live in src/ux/camera/input.ts: one finger
 * orbits, two fingers pinch to zoom and drag to pan, double tap focuses a plane.
 * This module adds only what a touch screen is missing.
 */
import type { AppOptions } from "../../app/options";

/** True on a device whose main pointer is a finger (phones, most tablets). */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse || ((navigator.maxTouchPoints ?? 0) > 1 && !window.matchMedia?.("(pointer: fine)").matches);
}

/**
 * Particle capacity a touch device can carry. A guess from what the browser
 * reports (memory in GB, CPU cores, screen pixels); phones vary wildly, so the
 * adaptive budget is switched on too and thins planes to hold the frame rate.
 */
export function mobileParticleCap(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = nav.deviceMemory ?? 4; // Safari does not report it
  const cores = nav.hardwareConcurrency ?? 4;
  const pixels = screen.width * screen.height * (window.devicePixelRatio || 1) ** 2;
  let cap = 1_000_000;
  if (memory >= 8 && cores >= 8) cap = 2_000_000;
  else if (memory <= 2 || cores <= 4) cap = 400_000;
  // Very large screens on modest hardware spend their time on fill, not particles.
  if (pixels > 4_000_000 && cap > 400_000) cap = Math.round(cap * 0.75);
  return cap;
}

/**
 * Lower the particle count on touch devices unless the URL set one, and turn on
 * the adaptive budget unless the URL said otherwise. Desktop options pass through.
 */
export function applyMobileBudget(options: AppOptions, search: string): AppOptions {
  if (!isTouchDevice()) return options;
  const query = new URLSearchParams(search);
  return {
    ...options,
    particles: query.has("particles") ? options.particles : Math.min(options.particles, mobileParticleCap()),
    adaptive: query.has("adaptive") ? options.adaptive : true,
  };
}

export interface MobileHud {
  togglePanel(): void;
}

/**
 * Add a round tap target (bottom right, 48 px, safe-area aware) that opens and
 * closes the settings menu, like Esc. Only on touch devices; returns a remover.
 */
export function mountMobileControls(hud: MobileHud, parent: HTMLElement = document.body): () => void {
  if (!isTouchDevice()) return () => {};
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Settings");
  button.textContent = "☰"; // trigram, reads as a menu
  Object.assign(button.style, {
    position: "fixed",
    right: "calc(16px + env(safe-area-inset-right, 0px))",
    bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
    width: "48px",
    height: "48px",
    borderRadius: "24px",
    border: "1px solid rgba(255,255,255,0.25)",
    background: "rgba(0,0,0,0.45)",
    color: "rgba(255,255,255,0.85)",
    font: "20px/1 system-ui, sans-serif",
    zIndex: "20",
    touchAction: "manipulation",
    userSelect: "none",
    webkitTapHighlightColor: "transparent",
  } as Partial<CSSStyleDeclaration>);
  // Keep taps on the button from reaching the camera underneath.
  const stop = (e: Event) => e.stopPropagation();
  button.addEventListener("pointerdown", stop);
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    hud.togglePanel();
  });
  parent.appendChild(button);

  // Stop the page itself from scrolling, bouncing or zooming under the fingers.
  const root = document.documentElement.style;
  const prev = { overscroll: root.overscrollBehavior, touch: document.body.style.touchAction };
  root.overscrollBehavior = "none";
  document.body.style.touchAction = "none";

  return () => {
    button.remove();
    root.overscrollBehavior = prev.overscroll;
    document.body.style.touchAction = prev.touch;
  };
}

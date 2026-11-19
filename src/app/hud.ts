/**
 * The app's HUD: mounts the shared HUD (src/ux/hud/wire.ts gives it the dice,
 * stats line, particle and brightness sliders and behavior params) and the
 * color themes (src/ux/theme: a "theme" menu section and T), then adds what
 * only the app knows about:
 *
 *   menu      planes, rasterizer, look (bloom, trails, white point, pointer
 *             parallax, plane crossings), performance (hold frame rate,
 *             target fps, challenge)
 *   stats     "total": particle capacity across every plane
 *   keys      ] [ particles, = - brightness, G nearest plane (rows in ./keys.ts)
 *
 * Capture adds its own "capture" section and keys (src/capture/app.ts).
 * Registration order is menu order, so keep new entries at the end of their group.
 */
import type { AppContext } from "../core/contracts";
import type { ParallaxCamera } from "../depth";
import type { DensitySettings } from "../render";
import type { EngineCamera } from "../ux/camera";
import { formatCount, type Hud } from "../ux/hud/index.js";
import { mountHud } from "../ux/hud/wire";
import { mountThemes } from "../ux/theme";
import type { BudgetChoice } from "./budget";
import type { RenderGraph } from "./graph";
import { RASTERIZERS } from "./graph";
import { KEYS, shortcut } from "./keys";
import type { SceneHost } from "./scene";

/** Ends of the particle count slider and of the ] [ keys. */
export const MIN_PARTICLES = 10_000;
export const MAX_PARTICLES = 200_000_000;

export interface AppHudDeps {
  app: AppContext;
  /** The canvas the color theme filter applies to. */
  canvas: HTMLCanvasElement;
  scenes: SceneHost;
  render: RenderGraph;
  budget: BudgetChoice;
  camera: EngineCamera;
  /** The parallax wrapper around `camera` that the frame is drawn through. */
  view: ParallaxCamera;
}

export interface AppHud {
  hud: Hud;
  /** Call once per frame: advances a dice roll in flight and refreshes the stats. */
  update(dt: number): void;
}

export function mountAppHud({ app, canvas, scenes, render, budget, camera, view }: AppHudDeps): AppHud {
  const { hud, update } = mountHud(app, {
    hud: { autoFps: false },
    minParticles: MIN_PARTICLES,
    maxParticles: MAX_PARTICLES,
    // Particles stay where they are and start obeying the new rule, instead of a hard cut.
    transition: { swapBehavior: (plane, target) => render.sim.setBehavior(plane, target) },
  });
  hud.defineStat("total", { label: "total", format: formatCount });
  mountThemes(hud, canvas); // color themes: Esc menu, T to cycle, ?theme=red

  registerMenu(hud, { scenes, render, budget, view });
  registerKeys(hud, { scenes, camera });

  return {
    hud,
    update(dt) {
      update(dt);
      hud.setStat("total", scenes.total);
    },
  };
}

function registerMenu(
  hud: Hud,
  { scenes, render, budget, view }: Pick<AppHudDeps, "scenes" | "render" | "budget" | "view">,
): void {
  hud.registerParam({
    id: "planes", type: "range", live: false, persist: false, min: 1, max: 256, step: 1, value: scenes.planeCount,
    onChange: (v) => {
      scenes.planeCount = Math.round(v);
      scenes.rebuild();
    },
  });
  hud.registerParam({
    id: "rasterizer", type: "select", group: "performance",
    value: render.rasterizer.current(),
    options: RASTERIZERS.map((r) => ({ value: r.pass, label: r.label })),
    onChange: render.rasterizer.set,
  });

  // The tonemap pass (src/passes/tonemap.pass.ts) publishes its density look settings when it is in use.
  const look = (globalThis as { strataLook?: DensitySettings }).strataLook;
  if (look) {
    hud.registerParam({
      id: "bloom", type: "toggle", group: "look", value: look.bloom.enabled,
      onChange: (on) => (look.bloom.enabled = on),
    });
    hud.registerParam({
      id: "trails", type: "toggle", group: "look", value: look.trails.enabled,
      onChange: (on) => (look.trails.enabled = on),
    });
    hud.registerParam({
      id: "white", label: "white point", type: "range", scale: "log", group: "look", min: 1, max: 100_000,
      value: look.tone.white, onChange: (v) => (look.tone.white = v),
    });
  }
  hud.registerParam({
    id: "parallax", label: "pointer parallax", type: "toggle", group: "look",
    value: view.parallax.enabled, onChange: (on) => (view.parallax.enabled = on),
  });
  hud.registerParam({
    id: "interplane", label: "plane crossings", type: "toggle", group: "look",
    value: render.interplane.enabled, onChange: render.interplane.set,
  });

  hud.registerParam({
    id: "adaptive", label: "hold frame rate", type: "toggle", group: "performance", value: budget.useAdaptive,
    onChange: (on) => (budget.useAdaptive = on),
  });
  hud.registerParam({
    id: "targetFps", label: "target fps", type: "range", group: "performance", min: 24, max: 240, step: 1,
    value: budget.targetFps, onChange: (v) => (budget.targetFps = v),
  });
  // Challenge mode is its own page state (?challenge): how many particles can this GPU hold?
  hud.registerParam({
    id: "challenge", label: "particle challenge", type: "action", group: "performance",
    run: () => {
      const url = new URL(location.href);
      url.searchParams.set("challenge", "");
      location.assign(url);
    },
  });
}

function registerKeys(hud: Hud, { scenes, camera }: Pick<AppHudDeps, "scenes" | "camera">): void {
  // The HUD owns the particles and brightness sliders; the keys just move them.
  const scaleParticles = (factor: number) =>
    hud.setParam("particles", Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, scenes.total * factor)));
  const scaleBrightness = (factor: number) => hud.setParam("brightness", scenes.current.render.brightness * factor);
  hud.registerShortcut(shortcut(KEYS.moreParticles, () => scaleParticles(2)));
  hud.registerShortcut(shortcut(KEYS.fewerParticles, () => scaleParticles(0.5)));
  hud.registerShortcut(shortcut(KEYS.brighter, () => scaleBrightness(1.25)));
  hud.registerShortcut(shortcut(KEYS.dimmer, () => scaleBrightness(0.8)));
  hud.registerShortcut(shortcut(KEYS.nearestPlane, () => camera.rig.focusNearest()));
}

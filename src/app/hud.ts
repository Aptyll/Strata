/**
 * The app's HUD: mounts the shared HUD (src/ux/hud/wire.ts gives it the dice,
 * stats line, particle and brightness sliders and behavior params) and the
 * color themes (src/ux/theme: a "theme" menu section and T), then adds what
 * only the app knows about:
 *
 *   menu      planes, render (which rasterizer), look (bloom, trails, white
 *             point, contrast, pointer parallax, plane crossings), performance
 *             (hold frame rate, target fps, challenge)
 *   stats     "total": every particle in the world, shown (and the HUD's own
 *             count named "active") only while the budget pauses some sheets
 *   keys      ] [ particles, = - brightness, G nearest plane (rows in ./keys.ts)
 *
 * With ?world the planes and particles sliders and ] [ are left out: the
 * streamer sizes that world. Options the URL sets explicitly (?raster,
 * ?parallax, ?interplane, ?adaptive, ?fps) are not overridden by saved settings.
 *
 * Capture adds its own "capture" section and keys (src/capture/app.ts).
 * Registration order is menu order, so keep new entries at the end of their group.
 */
import type { AppContext } from "../core/contracts";
import type { ParallaxCamera } from "../depth";
import type { DensitySettings } from "../render";
import type { EngineCamera } from "../ux/camera";
import { formatCount, formatExact, type Hud } from "../ux/hud/index.js";
import { mountHud } from "../ux/hud/wire";
import { mountThemes } from "../ux/theme";
import type { BudgetChoice } from "./budget";
import type { RenderGraph } from "./graph";
import { RASTERIZERS } from "./graph";
import { KEYS, shortcut } from "./keys";
import type { AppOptions } from "./options";
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
  /** What the URL asked for: explicit options outrank saved menu settings, and ?world changes the menu. */
  options: AppOptions;
}

export interface AppHud {
  hud: Hud;
  /** Call once per frame: advances a dice roll in flight and refreshes the stats. */
  update(dt: number): void;
}

export function mountAppHud({ app, canvas, scenes, render, budget, camera, view, options }: AppHudDeps): AppHud {
  const { hud, update } = mountHud(app, {
    // The die's breathing hint is scheduled with the gesture hints (src/ux/experience/app-hints.ts).
    hud: { autoFps: false, diceHintMs: 0 },
    // A streamed world sizes itself (its streamer holds the particle budget), so there is no count to scale.
    particles: options.world === null,
    minParticles: MIN_PARTICLES,
    maxParticles: MAX_PARTICLES,
    // Particles stay where they are and start obeying the new rule, instead of a hard cut.
    transition: { swapBehavior: (plane, target) => render.sim.setBehavior(plane, target) },
  });
  hud.defineStat("total", { label: "total", format: formatCount });
  mountThemes(hud, canvas); // color themes: Esc menu, T to cycle, ?theme=red

  registerMenu(hud, { scenes, render, budget, view, options });
  registerKeys(hud, { scenes, camera, options });

  // The HUD's own count ("particles", from app.stats()) is what is being stepped;
  // "total" is every particle in the world. They differ only while the budget
  // pauses sheets, so show one number when they read the same, and otherwise
  // "1.20M active  2.00M total".
  let split: boolean | undefined;
  const refreshCounts = () => {
    const active = app.stats().particles;
    const total = scenes.total;
    const nowSplit = formatCount(active) !== formatCount(total);
    if (nowSplit !== split) {
      split = nowSplit;
      // Redefining a stat resets it, so repeat the HUD's own format and tooltip.
      hud.defineStat("particles", {
        label: split ? "active" : "",
        format: formatCount,
        title: (v) => `${formatExact(v)} ${split ? "active " : ""}particles`,
      });
      hud.setStat("particles", active); // the label and the number change together
    }
    hud.setStat("total", split ? total : null);
  };

  return {
    hud,
    update(dt) {
      update(dt);
      refreshCounts();
    },
  };
}

function registerMenu(
  hud: Hud,
  { scenes, render, budget, view, options }: Pick<AppHudDeps, "scenes" | "render" | "budget" | "view" | "options">,
): void {
  // A setting the URL gave explicitly holds for this visit: the saved choice is neither restored over it
  // nor overwritten by it, so ?raster=points or ?adaptive=1 work after the menu was ever touched.
  const saved = (option: keyof AppOptions) => !options.fromUrl.has(option);

  // A streamed world (?world) has no generated layout to rebuild: a rebuild would put the fixed layout
  // into it and move the camera.
  if (options.world === null) {
    hud.registerParam({
      id: "planes", type: "range", live: false, persist: false, min: 1, max: 256, step: 1, value: scenes.planeCount,
      onChange: (v) => {
        scenes.planeCount = Math.round(v);
        scenes.rebuild();
        // Keep the link true to the screen: it carries the plane count, and the rebuilt layout has no roll in it.
        const url = new URL(location.href);
        url.searchParams.set("planes", String(scenes.planeCount));
        url.hash = "";
        history.replaceState(history.state, "", url);
      },
    });
  }
  hud.registerParam({
    // Keep the label short: the select is as wide as its longest option, up to the
    // HUD's 150px cap, which leaves room for about nine characters (changed dot included).
    id: "rasterizer", label: "render", type: "select", group: "performance", persist: saved("raster"),
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
    // Power on the tone curve's output. 1 is the default look; about 2.2 undoes the second
    // brightening that the sRGB encode adds on top of the log curve
    // (docs/briefs/visual/V02-tone-curve-lifts-mid-greys.md).
    hud.registerParam({
      id: "contrast", type: "range", group: "look", min: 1, max: 3, step: 0.1,
      value: look.tone.contrast ?? 1, onChange: (v) => (look.tone.contrast = v),
    });
  }
  hud.registerParam({
    id: "parallax", label: "pointer parallax", type: "toggle", group: "look", persist: saved("parallax"),
    value: view.parallax.enabled, onChange: (on) => (view.parallax.enabled = on),
  });
  hud.registerParam({
    id: "interplane", label: "plane crossings", type: "toggle", group: "look", persist: saved("interplane"),
    value: render.interplane.enabled, onChange: render.interplane.set,
  });

  hud.registerParam({
    id: "adaptive", label: "hold frame rate", type: "toggle", group: "performance", persist: saved("adaptive"),
    value: budget.useAdaptive, onChange: (on) => (budget.useAdaptive = on),
  });
  hud.registerParam({
    id: "targetFps", label: "target fps", type: "range", group: "performance", min: 24, max: 240, step: 1,
    persist: saved("fps"), value: budget.targetFps, onChange: (v) => (budget.targetFps = v),
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

function registerKeys(hud: Hud, { scenes, camera, options }: Pick<AppHudDeps, "scenes" | "camera" | "options">): void {
  // The HUD owns the particles and brightness sliders; the keys just move them.
  const scaleParticles = (factor: number) =>
    hud.setParam("particles", Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, scenes.total * factor)));
  const scaleBrightness = (factor: number) => hud.setParam("brightness", scenes.current.render.brightness * factor);
  // A streamed world has no particles slider (see mountAppHud), so ] and [ would do nothing there.
  if (options.world === null) {
    hud.registerShortcut(shortcut(KEYS.moreParticles, () => scaleParticles(2)));
    hud.registerShortcut(shortcut(KEYS.fewerParticles, () => scaleParticles(0.5)));
  }
  hud.registerShortcut(shortcut(KEYS.brighter, () => scaleBrightness(1.25)));
  hud.registerShortcut(shortcut(KEYS.dimmer, () => scaleBrightness(0.8)));
  hud.registerShortcut(shortcut(KEYS.nearestPlane, () => camera.rig.focusNearest()));
}

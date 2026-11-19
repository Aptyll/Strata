// Glue between the HUD and the engine. The HUD itself (index.js) knows nothing
// about Strata; this file is the one place that does, and it talks to the
// engine only through AppContext.
//
//   const ui = mountHud(app);
//   // in the frame loop:
//   ui.update(dt);

import { TOKENS, type AppContext, type Behavior, type PlaneInstance } from "../../core/contracts";
import { rollScene, startRoll, type RollOptions, type RollTransition, type RollTransitionOptions } from "../behavior-ui/roll";
import { createHud, type Hud, type HudOptions } from "./index.js";

export interface MountHudOptions {
  hud?: HudOptions;
  /** Passed to rollScene: param ranges, excluded behaviors. */
  roll?: RollOptions;
  /** Passed to startRoll: timing, and swapBehavior once the engine has it. */
  transition?: RollTransitionOptions;
  /** Seconds between stat and menu refreshes. Default 0.25. */
  statsInterval?: number;
  /** Ends of the particle count slider. Defaults 10 thousand and 16 million. */
  minParticles?: number;
  maxParticles?: number;
  /** How many behaviors get a section of sliders, most used first. Default 3. */
  maxBehaviorGroups?: number;
}

export interface MountedHud {
  hud: Hud;
  /** Call once per frame with the frame's dt in seconds. Advances a roll in flight and refreshes stats. */
  update(dt: number): void;
  destroy(): void;
}

const PARTICLES = "particles";
const BRIGHTNESS = "brightness";

/**
 * Create the HUD, bind it to the shared tokens, and connect it to the engine:
 * the dice starts a roll, the stats line shows app.stats(), and the settings
 * menu gets a particle count slider, a brightness slider (when the engine
 * offers setRender) and one slider per param of the behaviors in the world.
 */
export function mountHud(app: AppContext, opts: MountHudOptions = {}): MountedHud {
  // Scene state lives in the engine, so only the HUD's own preferences are persisted, not these params.
  const hud = createHud({ tokens: TOKENS, ...opts.hud });
  const interval = opts.statsInterval ?? 0.25;
  const maxGroups = opts.maxBehaviorGroups ?? 3;
  let roll: RollTransition | null = null;
  let sinceRefresh = interval; // refresh on the first frame

  const labelOf = (b: Behavior) => b.label ?? b.id;
  const planesOf = (behaviorId: string) => app.planes.filter((p) => p.behavior.id === behaviorId);
  const paramOf = (plane: PlaneInstance, name: string) => plane.desc.params?.[name] ?? plane.behavior.params[name].default;
  const capacity = () => app.planes.reduce((n, p) => n + p.capacity, 0);

  // ---- particle count: rebuild the world with every plane scaled -------------
  const minParticles = opts.minParticles ?? 10_000;
  const maxParticles = Math.max(opts.maxParticles ?? 16_000_000, capacity());
  hud.registerParam({
    id: PARTICLES, label: "particles", min: minParticles, max: maxParticles, step: 1000, scale: "log",
    value: capacity(), live: false, persist: false,
    onChange: (wanted: number) => {
      const scene = app.getScene();
      const total = scene.planes.reduce((n, p) => n + p.particleCount, 0);
      if (!total) return;
      roll = null; // the planes a roll in flight was steering are about to be replaced
      const factor = wanted / total;
      app.loadScene({
        ...scene,
        planes: scene.planes.map((p) => ({ ...p, particleCount: Math.max(1, Math.round(p.particleCount * factor)) })),
      });
    },
  });

  // ---- brightness: only when the engine can change it live -------------------
  if (app.setRender) {
    hud.registerParam({
      id: BRIGHTNESS, label: "brightness", min: 0.01, max: 4, step: 0, scale: "log",
      value: app.getScene().render.brightness, persist: false,
      format: (v) => v.toFixed(2),
      onChange: (brightness: number) => app.setRender?.({ brightness }),
    });
  }

  // ---- behavior params: one section per behavior in the world ----------------
  let shown: string[] = []; // param ids currently in the menu
  let signature = "";
  const leadBehaviors = (): Behavior[] => {
    const count = new Map<Behavior, number>();
    for (const p of app.planes) count.set(p.behavior, (count.get(p.behavior) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxGroups).map(([b]) => b);
  };
  const paramId = (b: Behavior, name: string) => `behavior.${b.id}.${name}`;

  const rebuildBehaviorParams = (list: Behavior[]) => {
    shown.forEach((id) => hud.removeParam(id));
    shown = [];
    for (const b of list) {
      const first = planesOf(b.id)[0];
      for (const [name, spec] of Object.entries(b.params)) {
        const id = paramId(b, name);
        shown.push(id);
        hud.registerParam({
          id, group: labelOf(b), label: spec.label ?? name, persist: false,
          min: spec.min, max: spec.max, step: spec.step, value: first ? paramOf(first, name) : spec.default,
          onChange: (v: number) => {
            roll = null; // a hand on a slider outranks a roll still gliding
            for (const plane of planesOf(b.id)) {
              plane.desc.params = { ...plane.desc.params, [name]: v };
              app.updatePlane(plane);
            }
          },
        });
      }
    }
  };

  /** Make the menu match the world: rebuild sections when the cast of behaviors changes, else just follow values. */
  const syncMenu = () => {
    const list = leadBehaviors();
    const next = list.map((b) => b.id).join("|");
    if (next !== signature) {
      signature = next;
      rebuildBehaviorParams(list);
    } else if (hud.panelOpen) {
      for (const b of list) {
        const first = planesOf(b.id)[0];
        if (first) for (const name of Object.keys(b.params)) hud.setParam(paramId(b, name), paramOf(first, name), { silent: true });
      }
    }
    if (hud.panelOpen) hud.setParam(PARTICLES, capacity(), { silent: true });
    hud.setStat("behavior", list.length ? labelOf(list[0]) : null);
  };
  syncMenu();

  // ---- dice ---------------------------------------------------------------------
  hud.onRandomize(({ seed }) => {
    const target = rollScene(app.getScene(), app.behaviors, seed, opts.roll);
    // Starting a new roll mid-flight is safe: the old transition is simply dropped.
    roll = startRoll(app, target, opts.transition);
    syncMenu();
    const first = target.planes[0];
    if (!first) return;
    const lead = app.behaviors.find((b) => b.id === first.behaviorId);
    const name = lead ? labelOf(lead) : first.behaviorId;
    return target.name ? { name: target.name, detail: name } : name;
  });

  return {
    hud,
    update(dt) {
      if (roll && roll.update(dt)) roll = null;
      sinceRefresh += dt;
      if (sinceRefresh >= interval) {
        sinceRefresh = 0;
        hud.setStats(app.stats());
        syncMenu();
      }
    },
    destroy() {
      roll = null;
      hud.destroy();
    },
  };
}

// Glue between the HUD and the engine. The HUD itself (index.js) knows nothing
// about Strata; this file is the one place that does.
//
//   const ui = mountHud(app);
//   // in the frame loop:
//   ui.update(dt);

import { TOKENS, type AppContext } from "../../core/contracts";
import { rollScene, startRoll, type RollOptions, type RollTransition, type RollTransitionOptions } from "../behavior-ui/roll";
import { createHud, type Hud, type HudOptions } from "./index.js";

export interface MountHudOptions {
  hud?: HudOptions;
  /** Passed to rollScene: param ranges, excluded behaviors. */
  roll?: RollOptions;
  /** Passed to startRoll: timing, and swapBehavior once the engine has it. */
  transition?: RollTransitionOptions;
  /** Seconds between stat refreshes. Default 0.25. */
  statsInterval?: number;
}

export interface MountedHud {
  hud: Hud;
  /** Call once per frame with the frame's dt in seconds. Advances a roll in flight and refreshes stats. */
  update(dt: number): void;
  destroy(): void;
}

/** Create the HUD, bind it to the shared tokens, and hook the dice to rollScene/startRoll. */
export function mountHud(app: AppContext, opts: MountHudOptions = {}): MountedHud {
  const hud = createHud({ tokens: TOKENS, ...opts.hud });
  const interval = opts.statsInterval ?? 0.25;
  let roll: RollTransition | null = null;
  let sinceStats = interval; // refresh on the first frame

  const label = (behaviorId: string) => app.behaviors.find((b) => b.id === behaviorId)?.label ?? behaviorId;

  hud.onRandomize(({ seed }) => {
    const target = rollScene(app.getScene(), app.behaviors, seed, opts.roll);
    // Starting a new roll mid-flight is safe: the old transition is simply dropped.
    roll = startRoll(app, target, opts.transition);
    const first = target.planes[0];
    if (!first) return;
    // Name the new world after its lead behavior. No name is announced for an unnamed scene with one plane.
    const lead = label(first.behaviorId);
    hud.setStat("behavior", lead);
    return target.name ? { name: target.name, detail: lead } : lead;
  });

  return {
    hud,
    update(dt) {
      if (roll && roll.update(dt)) roll = null;
      sinceStats += dt;
      if (sinceStats >= interval) {
        sinceStats = 0;
        hud.setStats(app.stats());
      }
    },
    destroy() {
      roll = null;
      hud.destroy();
    },
  };
}

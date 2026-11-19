/**
 * Which ParticleBudget decides how many particles each plane draws, frame by
 * frame. Two are on offer:
 *
 *   full      every plane in view at full capacity (src/core/budget.ts)
 *   adaptive  thins planes to hold a target frame rate (src/perf/budget.ts)
 *
 * The "hold frame rate" and "target fps" settings change the choice; the
 * frame loop asks for the budget once per frame.
 */
import { VisibleOnlyBudget } from "../core/budget";
import type { ParticleBudget } from "../core/contracts";
import { PerfBudget } from "../perf/budget";

export interface BudgetChoice {
  readonly full: VisibleOnlyBudget;
  readonly adaptive: PerfBudget;
  /** True when the adaptive budget is in charge of realtime frames. */
  useAdaptive: boolean;
  /** Frame rate the adaptive budget aims for. */
  targetFps: number;
  /** The budget for one frame. Offline renders are not in a hurry, so they always draw every particle. */
  forFrame(offline: boolean): ParticleBudget;
}

export function createBudgetChoice(options: { adaptive: boolean; fps: number }): BudgetChoice {
  const full = new VisibleOnlyBudget();
  const adaptive = new PerfBudget();
  const choice: BudgetChoice = {
    full,
    adaptive,
    useAdaptive: options.adaptive,
    targetFps: options.fps,
    forFrame: (offline) => (!offline && choice.useAdaptive ? adaptive : full),
  };
  return choice;
}

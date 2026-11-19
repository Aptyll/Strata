/**
 * Pure decisions for recovery (no DOM, no GPU; tested in ./test):
 *
 *   planRestart   after the GPU device is lost: restart by itself or wait for
 *                 the person, and with how many particles
 *   restartUrl    the page address that restart opens
 *   RestartLog    remembers the last restart in this tab, so a GPU that keeps
 *                 failing can never put the page in a reload loop
 */

/** Lowest particle count a restart asks for. */
export const MIN_RESTART_PARTICLES = 10_000;
/** A loss this soon after boot or after a particle count change is blamed on the load. */
export const LOAD_BLAME_MS = 30_000;
/** At most one automatic restart per this long. A second loss inside it waits for the person. */
export const AUTO_RESTART_GAP_MS = 120_000;

export interface LossFacts {
  /** Particles stored on the GPU when the device was lost. */
  particles: number;
  /** Particles the page opened with: a count that did run on this GPU, at least for a while. */
  bootParticles: number;
  /** Milliseconds since boot or since the particle count last changed, whichever is later. */
  sinceLoadChangeMs: number;
  /** Milliseconds since the last restart in this tab. Null when there was none, or it cannot be remembered. */
  sinceRestartMs: number | null;
  /** False when nothing may restart by itself: the restart log cannot be written, or a long job is running. */
  mayAuto: boolean;
}

export interface RestartPlan {
  /** Restart without asking, after a short countdown the person can stop. */
  auto: boolean;
  /** Particle count to restart with, or null to reopen the page exactly as it was opened. */
  particles: number | null;
  /** The loss came right after boot or a count change, so memory or load is the likely cause. */
  blameLoad: boolean;
  /** The page already restarted itself a moment ago and the device was lost again. */
  repeat: boolean;
}

/** A count as people say it: 64000000 is "64M", 1500000 is "1.5M", 10000 is "10K". */
export function shortCount(n: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (n >= size) return `${Number((n / size).toPrecision(3))}${unit}`;
  }
  return String(Math.round(n));
}

/** Half the count, never below the floor. */
export const fewer = (particles: number): number =>
  Math.max(MIN_RESTART_PARTICLES, Math.floor(particles / 2));

export function planRestart(facts: LossFacts): RestartPlan {
  const blameLoad = facts.sinceLoadChangeMs < LOAD_BLAME_MS;
  const repeat = facts.sinceRestartMs !== null && facts.sinceRestartMs < AUTO_RESTART_GAP_MS;
  const auto = facts.mayAuto && !repeat;

  let particles: number | null = null;
  if (repeat) {
    // It already restarted once and still failed: less, whatever the timing says.
    particles = fewer(Math.min(facts.particles, facts.bootParticles));
  } else if (blameLoad && facts.particles <= facts.bootParticles) {
    // Lost at the count the page opened with (or below): that count is the suspect.
    particles = fewer(facts.particles);
  }
  // Otherwise the person raised the count past what the page opened with, or the loss had
  // nothing to do with load: reopening the page as it was gets a count that is known to run.
  return { auto, particles, blameLoad, repeat };
}

/** The address a restart opens: the same page, with `?particles=` pinned when a count is given. */
export function restartUrl(href: string, particles: number | null): string {
  const url = new URL(href);
  if (particles !== null) url.searchParams.set("particles", String(Math.round(particles)));
  return url.toString();
}

/** The part of sessionStorage the log uses. */
export type RestartStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const KEY = "strata.recovery.restart";

/** When this tab last restarted itself, kept in sessionStorage so it survives the reload. */
export class RestartLog {
  constructor(
    private readonly storage: RestartStorage | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Milliseconds since the last restart, or null when there was none (or storage is unavailable). */
  sinceLast(): number | null {
    try {
      const at = Number(this.storage?.getItem(KEY));
      return Number.isFinite(at) && at > 0 ? Math.max(0, this.now() - at) : null;
    } catch {
      return null;
    }
  }

  /** Record a restart happening now. False when it could not be written. */
  mark(): boolean {
    try {
      if (!this.storage) return false;
      this.storage.setItem(KEY, String(this.now()));
      return true;
    } catch {
      return false;
    }
  }

  /** True when a mark would be remembered across the reload. Leaves nothing behind. */
  works(): boolean {
    try {
      if (!this.storage) return false;
      const probe = KEY + ".probe";
      this.storage.setItem(probe, "1");
      const ok = this.storage.getItem(probe) === "1";
      this.storage.removeItem(probe);
      return ok;
    } catch {
      return false;
    }
  }
}

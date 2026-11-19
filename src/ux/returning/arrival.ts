/**
 * What a page load should open on. Pure: the address, the date and the
 * visitor's record go in, a decision comes out.
 *
 * The rules, in order:
 *
 *   1. The address names something (any ?option other than a color theme, or
 *      a #link this code does not know): leave everything exactly as asked.
 *      Shared links, development flags and capture runs stay deterministic.
 *   2. Someone who has never been here: the opening is theirs, untouched.
 *   3. The address holds a roll of the dice (a shared link, a bookmark, the
 *      visitor's own last roll): show that roll.
 *   4. Otherwise, the plain address: today's world (or, by product choice,
 *      the world they left, or the opening as always).
 *
 * One exception to rule 3. Opening today's world writes its roll into the
 * address like any roll, and browsers offer that address back the next day.
 * A roll that is exactly the day's world this browser opened on an earlier
 * day is therefore read as the plain address, not as a world someone picked.
 */
import { dailySeed } from "./daily";
import type { VisitorRecord } from "./store";

/** What second and later visits open on when the address is plain. */
export type OpensOn = "today" | "last" | "same";

export type Arrival =
  /** Leave the page alone: a first visit, or an address that names what it wants. */
  | { kind: "untouched"; reason: "first-visit" | "explicit-address" }
  /** Open today's world. */
  | { kind: "today"; day: string; seed: number }
  /** Reopen the world that was on screen when the page was last left. */
  | { kind: "last" }
  /** Keep what the address shows. `invite`: mention once today that today's world is waiting. */
  | { kind: "keep"; invite: boolean };

export interface ArrivalInput {
  /** location.search and location.hash. */
  search: string;
  hash: string;
  /** Today as a dayKey. */
  today: string;
  /** The visitor's record as it was before this load, or null for a first visit. */
  record: VisitorRecord | null;
  opensOn: OpensOn;
}

/** Options that change how the world looks but not which world it is. */
const LOOK_ONLY = new Set(["theme"]);

const ROLL = /[#&]r=([0-9a-z]+)/i;

/** The dice seed in a page link's hash (the #r= that src/ux/hud/wire.ts writes), or null. */
export function parseRoll(hash: string): number | null {
  const m = ROLL.exec(hash);
  if (!m) return null;
  const seed = parseInt(m[1], 36);
  return Number.isFinite(seed) ? seed >>> 0 : null;
}

/** The hash that holds a dice seed, as src/ux/hud/wire.ts writes it. */
export const rollHash = (seed: number): string => `#r=${(seed >>> 0).toString(36)}`;

/** True when the query asks for anything beyond a look. */
export function namesAWorld(search: string): boolean {
  for (const key of new URLSearchParams(search).keys()) if (!LOOK_ONLY.has(key)) return true;
  return false;
}

export function decideArrival({ search, hash, today, record, opensOn }: ArrivalInput): Arrival {
  const roll = parseRoll(hash);
  // A hash with something in it that is not a roll belongs to code this file does not know. Hands off.
  if (namesAWorld(search) || (roll === null && hash.length > 1)) return { kind: "untouched", reason: "explicit-address" };
  if (!record) return { kind: "untouched", reason: "first-visit" };

  const seenToday = record.daily?.day === today;
  const invite = !seenToday && record.invited !== today;
  if (roll !== null) {
    const staleDaily = opensOn === "today" && record.daily !== null && record.daily.seed === roll && !seenToday;
    if (!staleDaily) return { kind: "keep", invite };
  }
  if (opensOn === "today") return { kind: "today", day: today, seed: dailySeed(today) };
  if (opensOn === "last" && record.left) return { kind: "last" };
  return { kind: "keep", invite };
}

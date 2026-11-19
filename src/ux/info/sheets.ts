/**
 * Facts about the sheets in the world, read from the live planes. Pure: no DOM
 * and no GPU, only the fields of PlaneInstance that say what a sheet is.
 *
 *   sheetFacts   one sheet: its number, its behavior's name and sentence, its counts
 *   census       the behaviors in the world and how many sheets run each
 *   totals       sheets, particles simulated this frame, particles stored
 *   findSheet    the live plane behind a camera target (matched by position)
 *
 * What counts as simulated: the particles the engine steps this frame. That is
 * a sheet's activeCount (set by the particle budget), unless the sheet is
 * paused: a paused sheet is still drawn but not stepped (src/sim/simulation.ts),
 * so it counts as stored only.
 */
import type { Behavior, PlaneInstance } from "../../core/contracts";
import { plural, shortCount } from "./words";

/** The parts of a live plane this file reads. */
export type Sheet = Pick<PlaneInstance, "desc" | "behavior" | "capacity" | "activeCount" | "paused">;

/** The name people see for a behavior. */
export const behaviorName = (b: Behavior): string => b.label ?? b.id;

/** Particles on this sheet that are stepped this frame. */
export const simulatedOn = (s: Pick<Sheet, "activeCount" | "capacity" | "paused">): number =>
  s.paused ? 0 : Math.min(Math.max(0, Math.floor(s.activeCount)), s.capacity);

export interface SheetFacts {
  /** 1-based position in the world's list of sheets, the order the , and . keys step through. */
  number: number;
  /** Sheets in the world. */
  of: number;
  /** The behavior's name. */
  name: string;
  /** One sentence on what the behavior looks like, or "" when its author gave none. */
  description: string;
  /** Particles on this sheet stepped this frame. */
  simulated: number;
  /** Particles this sheet holds in GPU memory. */
  stored: number;
}

export function sheetFacts(sheets: readonly Sheet[], sheet: Sheet): SheetFacts | null {
  const i = sheets.indexOf(sheet);
  if (i < 0) return null;
  return {
    number: i + 1,
    of: sheets.length,
    name: behaviorName(sheet.behavior),
    description: sheet.behavior.description ?? "",
    simulated: simulatedOn(sheet),
    stored: sheet.capacity,
  };
}

/** "sheet 7 of 32" */
export const sheetNumberLine = (f: SheetFacts): string => `sheet ${f.number} of ${f.of}`;

/**
 * What one sheet's particles are doing, with the word always there, because a
 * bare count does not say whether the particles were simulated or only exist:
 *
 *   "62.5K particles simulated"            every stored particle is stepped
 *   "31.2K of 62.5K particles simulated"   thinned to hold the frame rate
 *   "62.5K particles stored, resting"      out of view or paused: none stepped
 */
export const sheetCountLine = (f: SheetFacts): string =>
  f.simulated <= 0
    ? `${shortCount(f.stored)} particles stored, resting`
    : f.simulated >= f.stored
      ? `${shortCount(f.stored)} particles simulated`
      : `${shortCount(f.simulated)} of ${shortCount(f.stored)} particles simulated`;

export interface BehaviorCount {
  id: string;
  name: string;
  description: string;
  /** Sheets running this behavior. */
  sheets: number;
  /** Particles those sheets hold. */
  stored: number;
}

/** The behaviors in the world, most sheets first, then by name so the order is stable. */
export function census(sheets: readonly Sheet[]): BehaviorCount[] {
  const byId = new Map<string, BehaviorCount>();
  for (const s of sheets) {
    const b = s.behavior;
    let row = byId.get(b.id);
    if (!row) {
      row = { id: b.id, name: behaviorName(b), description: b.description ?? "", sheets: 0, stored: 0 };
      byId.set(b.id, row);
    }
    row.sheets++;
    row.stored += s.capacity;
  }
  return [...byId.values()].sort((a, b) => b.sheets - a.sheets || a.name.localeCompare(b.name));
}

export interface WorldTotals {
  sheets: number;
  /** Particles stepped this frame, across every sheet. */
  simulated: number;
  /** Particles held in GPU memory, across every sheet. */
  stored: number;
}

export function totals(sheets: readonly Sheet[]): WorldTotals {
  let simulated = 0;
  let stored = 0;
  for (const s of sheets) {
    simulated += simulatedOn(s);
    stored += s.capacity;
  }
  return { sheets: sheets.length, simulated, stored };
}

/**
 * True when the two counts would read differently on the stats line. When they
 * read the same ("2.00M" twice) one number says it all, and the line shows one.
 */
export const countsDiffer = (t: Pick<WorldTotals, "simulated" | "stored">): boolean =>
  shortCount(t.simulated) !== shortCount(t.stored);

/** "12 sheets, 750K particles stored" for one row of the census. */
export const censusLine = (row: BehaviorCount): string =>
  `${plural(row.sheets, "sheet")}, ${shortCount(row.stored)} particles stored`;

/**
 * The live plane at a point in the world, or null. The camera keeps its own
 * list of sheets (PlaneTarget), built from the same descriptions, so position
 * is what the two lists share.
 */
export function findSheet<T extends Sheet>(sheets: readonly T[], center: readonly number[], tolerance = 1e-4): T | null {
  let best: T | null = null;
  let bestD = tolerance * tolerance;
  for (const s of sheets) {
    const p = s.desc.position;
    const d = (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2;
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

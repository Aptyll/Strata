/**
 * Facts about the sheets in the world, read from the live planes. Pure: no DOM
 * and no GPU, only the fields of PlaneInstance that say what a sheet is.
 *
 *   sheetFacts   one sheet: its number, its behavior's name and sentence, its counts
 *   census       the behaviors in the world and how many sheets run each
 *   totals       sheets, particles simulated this frame, particles stored
 *   findSheet    the live plane behind a camera target (matched by position)
 */
import type { Behavior, PlaneInstance } from "../../core/contracts";
import { plural, shortCount } from "./words";

/** The parts of a live plane this file reads. */
export type Sheet = Pick<PlaneInstance, "desc" | "behavior" | "capacity" | "activeCount">;

/** The name people see for a behavior. */
export const behaviorName = (b: Behavior): string => b.label ?? b.id;

export interface SheetFacts {
  /** 1-based position in the world's list of sheets, the order the , and . keys step through. */
  number: number;
  /** Sheets in the world. */
  of: number;
  /** The behavior's name. */
  name: string;
  /** One sentence on what the behavior looks like, or "" when its author gave none. */
  description: string;
  /** Particles on this sheet stepped and drawn this frame. */
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
    simulated: sheet.activeCount,
    stored: sheet.capacity,
  };
}

/** "sheet 7 of 32" */
export const sheetNumberLine = (f: SheetFacts): string => `sheet ${f.number} of ${f.of}`;

/**
 * "62.5K particles simulated", or "31.2K of 62.5K particles simulated" when the
 * frame-rate governor thins the sheet. The word is always there: a bare count
 * does not say whether the particles were simulated or only exist.
 */
export const sheetCountLine = (f: SheetFacts): string =>
  f.simulated >= f.stored
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
  /** Particles stepped and drawn this frame, across every sheet. */
  simulated: number;
  /** Particles held in GPU memory, across every sheet. */
  stored: number;
}

export function totals(sheets: readonly Sheet[]): WorldTotals {
  let simulated = 0;
  let stored = 0;
  for (const s of sheets) {
    simulated += s.activeCount;
    stored += s.capacity;
  }
  return { sheets: sheets.length, simulated, stored };
}

/** "12 sheets, 750K particles" for one row of the census. */
export const censusLine = (row: BehaviorCount): string => `${plural(row.sheets, "sheet")}, ${shortCount(row.stored)} particles`;

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

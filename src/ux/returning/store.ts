/**
 * What Strata remembers about a visitor between visits. One JSON record in
 * localStorage, in this browser only: there are no accounts and nothing is
 * sent anywhere.
 *
 * Everything here must survive storage that is missing (private windows,
 * blocked cookies), full, or holding something unreadable: the site then
 * behaves like a first visit and keeps nothing.
 */
import { isDay } from "./daily";
import { isSnapshot, type Snapshot } from "./worlds";

export const STORE_KEY = "strata.returning.v1";
/** Kept worlds are never dropped without the visitor asking, so the list has a size instead. */
export const MAX_KEPT = 24;

export type StorageLike = Pick<Storage, "getItem" | "setItem">;

export interface VisitorRecord {
  v: 1;
  /** Page loads so far. */
  visits: number;
  /** Local days of the first and the latest visit, "YYYY-MM-DD". */
  firstDay: string;
  lastDay: string;
  /** How many different days had a visit. */
  days: number;
  /** How many lines of NEWS (./news.ts) this visitor has been told, or that were there before they first came. */
  news: number;
  /**
   * The last day's world this browser opened (the day and its dice seed). The
   * page link holds the seed, so when that same link comes back on a later day
   * it is this browser's own stale address, not a world someone chose to share.
   */
  daily: { day: string; seed: number } | null;
  /** The last day the visitor was told that today's world is waiting. */
  invited: string;
  /** Worlds the visitor chose to keep, newest first. */
  kept: Snapshot[];
  /** The world that was on screen when the page was last left. */
  left: Snapshot | null;
}

export const freshRecord = (today: string, news: number): VisitorRecord => ({
  v: 1,
  visits: 0,
  firstDay: today,
  lastDay: today,
  days: 0,
  news,
  daily: null,
  invited: "",
  kept: [],
  left: null,
});

/** The browser's storage, or null where it is unavailable or forbidden. */
export function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** Read stored text into a record, keeping what is valid and dropping what is not. Null when it is not a record at all. */
export function parseRecord(raw: string | null | undefined): VisitorRecord | null {
  if (!raw) return null;
  let data: Partial<VisitorRecord> | null;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || data.v !== 1) return null;
  const firstDay = isDay(data.firstDay) ? data.firstDay : "";
  const lastDay = isDay(data.lastDay) ? data.lastDay : firstDay;
  if (!lastDay) return null;
  const daily = data.daily;
  return {
    v: 1,
    visits: count(data.visits),
    firstDay: firstDay || lastDay,
    lastDay,
    days: count(data.days),
    news: count(data.news),
    daily: daily && isDay(daily.day) && Number.isFinite(daily.seed) ? { day: daily.day, seed: daily.seed >>> 0 } : null,
    invited: isDay(data.invited) ? data.invited : "",
    kept: Array.isArray(data.kept) ? data.kept.filter(isSnapshot).slice(0, MAX_KEPT) : [],
    left: isSnapshot(data.left) ? data.left : null,
  };
}

/** The stored record, or null for someone this browser has not seen. */
export function readRecord(storage: StorageLike | null): VisitorRecord | null {
  try {
    return parseRecord(storage?.getItem(STORE_KEY));
  } catch {
    return null;
  }
}

/** Store the record. False when the browser refused (no storage, or it is full). */
export function writeRecord(record: VisitorRecord, storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Count this page load in a record, in place. */
export function countVisit(record: VisitorRecord, today: string): VisitorRecord {
  record.visits += 1;
  if (record.days === 0 || record.lastDay !== today) record.days += 1;
  record.lastDay = today;
  return record;
}

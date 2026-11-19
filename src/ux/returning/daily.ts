/**
 * Today's world: one roll of the dice per calendar day, the same for everyone
 * who opens Strata on that date and different tomorrow.
 *
 * The day is the visitor's local calendar day, so it turns over at their own
 * midnight and the date shown on screen matches their calendar. The seed is a
 * pure function of the day's text. Never change it: it is what lets two people
 * on the same date talk about the same world.
 */

/** A local calendar day as "YYYY-MM-DD". */
export function dayKey(date: Date = new Date()): string {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for text shaped like a dayKey. */
export const isDay = (text: unknown): text is string => typeof text === "string" && DAY.test(text);

/** The dice seed (an unsigned 32-bit integer) of a day's world. */
export function dailySeed(day: string): number {
  // FNV-1a over the text, then a finalizer so that neighbouring dates share no pattern.
  const text = `strata day ${day}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2026-11-19" -> "nov 19". Text that is not a day comes back unchanged. */
export function dayLabel(day: string): string {
  const m = DAY.exec(day);
  if (!m) return day;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}`;
}

/** Whole days from `from` to `to`: positive when `to` is later, 0 when either is not a day. */
export function daysBetween(from: string, to: string): number {
  const a = DAY.exec(from);
  const b = DAY.exec(to);
  if (!a || !b) return 0;
  const utc = (m: RegExpExecArray) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

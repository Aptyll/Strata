/**
 * The worlds seen since the page opened, in order, with a place in the list:
 * what "previous world" and "next world" walk through. It works like a
 * browser's back and forward: stepping back and then rolling again drops the
 * worlds that lay ahead.
 */
import type { Scene } from "../../core/contracts";

/** One world in the list, held in the cheapest form that brings it back exactly. */
export interface WorldEntry {
  /**
   * The dice seed, for a roll nobody has tuned since. Replaying the seed
   * brings the world back and lets it glide in like any roll.
   */
  seed?: number;
  /**
   * The world itself, when a seed would not bring it back: the opening, a
   * kept world, a roll with a slider moved. Wins over `seed` when both are set.
   */
  scene?: Scene;
}

export class WorldHistory {
  private entries: WorldEntry[] = [];
  private at = -1;

  constructor(private readonly limit = 32) {}

  /** The world on screen, or null before the first one is recorded. */
  get current(): WorldEntry | null {
    return this.entries[this.at] ?? null;
  }

  get canGoBack(): boolean {
    return this.at > 0;
  }

  get canGoForward(): boolean {
    return this.at >= 0 && this.at < this.entries.length - 1;
  }

  get length(): number {
    return this.entries.length;
  }

  /** A new world is on screen. Whatever lay ahead of the current one is dropped. */
  visit(entry: WorldEntry): void {
    this.entries.length = this.at + 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    this.at = this.entries.length - 1;
  }

  /** The world on screen was swapped for another before anyone saw it (at page load). */
  replace(entry: WorldEntry): void {
    if (this.at < 0) this.visit(entry);
    else this.entries[this.at] = entry;
  }

  /** Put an older world behind everything else: the one left at the end of the last visit. Meant for page load. */
  prepend(entry: WorldEntry): void {
    this.entries.unshift(entry);
    this.at += 1;
  }

  /** Step to the world before the current one, or null at the start. */
  back(): WorldEntry | null {
    if (!this.canGoBack) return null;
    return this.entries[--this.at];
  }

  /** Step to the world after the current one, or null at the end. */
  forward(): WorldEntry | null {
    if (!this.canGoForward) return null;
    return this.entries[++this.at];
  }
}

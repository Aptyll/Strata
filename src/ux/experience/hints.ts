// Hints that only appear when they are needed.
//
// There is no tutorial. Each hint teaches one gesture, waits until the person
// has had a fair chance to find it alone, and is retired the moment they do
// it. At most one hint is on screen, and never during the intro.

export interface HintDef {
  id: string;
  /** Shown with a mouse or trackpad. */
  text: string;
  /** Shown on touch devices. */
  touchText?: string;
  /** Seconds of eligible time before showing. */
  delay: number;
  /** Ids that must be learned (or already shown) first. */
  after?: string[];
  /** Seconds on screen (default 6). */
  duration?: number;
}

export const DEFAULT_HINTS: HintDef[] = [
  { id: 'orbit', text: 'drag to turn', touchText: 'drag to turn', delay: 6 },
  { id: 'hold', text: 'hold to pull', touchText: 'press and hold to pull', delay: 5, after: ['orbit'] },
  { id: 'zoom', text: 'scroll to dive in', touchText: 'pinch to dive in', delay: 8, after: ['orbit'] },
  { id: 'focus', text: 'double-click a sheet to face it', touchText: 'double-tap a sheet to face it', delay: 14, after: ['orbit', 'zoom'] },
];

/** Pure scheduling logic. No DOM. */
export class HintScheduler {
  defs: HintDef[];
  learned: Set<string>;
  /** Seconds of quiet between one hint leaving and the next arriving. */
  gap: number;
  waited = 0;
  shownFor = 0;
  current: HintDef | null = null;
  shownOnce = new Set<string>();

  constructor(defs: HintDef[] = DEFAULT_HINTS, opts: { learned?: Iterable<string>; gap?: number } = {}) {
    this.defs = defs;
    this.learned = new Set(opts.learned ?? []);
    this.gap = opts.gap ?? 4;
  }

  /** The person performed the gesture. Retire its hint for good. */
  learn(id: string): boolean {
    if (this.learned.has(id)) return false;
    this.learned.add(id);
    if (this.current?.id === id) this.clear();
    return true;
  }

  private clear(): void {
    this.current = null;
    this.shownFor = 0;
    this.waited = -this.gap;
  }

  private next(): HintDef | null {
    return this.defs.find((d) =>
      !this.learned.has(d.id) &&
      !this.shownOnce.has(d.id) &&
      (d.after ?? []).every((a) => this.learned.has(a) || this.shownOnce.has(a))) ?? null;
  }

  /**
   * @param dt seconds
   * @param eligible false while the intro runs or a gesture is in progress
   * @returns the hint to display right now
   */
  update(dt: number, eligible: boolean): HintDef | null {
    if (this.current) {
      this.shownFor += dt;
      if (this.shownFor >= (this.current.duration ?? 6)) {
        // Shown and ignored. Do not nag: each hint gets one showing per visit.
        this.shownOnce.add(this.current.id);
        this.clear();
      }
      return this.current;
    }
    if (!eligible) return null;
    const next = this.next();
    if (!next) return null;
    this.waited += dt;
    if (this.waited >= next.delay) {
      this.current = next;
      this.shownFor = 0;
      this.waited = 0;
    }
    return this.current;
  }
}

const STYLE = `
.strata-hint{position:absolute;left:50%;bottom:max(7vh,calc(env(safe-area-inset-bottom) + 28px));
transform:translateX(-50%);font:400 11px/1 ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
letter-spacing:.32em;text-transform:uppercase;color:#fff;opacity:0;white-space:nowrap;
pointer-events:none;user-select:none;transition:opacity 1.4s ease}
.strata-hint[data-on="1"]{opacity:.42}
@media (prefers-reduced-motion:reduce){.strata-hint{transition-duration:.01s}}
`;

/**
 * DOM renderer for hints: one line of small, wide-set text near the bottom.
 * @param root a positioned element covering the canvas
 */
export function createHintView(root: HTMLElement, opts: { touch?: boolean } = {}) {
  const doc = root.ownerDocument;
  if (!doc.getElementById('strata-hint-style')) {
    const style = doc.createElement('style');
    style.id = 'strata-hint-style';
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  const el = doc.createElement('div');
  el.className = 'strata-hint';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  root.appendChild(el);
  let shownId: string | null = null;
  return {
    el,
    show(hint: HintDef | null): void {
      const id = hint?.id ?? null;
      if (id === shownId) return;
      shownId = id;
      if (hint) {
        el.textContent = (opts.touch && hint.touchText) || hint.text;
        el.dataset.on = '1';
      } else {
        // Leave the text in place so it can fade rather than vanish.
        el.dataset.on = '0';
      }
    },
    dispose(): void { el.remove(); },
  };
}

const KEY = 'strata.ux.v1';

/** Small persistent memory: which hints were learned, and whether the intro was seen. */
export interface UxMemory {
  visits: number;
  learned: string[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function loadMemory(storage: StorageLike | null = safeStorage()): UxMemory {
  try {
    const raw = storage?.getItem(KEY);
    const m = raw ? JSON.parse(raw) : {};
    return { visits: m.visits | 0, learned: Array.isArray(m.learned) ? m.learned : [] };
  } catch {
    return { visits: 0, learned: [] };
  }
}

export function saveMemory(memory: UxMemory, storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(KEY, JSON.stringify(memory));
  } catch { /* private mode or blocked storage: the experience works without it */ }
}

function safeStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

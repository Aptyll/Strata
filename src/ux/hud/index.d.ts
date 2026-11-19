// Types for the Strata HUD (index.js). See docs/ux/hud.md.

/** Structural match for TOKENS in src/core/contracts.ts. */
export interface HudTokens {
  color?: { background?: string; foreground?: string };
  font?: string;
  letterSpacing?: string;
  opacityStrong?: number;
  opacityDim?: number;
  easing?: string;
  durationMs?: number;
  unit?: number;
}

/** One roll of the dice. `face` is 1..6 and always equals seed % 6 + 1. */
export interface Roll {
  /** Unsigned 32-bit integer. Feed it to a seeded generator to make the roll reproducible. */
  seed: number;
  face: number;
}

/** What a randomize handler may return to have the new system announced on screen. */
export type RollName = string | { name: string; detail?: string } | void | null;
export type RandomizeHandler = (roll: Roll) => RollName | Promise<RollName>;

export interface HudOptions {
  /** Element to overlay. Default document.body. */
  parent?: HTMLElement;
  /** Pass TOKENS from src/core/contracts.ts so the HUD follows the shared design tokens. */
  tokens?: HudTokens;
  /** Show the stats line on load. Default: off on a first visit, then whatever the visitor last chose. */
  stats?: boolean;
  /** Show the randomize dice. Default true. */
  dice?: boolean;
  onRandomize?: RandomizeHandler | null;
  /** On a first visit, start a slow pulse on the die after this long, until the first roll. 0 disables. Default 6000. */
  diceHintMs?: number;
  /** Fade the dice and menu dot after this long without input. 0 disables. Default 2500. */
  idleMs?: number;
  /** Hide the mouse cursor over the parent while idle. Default true. */
  hideCursor?: boolean;
  /** Measure fps from requestAnimationFrame until setStat('fps', n) is called. Default true. */
  autoFps?: boolean;
  /** Announce the plane name when the 'plane' stat changes. Default true. */
  announce?: boolean;
  /** localStorage key for param values, or false. Default 'strata.hud'. */
  persist?: string | false;
  /** Install the built-in keyboard shortcuts. Default true. */
  shortcuts?: boolean;
  /** Start with the settings menu open. Default false. */
  panelOpen?: boolean;
  /** Where to listen for keys. Default window. */
  keyTarget?: EventTarget;
}

export type ParamValue = number | boolean | string;

interface ParamBase<T> {
  id: string;
  /** Defaults to id. */
  label?: string;
  /** Section heading. Params without one go first. */
  group?: string;
  onChange?: (value: T, id: string) => void;
  /** Save the value in localStorage. Default true. */
  persist?: boolean;
}
export interface RangeParam extends ParamBase<number> {
  type?: 'range';
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  /** 'log' suits counts that span orders of magnitude. Needs min > 0. */
  scale?: 'linear' | 'log';
  format?: (value: number) => string;
  /** Fire onChange while dragging. false fires on release only. Default true. */
  live?: boolean;
}
export interface ToggleParam extends ParamBase<boolean> {
  type?: 'toggle';
  value: boolean;
}
export interface SelectParam extends ParamBase<string> {
  type?: 'select';
  value?: string;
  options: Array<string | { value: string; label: string }>;
}
export interface ActionParam {
  id: string;
  label?: string;
  group?: string;
  type?: 'action';
  run: () => void;
}
export type ParamSpec = RangeParam | ToggleParam | SelectParam | ActionParam;

export interface SetOptions {
  /**
   * Update the control without calling onChange or emitting 'change'. Ignored while the
   * person is mid-drag on that slider (a live: false range), so an engine echo cannot yank it.
   */
  silent?: boolean;
}
export interface ParamHandle {
  id: string;
  get(): ParamValue;
  set(value: ParamValue, options?: SetOptions): ParamValue;
  reset(): ParamValue;
  remove(): void;
}

export interface ShortcutSpec {
  /** e.g. 'g', '?', 'space', 'arrowleft', '['. Case-insensitive. */
  key: string;
  /** Shown in the keys sheet. */
  label: string;
  run: (e: KeyboardEvent) => void;
  /** Leave out of the keys sheet. */
  hidden?: boolean;
}

export interface StatDef {
  /** Unit shown after the value. Defaults to the key. */
  label?: string;
  /** Bottom-left (default) or bottom-right. */
  slot?: 'left' | 'right';
  format?: ((value: number) => string) | null;
  title?: (value: number) => string;
}

export interface JobContext {
  /** Aborted when the visitor cancels. Pass it on, or check signal.aborted between frames. */
  signal: AbortSignal;
  /** Report progress: fraction 0..1 for the bar (null hides it), and optional text for the line. */
  progress(fraction: number | null, text?: string): void;
}
export interface JobSpec {
  id: string;
  /** Shown on the menu action and as the opening status line. */
  label?: string;
  /** Menu section, e.g. 'capture'. */
  group?: string;
  /** Resolve with a string to show it as the closing line. Throw to report a failure. */
  run(job: JobContext): Promise<string | void> | string | void;
}
export interface JobHandle {
  id: string;
  /** Start it from code (same as pressing the menu action). */
  start(): void;
  cancel(): void;
  remove(): void;
}

export interface HudEvents {
  job: (id: string, running: boolean) => void;
  change: (id: string, value: ParamValue) => void;
  panel: (open: boolean) => void;
  stats: (on: boolean) => void;
  randomize: RandomizeHandler;
}

export interface Hud {
  /** The overlay element. Set CSS custom properties on it to retheme. */
  readonly el: HTMLDivElement;

  /** Built in: 'particles', 'planes', 'time', 'fps', 'plane', 'behavior'. Unknown keys are added bottom-left. */
  setStat(key: string, value: number | string | null | undefined): void;
  setStats(values: Record<string, number | string | null | undefined>): void;
  defineStat(key: string, def?: StatDef): void;
  /** Restart the built-in elapsed timer. Rolling the dice does this too. */
  resetTimer(): void;
  /** Fade a title (and optional subtitle) in and out above the dice. */
  announce(title: string, sub?: string | null, holdMs?: number): void;

  /** Show a centred message (loading, unsupported browser) until cleared with message(null). */
  message(text: string | null): void;

  /** One quiet line at the bottom centre, in place of the die. holdMs fades it; status(null) clears it. */
  status(text: string | null, holdMs?: number): void;
  /**
   * Add a menu action that launches a long-running job (offline render, export).
   * One job at a time. Shows a progress line, turns the action into "cancel ...",
   * and Escape with the menu closed cancels too. The dice is off while a job runs.
   */
  registerJob(spec: JobSpec): JobHandle;
  /** True while a job is running. */
  readonly busy: boolean;

  registerParam(spec: ParamSpec): ParamHandle;
  registerParams(specs: ParamSpec[]): ParamHandle[];
  removeParam(id: string): void;
  getParam(id: string): ParamValue | undefined;
  setParam(id: string, value: ParamValue, options?: SetOptions): ParamValue | undefined;
  getParams(): Record<string, ParamValue>;
  resetParams(): void;

  /** Roll the dice. Pass a seed to replay a roll. */
  randomize(seed?: number): Roll;
  /** Subscribe to rolls. Returns an unsubscribe function. */
  onRandomize(fn: RandomizeHandler): () => void;

  /** Returns a function that removes the shortcut. */
  registerShortcut(spec: ShortcutSpec): () => void;
  on<K extends keyof HudEvents>(type: K, fn: HudEvents[K]): () => void;

  openPanel(): void;
  closePanel(): void;
  togglePanel(): void;
  showStats(): void;
  hideStats(): void;
  toggleStats(): void;
  toggleHelp(): void;
  /** Count as user activity: bring the dice back and restart the idle timer. */
  wake(): void;

  readonly panelOpen: boolean;
  readonly statsVisible: boolean;
  readonly idle: boolean;

  destroy(): void;
}

export function createHud(options?: HudOptions): Hud;

/** 1048576 -> "1.05M" */
export function formatCount(n: number): string;
/** 1048576 -> "1 048 576" (thin spaces) */
export function formatExact(n: number): string;
export function formatValue(value: number | string | boolean, step?: number): string;
/** 75 -> "1:15" */
export function formatTime(seconds: number): string;

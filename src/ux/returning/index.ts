/**
 * Reasons to come back (docs/ux/returning.md).
 *
 * A first visit is left exactly as it is. From the second visit on:
 *
 *   today's world   the plain address opens on a world that is new every
 *                   calendar day, with the date on screen (N goes there too)
 *   kept worlds     K keeps the world on screen exactly as it is: every
 *                   sheet's rule, the sliders, the view. The Esc menu lists them
 *   previous world  Backspace steps back through the worlds seen, so a roll of
 *                   the dice can be undone. On arrival the world that was left
 *                   last time is one step back
 *   what is new     one line, once, for each thing added since the last visit
 *
 * Everything is remembered in this browser's localStorage and nowhere else
 * (./store.ts). The page keeps working when storage is unavailable; it then
 * treats every visit as the first and keeps worlds only until the tab closes.
 *
 * Wiring (src/main.ts): mount after the HUD, call update(dt) once per frame.
 * All world changes go through the HUD's dice (hud.randomize) or through
 * AppContext.loadScene, so this file needs no hooks in the engine.
 */
import type { AppContext, Scene } from "../../core/contracts";
import { loadMemory } from "../experience/hints";
import type { Hud } from "../hud/index.js";
import { decideArrival, parseRoll, rollHash, type Arrival, type OpensOn } from "./arrival";
import { dailySeed, dayKey, dayLabel } from "./daily";
import { WorldHistory, type WorldEntry } from "./history";
import { NEWS, newsHint, unseenNews, type NewsItem } from "./news";
import {
  MAX_KEPT,
  countVisit,
  freshRecord,
  readRecord,
  safeStorage,
  writeRecord,
  type StorageLike,
  type VisitorRecord,
} from "./store";
import { cloneScene, sameWorld, takeSnapshot, usable, withParticleTotal, worldName, type Snapshot } from "./worlds";

export { decideArrival, parseRoll, type Arrival, type OpensOn } from "./arrival";
export { dailySeed, dayKey, dayLabel } from "./daily";
export { NEWS, type NewsItem } from "./news";
export { STORE_KEY, type VisitorRecord } from "./store";
export type { Snapshot } from "./worlds";

/** What second and later visits open on. Noah chose today's world (decision card, 2026-11-19). */
export const RETURN_OPENS_ON: OpensOn = "today";

/** The parts of the HUD (src/ux/hud) this uses. */
export type ReturningHud = Pick<
  Hud,
  | "randomize"
  | "onRandomize"
  | "announce"
  | "registerParam"
  | "removeParam"
  | "registerShortcut"
  | "getParam"
  | "setParam"
  | "on"
  | "closePanel"
  | "busy"
  | "panelOpen"
  | "rolled"
>;

/** The parts of the AppContext this uses. */
export type ReturningApp = Pick<AppContext, "getScene" | "loadScene" | "behaviors" | "planes">;

/** A key and its label in the keys sheet: a row of KEYS in src/app/keys.ts. */
export interface KeyLabel {
  key: string;
  label: string;
}

/** The page link, behind an interface so tests and the demo can stand in for the address bar. */
export interface PageAddress {
  readonly search: string;
  readonly hash: string;
  /** Replace the hash ("" removes it) without adding a step to the browser's history. */
  setHash(hash: string): void;
}

export interface ReturningOptions {
  app: ReturningApp;
  hud: ReturningHud;
  keys: { today: KeyLabel; keep: KeyLabel; previous: KeyLabel };
  /** True while the opening plays: lines wait for it to end. */
  isOpening?: () => boolean;
  /** Defaults to RETURN_OPENS_ON. */
  opensOn?: OpensOn;
  /** Touch wording for the lines. Defaults to the (pointer: coarse) media query. */
  touch?: boolean;
  /** Where the record lives. Defaults to localStorage; null keeps nothing. */
  storage?: StorageLike | null;
  /** The clock. Defaults to the real one; the demo moves it to show tomorrow. */
  now?: () => Date;
  address?: PageAddress;
}

export interface Returning {
  /** Call once per frame with the frame's seconds: times the lines. */
  update(dt: number): void;
  /** Go to today's world. */
  today(): void;
  /** Keep the world on screen. Keeping the same world again refreshes its view. */
  keep(): void;
  /** Forget the kept world that is on screen. */
  forget(): void;
  /** Open a kept world by its snapshot id. */
  open(id: string): void;
  /** Step to the previous or the next world seen. */
  back(): void;
  forward(): void;
  /** Store the world on screen as the one that was left. Runs by itself when the page is hidden or closed. */
  remember(): void;
  /** What this page load opened on, and why. */
  readonly arrival: Arrival;
  /** The visitor's record as stored. */
  readonly record: VisitorRecord;
  dispose(): void;
}

/** One line waiting for a quiet moment on screen. */
interface Line {
  id: "invite" | "news" | "replay";
  title: string;
  sub: string | null;
  holdMs: number;
  /** Runs when the line actually appears, so a short visit does not use lines up unseen. */
  shown?: () => void;
}

/** Seconds of calm before the first line, and between a line fading and the next. */
const FIRST_LINE_AFTER = 6;
const LINE_GAP = 3;
/** A line never lands on top of a world that just changed: the dice announce the new world's name. */
const AFTER_CHANGE = 4;
const LINE_HOLD_MS = 5200;
/** How long the day stays on screen. At load the world is still fading in under the title card, so it stays until that has gone. */
const TODAY_HOLD_MS = 3200;
const TODAY_HOLD_AT_LOAD_MS = 6400;

/**
 * A roll of the dice changes the sheets one after another for several seconds. A world kept during
 * that time is copied again once nothing has changed for LANDED_AFTER seconds, looking every
 * LANDING_CHECK seconds, and never watched for longer than LANDING_LIMIT.
 */
const LANDED_AFTER = 2;
const LANDING_CHECK = 0.25;
const LANDING_LIMIT = 30;

/**
 * Esc menu placement where no table says otherwise (the demo, another host).
 * In the app, MENU in src/app/menu.ts lists these controls and has the last word.
 */
const PLACE = { group: "your worlds", page: "scene" };

const browserAddress = (): PageAddress => ({
  get search() {
    return globalThis.location?.search ?? "";
  },
  get hash() {
    return globalThis.location?.hash ?? "";
  },
  setHash(hash) {
    if (typeof history === "undefined" || typeof location === "undefined") return;
    if (location.hash === hash) return;
    history.replaceState(history.state, "", location.pathname + location.search + hash);
  },
});

/**
 * Someone who came before this module existed has no record yet, but the older keys remember them.
 *
 * Both keys can be written during this very page load, before this file mounts: the opening counts
 * its visit as it starts, and a link's roll replayed at load marks the die as rolled. So a count of
 * one, or a rolled die on a link that carries a roll, says nothing about earlier visits. Reading
 * someone who came once before as new only delays today's world by a visit; the other mistake would
 * change a first visit, which this module promises to leave alone.
 */
function earlierVisitor(storage: StorageLike | null, hud: ReturningHud, today: string, linked: boolean): VisitorRecord | null {
  const known = loadMemory(storage).visits >= 2 || (hud.rolled && !linked);
  // news: 0, because nothing in the list has been said to them yet.
  return known ? freshRecord(today, 0) : null;
}

/** True while one of the gesture hints (src/ux/experience/hints.ts) is on screen: one line of text at a time. */
const hintShowing = (): boolean =>
  typeof document !== "undefined" && document.querySelector('.strata-hint[data-on="1"]') !== null;

export function mountReturning(options: ReturningOptions): Returning {
  const { app, hud, keys } = options;
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const now = options.now ?? (() => new Date());
  const address = options.address ?? browserAddress();
  const opensOn = options.opensOn ?? RETURN_OPENS_ON;
  const touch = options.touch ?? globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
  const today = (): string => dayKey(now());

  // ---- the record ---------------------------------------------------------
  /** The visitor as they were before this load. Null means a first visit. */
  const before = readRecord(storage) ?? earlierVisitor(storage, hud, today(), parseRoll(address.hash) !== null);
  const arrival = decideArrival({ search: address.search, hash: address.hash, today: today(), record: before, opensOn });
  let record = countVisit(before ? structuredClone(before) : freshRecord(today(), NEWS.length), today());
  /** The last write was refused (no storage, or it is full): the record in memory is ahead of the stored one. */
  let unsaved = !writeRecord(record, storage);
  /**
   * Edit the stored record. Reads it again first, so two open tabs do not undo each other; not after
   * a refused write, when reading would drop what only this tab still holds. False when the browser kept nothing.
   */
  const change = (edit: (r: VisitorRecord) => void): boolean => {
    if (!unsaved) record = readRecord(storage) ?? record;
    edit(record);
    unsaved = !writeRecord(record, storage);
    return !unsaved;
  };

  // ---- the worlds seen since the page opened --------------------------------
  const history = new WorldHistory();
  /** True while this file replays a roll itself, so that roll is not recorded as a new world. */
  let replaying = false;
  /** A behavior slider moved since the current world appeared: its seed alone no longer brings it back. */
  let tuned = false;
  /** Seconds since the world last changed. */
  let sinceChange = 0;
  /** The first plane as of the last frame, to notice a world that was rebuilt since. */
  let framePlane = app.planes[0];

  /** The scene on screen, or null when there is nothing to copy: a streamed world keeps its planes outside the scene. */
  const liveScene = (): Scene | null => {
    const scene = app.getScene();
    return scene.planes.length > 0 && scene.planes.length === app.planes.length ? scene : null;
  };
  const themeNow = (): string | undefined => {
    const t = hud.getParam("theme");
    return typeof t === "string" ? t : undefined;
  };
  const snapshotNow = (): Snapshot | null => {
    const scene = liveScene();
    return scene && takeSnapshot(scene, app.behaviors, { day: today(), seed: history.current?.seed, theme: themeNow() });
  };

  /**
   * The world just kept, while it may still be landing: the copy taken at the
   * key press can hold sheets of the world before, so it is taken again when
   * the world has stopped changing or is about to be left.
   */
  let landing: { id: string; entry: WorldEntry | null; last: Scene; quiet: number; wait: number; age: number } | null = null;
  const land = (): void => {
    const l = landing;
    landing = null;
    const scene = l && liveScene();
    if (!l || !scene || history.current !== l.entry) return;
    const kept = record.kept.find((k) => k.id === l.id);
    if (!kept || sameWorld(kept.scene, scene)) return;
    change((r) => {
      const k = r.kept.find((x) => x.id === l.id);
      if (!k) return;
      // The sheets as they landed; the view and the brightness stay as they were at the key press.
      k.scene = { ...k.scene, planes: cloneScene(scene).planes };
      k.name = worldName(k.scene, app.behaviors);
    });
    listKept();
  };
  const watchLanding = (dt: number): void => {
    const l = landing;
    if (!l) return;
    l.age += dt;
    if (tuned || history.current !== l.entry) return void (landing = null); // a moved slider is not part of what was kept
    if ((l.wait += dt) < LANDING_CHECK) return;
    l.wait = 0;
    const scene = liveScene();
    if (!scene) return void (landing = null);
    if (!sameWorld(l.last, scene)) {
      l.last = cloneScene(scene);
      l.quiet = 0;
    } else if ((l.quiet += LANDING_CHECK) >= LANDED_AFTER) {
      return land();
    }
    if (l.age >= LANDING_LIMIT) land();
  };

  /**
   * Before leaving the world on screen: make sure its history entry brings it
   * back as it is now. A plain roll needs nothing (its seed does that). A
   * tuned roll, the opening and a kept world are copied.
   */
  const settle = (): void => {
    land();
    const cur = history.current;
    if (!cur || !(cur.scene || tuned || cur.seed === undefined)) return;
    // Rebuilt since the last frame (an engine that cuts instead of swapping): the scene is no longer that world.
    if (app.planes[0] !== framePlane) return;
    const scene = liveScene();
    if (scene) cur.scene = cloneScene(scene);
  };

  const replay = (seed: number): void => {
    replaying = true;
    try {
      hud.randomize(seed);
    } finally {
      replaying = false;
    }
  };

  /**
   * Put a history entry on screen. A step through the worlds seen changes the
   * sheets and nothing else, like a roll of the dice: the camera, the brightness
   * and the particle total stay as they are. `exact` brings those back too, as
   * they were stored. False when the entry cannot be shown.
   */
  const show = (entry: WorldEntry, exact = false): boolean => {
    if (entry.scene) {
      // A streamed world keeps its sheets outside the scene: loading one over it would wipe it.
      if (!liveScene() || !usable(entry.scene, app.behaviors)) return false;
      const scene = cloneScene(entry.scene);
      if (exact) {
        app.loadScene(scene);
        hud.setParam("brightness", scene.render.brightness, { silent: true });
      } else {
        const live = app.getScene();
        const total = app.planes.reduce((n, p) => n + p.capacity, 0);
        // getScene hands out the live camera; passing that back tells the engine to leave the camera where it is.
        app.loadScene({ ...withParticleTotal(scene, total), camera: live.camera, render: { ...live.render } });
      }
      address.setHash(entry.seed === undefined ? "" : rollHash(entry.seed));
    } else if (entry.seed !== undefined) {
      replay(entry.seed);
    } else {
      return false;
    }
    tuned = false;
    sinceChange = 0;
    return true;
  };

  const offRoll = hud.onRandomize(({ seed }) => {
    sinceChange = 0;
    if (replaying) return;
    // A person rolled. The roll has started but no plane has changed yet, so the scene still shows the world being left.
    settle();
    history.visit({ seed });
    tuned = false;
  });
  const offChange = hud.on("change", (id) => {
    if (id.startsWith("behavior.")) tuned = true;
  });

  // ---- lines: one at a time, only in a quiet moment -------------------------
  let lines: Line[] = [];
  let calmFor = 0;
  let waitFor = FIRST_LINE_AFTER;
  const newsLine = (item: NewsItem, id: Line["id"], counts: boolean): Line => ({
    id,
    title: `new: ${item.text}`,
    sub: newsHint(item, touch),
    holdMs: LINE_HOLD_MS,
    shown: counts ? () => void change((r) => (r.news = Math.min(NEWS.length, r.news + 1))) : undefined,
  });

  // ---- actions ---------------------------------------------------------------
  const openToday = (atLoad = false): void => {
    if (hud.busy) return;
    const day = today();
    const seed = dailySeed(day);
    const cur = history.current;
    const onIt = !atLoad && !!cur && cur.seed === seed && !cur.scene && !tuned;
    if (!onIt) {
      if (!atLoad) settle();
      history.visit({ seed });
      replay(seed);
      tuned = false;
    }
    sinceChange = 0;
    const holdMs = atLoad ? TODAY_HOLD_AT_LOAD_MS : TODAY_HOLD_MS;
    hud.announce("today's world", dayLabel(day), holdMs);
    // The day is a line like any other: the next one waits until it has gone.
    calmFor = 0;
    waitFor = Math.max(waitFor, holdMs / 1000 + LINE_GAP);
    change((r) => (r.daily = { day, seed }));
    lines = lines.filter((l) => l.id !== "invite");
  };

  const keep = (): void => {
    const snap = snapshotNow();
    if (!snap) {
      hud.announce("this world cannot be kept", "it streams in as you fly");
      return;
    }
    let full = false;
    let total = 0;
    // Kept a moment ago and still landing: this press is the same world, whatever its sheets hold by now.
    const again = landing && landing.entry === history.current ? landing.id : null;
    const stored = change((r) => {
      const same = r.kept.findIndex((k) => k.id === again || sameWorld(k.scene, snap.scene));
      if (same >= 0) r.kept.splice(same, 1); // the same world again: keep its newer view, not two of it
      else if (r.kept.length >= MAX_KEPT) return void (full = true);
      r.kept.unshift(snap);
      total = r.kept.length;
    });
    if (full) {
      hud.announce("kept worlds are full", "forget one in the menu first");
      return;
    }
    // The dice may still be landing: watch until the world stops changing, then take the copy again.
    landing = !tuned && sinceChange < LANDING_LIMIT ? { id: snap.id, entry: history.current, last: snap.scene, quiet: 0, wait: 0, age: 0 } : null;
    // Not stored (no storage, or it is full): the world is still kept in memory while the page is open.
    hud.announce("kept", stored ? `${snap.name} · ${total} kept` : "only until this tab closes");
    listKept();
  };

  const forget = (): void => {
    const scene = liveScene();
    let name: string | null = null;
    if (scene) {
      const landingId = landing && landing.entry === history.current ? landing.id : null;
      change((r) => {
        const i = r.kept.findIndex((k) => k.id === landingId || sameWorld(k.scene, scene));
        if (i >= 0) name = r.kept.splice(i, 1)[0].name;
      });
      landing = null;
    }
    if (name === null) hud.announce("not a kept world", "open one from the menu, then forget it");
    else hud.announce("forgotten", name);
    listKept();
  };

  const open = (id: string): void => {
    if (hud.busy) return;
    const snap = record.kept.find((k) => k.id === id);
    if (!snap) return;
    if (!usable(snap.scene, app.behaviors)) {
      hud.announce("this world cannot open", "it uses a behavior that is gone");
      return;
    }
    if (!liveScene()) {
      hud.announce("kept worlds cannot open here", "this world streams in as you fly");
      return;
    }
    settle();
    const entry: WorldEntry = { scene: snap.scene, seed: snap.seed };
    history.visit(entry);
    show(entry, true);
    if (snap.theme && themeNow() !== undefined && themeNow() !== snap.theme) hud.setParam("theme", snap.theme);
    hud.announce(snap.name, `kept ${dayLabel(snap.day)}`);
  };

  const step = (direction: "back" | "forward"): void => {
    if (hud.busy) return;
    settle();
    const entry = direction === "back" ? history.back() : history.forward();
    if (!entry) {
      hud.announce(direction === "back" ? "no earlier world" : "no later world");
      return;
    }
    if (!show(entry)) hud.announce("that world is gone");
    // A replayed roll is announced by the dice; a stored world has to say its own name.
    else if (entry.scene) hud.announce(worldName(entry.scene, app.behaviors));
  };

  const whatsNew = (): void => {
    const latest = NEWS.slice(-3);
    if (!latest.length) {
      hud.announce("nothing new yet");
      return;
    }
    hud.closePanel();
    lines = lines.filter((l) => l.id !== "replay").concat(latest.map((item) => newsLine(item, "replay", false)));
    // Asked for, so the first line comes at once.
    waitFor = 0;
    sinceChange = Math.max(sinceChange, AFTER_CHANGE);
  };

  // ---- Esc menu and keys -----------------------------------------------------
  hud.registerParam({ id: "returning.today", label: "today's world", type: "action", run: () => openToday(), ...PLACE });
  hud.registerParam({ id: "returning.previous", label: "previous world", type: "action", run: () => step("back"), ...PLACE });
  hud.registerParam({ id: "returning.keep", label: "keep this world", type: "action", run: keep, ...PLACE });
  hud.registerParam({ id: "returning.news", label: "what's new", type: "action", run: whatsNew, ...PLACE });
  /** The kept worlds as a menu list, rebuilt when the list changes. Without a menu table it then sits last in its section. */
  function listKept(): void {
    hud.removeParam("returning.kept");
    hud.removeParam("returning.forget");
    const kept = record.kept;
    if (!kept.length) return;
    hud.registerParam({
      id: "returning.kept",
      label: "kept worlds",
      type: "select",
      persist: false,
      value: "",
      options: [{ value: "", label: `${kept.length} kept` }, ...kept.map((k) => ({ value: k.id, label: `${k.name} · ${dayLabel(k.day)}` }))],
      onChange: (id) => {
        if (!id) return;
        open(id);
        hud.setParam("returning.kept", "", { silent: true }); // back to the count, ready for the next pick
      },
      ...PLACE,
    });
    hud.registerParam({ id: "returning.forget", label: "forget this kept world", type: "action", run: forget, ...PLACE });
  }
  listKept();

  const offKeys = [
    hud.registerShortcut({ key: keys.today.key, label: keys.today.label, run: (e) => void (e.repeat || openToday()) }),
    hud.registerShortcut({ key: keys.keep.key, label: keys.keep.label, run: (e) => void (e.repeat || keep()) }),
    hud.registerShortcut({
      key: keys.previous.key,
      label: keys.previous.label,
      run: (e) => void (e.repeat || step(e.shiftKey ? "forward" : "back")),
    }),
  ];

  // ---- arrival ----------------------------------------------------------------
  // Nothing has been drawn yet, so the scene is still the opening, even when a shared link's roll has just started.
  const opening = liveScene();
  const linked = parseRoll(address.hash);
  if (linked !== null) history.visit({ seed: linked });
  else if (opening) history.visit({ scene: cloneScene(opening) });

  /** The world left at the end of the last visit, as a history entry. */
  const leftBehind: WorldEntry | null =
    before?.left && usable(before.left.scene, app.behaviors) ? { scene: before.left.scene, seed: before.left.seed } : null;
  if (arrival.kind === "last" && leftBehind) {
    history.replace(leftBehind);
    show(leftBehind, true);
  } else if (arrival.kind === "today") {
    // The opening was never seen this time: the world left last time takes its place behind today's.
    if (leftBehind) history.replace(leftBehind);
    openToday(true);
  } else if (leftBehind) {
    const onScreen = linked !== null ? leftBehind.seed === linked : !!opening && sameWorld(leftBehind.scene!, opening);
    // Not in a streamed world, where a stored scene cannot be shown.
    if (!onScreen && opening) history.prepend(leftBehind);
  }

  if (before) {
    if (arrival.kind === "keep" && arrival.invite) {
      lines.push({
        id: "invite",
        title: "today's world is new",
        sub: touch ? "in the menu" : `press ${keys.today.key.toUpperCase()}`,
        holdMs: LINE_HOLD_MS,
        shown: () => void change((r) => (r.invited = today())),
      });
    }
    for (const item of unseenNews(record.news)) lines.push(newsLine(item, "news", true));
  }

  // ---- leaving: remember the world on screen for next time ---------------------
  const remember = (): void => {
    if (hud.busy) return; // a render job owns the world; whatever was left before it stands
    land(); // the page may never run another frame
    const snap = snapshotNow();
    if (snap) change((r) => (r.left = snap));
  };
  const onHide = (): void => {
    if (document.visibilityState === "hidden") remember();
  };
  // Phones often never fire pagehide; going hidden is the last event that can be relied on.
  if (typeof window !== "undefined") window.addEventListener("pagehide", remember);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onHide);

  return {
    arrival,
    get record() {
      return record;
    },
    today: () => openToday(),
    keep,
    forget,
    open,
    back: () => step("back"),
    forward: () => step("forward"),
    remember,
    update(dt) {
      framePlane = app.planes[0];
      sinceChange += dt;
      watchLanding(dt);
      if (!lines.length) return;
      const calm = !options.isOpening?.() && !hud.panelOpen && !hud.busy;
      calmFor = calm ? calmFor + dt : 0;
      if (!calm || calmFor < waitFor || sinceChange < AFTER_CHANGE || hintShowing()) return;
      const line = lines.shift()!;
      hud.announce(line.title, line.sub, line.holdMs);
      line.shown?.();
      calmFor = 0;
      waitFor = line.holdMs / 1000 + LINE_GAP;
    },
    dispose() {
      offRoll();
      offChange();
      offKeys.forEach((off) => off());
      for (const id of ["today", "previous", "keep", "news", "kept", "forget"]) hud.removeParam(`returning.${id}`);
      if (typeof window !== "undefined") window.removeEventListener("pagehide", remember);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onHide);
      lines = [];
      landing = null;
    },
  };
}

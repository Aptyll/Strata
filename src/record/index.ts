/**
 * Record: launch a record-scale render from the app, as one Esc-menu job or
 * from a URL. A thin wrapper around src/offline: renderJob does the batched,
 * checkpointed, resumable GPU work, gradeJob does the tone mapping, and
 * src/capture encodes clips. This file only builds the job, reports progress
 * through the HUD, saves the result, and prints an honest tally per frame.
 *
 * URL (all optional; ?record alone renders one 1 trillion particle 4K still):
 *   ?record                    start the record job as soon as the app is up (count from the menu, default 1T)
 *   ?record=1e12               particles per frame: also 250M, 10B, 1T
 *   &size=4k                   1080p, 1440p, 4k, 8k (default: the menu's capture resolution)
 *   &frames=1                  more than 1 renders a clip and encodes an MP4; or &seconds=10
 *   &shot=heroA                a hand-placed composition from src/offline (heroA, heroB, heroC) instead of the
 *                              cluster; it brings its own splat and weighting unless given below
 *   &fps=60  &sheets=1024  &seed=1
 *   &weighting=count           count (default): every particle adds exactly one unit; flux: far sheets dimmer
 *   &fresh=1                   discard a saved partial render of the same job and start over
 *
 * Frames are kept in the browser's private storage, one folder per job, so a
 * reload or a crash continues where it stopped: open the same URL again.
 * While a frame renders, a preview of it sharpens over the app every 15 s,
 * captioned with the GPU's own running tally.
 */
import type { Hud, JobHandle } from "../ux/hud/index.js";

/** The parts of the HUD this module uses. */
export type RecordHud = Pick<Hud, "registerJob" | "registerParam" | "getParam">;

/** Splat and weighting modes of src/offline's OfflineJob, repeated here so this file stays light. */
type SplatMode = "point" | "bilinear";
type Weighting = "count" | "flux";

const SIZES: Record<string, [number, number]> = {
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "4k": [3840, 2160],
  "8k": [7680, 4320],
};

const COUNTS = ["1M", "100M", "1B", "10B", "100B", "1T"];
/**
 * "cluster" is the trillion preset's field of sheets; the rest are the keys of
 * COMPOSITIONS in src/offline/core/compositions.ts, listed here so the menu
 * needs no import of the renderer. run.ts rejects a name it does not know.
 */
const SHOTS = ["cluster", "heroA", "heroB", "heroC"];

/** Accepts 1e12, 1_000_000, 250M, 10B, 1T. */
export function parseCount(v: string): number {
  const s = v.replace(/[_,\s]/g, "").toUpperCase();
  const mult = ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[s.slice(-1)];
  const n = mult ? Number(s.slice(0, -1)) * mult : Number(s);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${v}`);
  return Math.round(n);
}

export interface RecordSettings {
  particles: number;
  width: number;
  height: number;
  frames: number;
  fps: number;
  planes?: number;
  seed?: number;
  weighting?: Weighting;
  splat?: SplatMode;
  /** "cluster" (default) or a key of src/offline's COMPOSITIONS. */
  shot?: string;
}

export interface RecordOptions {
  hud: RecordHud;
  /** URL options; see the top of this file. Default: the page's query string. */
  query?: URLSearchParams;
}

/**
 * Adds "render record" to the capture section of the Esc menu, with a
 * particle-count setting. Returns the job handle; `start()` launches it.
 * The app should stop its own rendering while the job runs (hud `job` event).
 */
export function mountRecord({ hud, query = new URLSearchParams(location.search) }: RecordOptions): JobHandle {
  const group = "capture";
  // The count rides on ?record itself, so it can never reach the app's own ?particles (stored particles).
  const urlCount = query.get("record") || null;
  hud.registerParam({
    id: "record.particles", label: "record particles", group, type: "select",
    value: urlCount && COUNTS.includes(urlCount.toUpperCase()) ? urlCount.toUpperCase() : "1T",
    options: COUNTS,
  });
  hud.registerParam({
    id: "record.clip", label: "record a clip (else a still)", group, type: "toggle", value: false,
  });
  hud.registerParam({
    id: "record.shot", label: "record shot", group, type: "select",
    value: SHOTS.includes(query.get("shot") ?? "") ? query.get("shot")! : "cluster",
    options: SHOTS,
  });

  /** URL wins over the menu, so a shared link renders exactly what it says. */
  const settings = (): RecordSettings => {
    const q = query;
    const [sw, sh] = SIZES[String(q.get("size") ?? hud.getParam("capture.size") ?? "4k").toLowerCase()] ?? SIZES["4k"];
    const fps = q.has("fps") ? parseCount(q.get("fps")!) : Number(hud.getParam("capture.fps") ?? 60);
    const clip = q.has("frames") || q.has("seconds") || hud.getParam("record.clip") === true;
    const frames = q.has("frames")
      ? parseCount(q.get("frames")!)
      : clip
        ? Math.max(1, Math.round((q.has("seconds") ? Number(q.get("seconds")) : Number(hud.getParam("capture.seconds") ?? 10)) * fps))
        : 1;
    return {
      particles: parseCount(urlCount ?? String(hud.getParam("record.particles") ?? "1T")),
      width: q.has("width") ? parseCount(q.get("width")!) : sw,
      height: q.has("height") ? parseCount(q.get("height")!) : sh,
      frames,
      fps,
      planes: q.has("sheets") ? parseCount(q.get("sheets")!) : undefined,
      seed: q.has("seed") ? parseCount(q.get("seed")!) : undefined,
      weighting: (q.get("weighting") as Weighting | null) ?? undefined,
      splat: (q.get("splat") as SplatMode | null) ?? undefined,
      shot: q.get("shot") ?? String(hud.getParam("record.shot") ?? "cluster"),
    };
  };

  return hud.registerJob({
    id: "record",
    label: "render record",
    group,
    async run(ctx) {
      // The renderer, grade and encoder load on first use, not at app boot.
      const { runRecord } = await import("./run");
      return runRecord(settings(), ctx, { fresh: query.get("fresh") === "1" });
    },
  });
}

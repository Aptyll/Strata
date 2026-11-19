/**
 * The perf HUD's place in the Esc menu: three blocks on the perf page
 * (view.ts) and a handful of facts in the summary header. `paint(snapshot)`
 * writes one PerfSnapshot into all of them.
 *
 * The app's sampler (index.ts) and the demo page both go through here, so the
 * demo shows exactly what the app shows.
 *
 * Header facts, in the order they sit after the frame rate:
 *
 *   simulating   particles stepped this frame; reads "paused" when nothing is
 *                being stepped, where a stale count would be a false claim
 *   per second   simulating x frame rate
 *   in frame     particles the GPU counted inside the picture
 *   gpu load     GPU time as a share of the frame: the headroom that a frame
 *                rate capped by the display hides
 *   1% low       the slow frames an average frame rate hides
 */
import { formatCount, formatExact, type Hud } from "../hud/index.js";
import { boundMark, formatFps, formatMs, formatShare, gpuLoad, particlesPerSecond, type PerfSnapshot } from "./model";
import { createPerfViews, type PerfViewOptions } from "./view";

/** The parts of the HUD the menu side uses. */
export type PerfMenuHost = Pick<Hud, "registerView" | "removeView" | "setFact">;

export interface PerfMenu {
  paint(snapshot: PerfSnapshot): void;
  /** Takes the blocks out of the menu and gives the header's own facts back. */
  dispose(): void;
}

/** Menu sections on the perf page, one block each. */
const SECTIONS = ["timing", "particles", "gpu"] as const;
const FACTS = ["particles", "perSecond", "inFrame", "gpu", "low"] as const;

export function attachPerfMenu(hud: PerfMenuHost, options: PerfViewOptions = {}): PerfMenu {
  const views = createPerfViews(options);
  for (const name of SECTIONS) hud.registerView({ id: `perf.${name}`, group: name, page: "perf", node: views[name] });

  const paintFacts = (s: PerfSnapshot) => {
    const { simulated, tally } = s.particles;
    const live = s.state === "live";
    if (s.state === "paused") {
      hud.setFact("particles", "paused", {
        label: "simulation",
        title: "The world is not being stepped right now: an offline render has the GPU, or the page was in the background.",
      });
    } else {
      hud.setFact("particles", formatCount(simulated), {
        label: "simulating",
        title:
          `${formatExact(simulated)} particles sent to the GPU's simulate pass for this frame. Each has stored state and is stepped: simulated, not procedural.` +
          (live ? "" : " An offline render is stepping the world frame by frame, not in real time."),
      });
    }

    const rate = particlesPerSecond(s);
    hud.setFact("perSecond", rate === null ? null : formatCount(rate), {
      label: "per second",
      title: "Particles stepped per second: simulating x the measured frame rate.",
      after: "particles",
    });

    const counted = s.state !== "paused" && tally && tally.inFrame !== null ? tally : null;
    hud.setFact("inFrame", counted ? boundMark(counted.bound) + formatCount(counted.inFrame!) : null, {
      label: "in frame",
      title: "Particles that landed inside the picture, counted on the GPU from the rasterizer's light buffer.",
      after: "perSecond",
    });

    const load = gpuLoad(s);
    hud.setFact("gpu", load === null ? null : formatShare(load), {
      label: "gpu load",
      title:
        load === null || !s.now
          ? ""
          : `${formatMs(s.gpu.totalMs)} of GPU time in a ${formatMs(s.now.avgMs)} frame, from GPU timestamps. Well under 100% there is room for more particles.`,
      after: "inFrame",
    });

    const recent = live ? s.recent : null;
    hud.setFact("low", recent ? formatFps(recent.low1Fps) : null, {
      label: "1% low",
      title: recent
        ? `The slowest hundredth of the last ${recent.frames} frames ran at ${formatMs(recent.low1Ms)} a frame. The slowest single one took ${formatMs(recent.worstMs)}.`
        : "",
      after: "gpu",
    });
  };

  return {
    paint(snapshot) {
      views.paint(snapshot);
      paintFacts(snapshot);
    },
    dispose() {
      for (const name of SECTIONS) hud.removeView(`perf.${name}`);
      for (const key of FACTS) hud.setFact(key, undefined);
    },
  };
}

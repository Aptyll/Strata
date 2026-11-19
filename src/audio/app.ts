/**
 * The soundtrack inside the Strata app. Off on every load. M or the "sound"
 * switch in the Esc menu turns it on, and the dice moves it to another chord.
 * For capture, recordingAudio(fps) gives the soundtrack of an offline video
 * rendered while the sound is on.
 *
 * Like src/capture/app.ts, it takes a small host object instead of the app's
 * internals. In src/main.ts:
 *
 *   const sound = mountSound({ app, hud: ui.hud, viewport: () => ({ width: graph.width, height: graph.height }), key: KEYS.sound });
 *   loop.hooks.push({ afterFrame: (f) => sound.frame(f) });
 *
 * afterFrame runs once the budget has set each plane's activeCount, which is
 * the count the soundtrack listens to.
 */
import type { AppContext } from "../core/contracts";
import type { Hud } from "../ux/hud/index.js";
import { createSoundtrack, type Soundtrack } from "./live";
import { createRecordingAudio } from "./offline";
import { SoundPerformance } from "./performance";
import { senseScene } from "./sense";
import type { RecordingAudio, SoundEvent } from "./types";

/** The parts of the HUD this module uses. */
export type SoundHud = Pick<Hud, "registerParam" | "registerShortcut" | "onRandomize" | "setParam" | "getParam" | "status">;

export interface SoundHost {
  app: Pick<AppContext, "camera" | "planes" | "getScene">;
  hud: SoundHud;
  /** Drawing buffer size in pixels, for the density estimate. */
  viewport(): { width: number; height: number };
  /** The on/off key, as the HUD names it (a row of KEYS in src/app/keys.ts). Default "m". */
  key?: { key: string; label?: string };
}

/** One rendered frame, as the app's frame loop reports it (FrameInfo in src/app/loop.ts). */
export interface FrameTick {
  /** Seconds simulated this frame. Stills render with 0, which is ignored. */
  dt: number;
  /** True while an offline render drives the loop: frames arrive at render speed, not in real time. */
  offline: boolean;
}

export interface MountedSound {
  readonly soundtrack: Soundtrack;
  /** Call once per rendered frame, live or offline, after the budget has set each plane's activeCount. */
  frame(tick: FrameTick): void;
  /**
   * For capture: the soundtrack of an offline render starting now. Every
   * frame rendered from here until the recording finishes or is cancelled
   * goes into it, and the live sound is held meanwhile. Null while the sound
   * is off, so a video only has sound when the person had it on.
   */
  recordingAudio(fps: number): RecordingAudio | null;
  dispose(): void;
}

export function mountSound(host: SoundHost): MountedSound {
  const { app, hud } = host;
  const seed = app.getScene().seed;
  const soundtrack = createSoundtrack({ seed });
  /** While an offline render runs, frames and rolls go to its performance instead of the live sound. */
  let recording: { perf: SoundPerformance; events: SoundEvent[] } | null = null;

  hud.registerParam({
    id: "sound", label: "sound", group: "sound", type: "toggle", value: false, persist: false,
    onChange: (on: boolean) => {
      soundtrack.setEnabled(on).catch((err) => {
        console.warn("sound: could not start audio", err);
        hud.setParam("sound", false, { silent: true });
        hud.status("sound is not available in this browser", 3000);
      });
    },
  });
  hud.registerParam({
    id: "sound.volume", label: "volume", group: "sound", type: "range", min: 0, max: 1, step: 0.01,
    value: soundtrack.volume, format: (v: number) => `${Math.round(v * 100)}%`,
    onChange: (v: number) => (soundtrack.volume = v),
  });
  const key = host.key ?? { key: "m" };
  hud.registerShortcut({
    key: key.key, label: key.label ?? "sound on or off",
    run: (e) => {
      if (e.repeat) return;
      const on = !hud.getParam("sound");
      hud.setParam("sound", on);
      hud.status(on ? "sound on" : "sound off", 1200);
    },
  });

  const unsubscribe = hud.onRandomize(({ seed: rollSeed }) => {
    const event: SoundEvent = { type: "roll", seed: rollSeed };
    if (recording) recording.events.push(event);
    else soundtrack.event(event);
  });

  const sense = () => {
    const { width, height } = host.viewport();
    return senseScene(app.planes, app.camera, width, height);
  };

  return {
    soundtrack,

    frame({ dt, offline }) {
      if (!(dt > 0)) return;
      if (recording) {
        recording.perf.push(sense(), recording.events);
        recording.events = [];
      } else if (!offline && soundtrack.enabled) {
        // Offline frames with no recording to feed (a still, a video without sound) come at
        // render speed, not in real time, so the live sound keeps its last state until they stop.
        soundtrack.frame(sense(), dt);
      }
    },

    recordingAudio(fps: number) {
      if (!soundtrack.enabled) return null;
      const rec = { perf: new SoundPerformance({ fps, seed, chord: soundtrack.chord }), events: [] as SoundEvent[] };
      recording = rec;
      soundtrack.hold(true); // the render's frames are not realtime, so the live sound waits
      return createRecordingAudio(rec.perf, {
        onDone: () => {
          if (recording === rec) recording = null;
          soundtrack.hold(false);
        },
      });
    },

    dispose() {
      unsubscribe();
      soundtrack.dispose();
    },
  };
}

/**
 * What the app does when the GPU lets it down. Without this a visitor just
 * sees a frozen or black page and no reason.
 *
 *   device lost          The driver reset, the GPU ran out of memory, the laptop
 *                        slept: the picture is frozen for good. A card says so
 *                        and the page restarts by itself, once. If the loss came
 *                        right after boot or a particle count change it restarts
 *                        with fewer particles. A second loss within two minutes
 *                        waits for the person, so it can never loop.
 *   world does not fit   A particle or plane count the GPU cannot hold (buffer
 *                        creation throws, or reports out of memory): the last
 *                        world that fit goes back, and one line says which count
 *                        failed.
 *   out of memory later  An out-of-memory error from anywhere else: one line.
 *   boot failure         startApp threw after the GPU came up: a card instead of
 *                        a black page (reportBootFailure).
 *
 * Validation errors are not shown to the visitor. The first few are kept for
 * "copy details", the text a visitor can paste into a bug report.
 *
 *   const recovery = mountRecovery({ device, scenes, notify, onLost });   // src/main.ts
 *   startApp(...).catch((err) => reportBootFailure(err, { particles }));
 */
import type { Scene } from "../../core/contracts";
import { showCard, type Card, type CardAction } from "./card";
import {
  RestartLog,
  fewer,
  planRestart,
  restartUrl,
  shortCount as formatCount,
  type RestartPlan,
  type RestartStorage,
} from "./policy";

/** The part of the scene host (src/app/scene.ts) recovery needs. */
export interface RecoveryScenes {
  /** The scene the world was last loaded from. */
  readonly current: Scene;
  /** Particle capacity of every live plane. */
  readonly total: number;
  /** Replaced by a guarded version that undoes a world the GPU cannot hold. */
  loadScene(next: Scene): void;
  /** The current scene with the live camera. */
  getScene(): Scene;
}

export interface RecoveryOptions {
  device: GPUDevice;
  scenes: RecoveryScenes;
  /** One quiet line (the HUD's status line) for what was put right without a restart. */
  notify?: (text: string) => void;
  /** Called once when the device is lost, so the frame loop can stop drawing. */
  onLost?: () => void;
  /** True while a long job (a record render) runs: then nothing restarts by itself. */
  busy?: () => boolean;
  /** Opens the restart address. Default: location.replace, or a reload when the address is unchanged. */
  restart?: (url: string) => void;
  /** Where the last restart is remembered. Default sessionStorage. */
  storage?: RestartStorage | null;
  /** Seconds the card counts down before restarting by itself. Default 5. */
  countdownSeconds?: number;
}

export interface Recovery {
  /** True once the device is lost. */
  readonly lost: boolean;
  /** The text "copy details" copies: what happened, on which GPU and browser. */
  details(): string;
  dispose(): void;
}

const exact = (n: number): string => Math.round(n).toLocaleString("en-US");
const firstLine = (text: unknown): string => String(text ?? "").split("\n")[0].slice(0, 300);
const sessionStore = (): RestartStorage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // storage blocked
  }
};
const defaultRestart = (url: string): void => {
  if (url === location.href) location.reload();
  else location.replace(url);
};

const KEEPS_HAPPENING =
  "If it keeps happening: close other tabs or apps that use the GPU, or update the browser and the graphics driver.";

/** What happened, where: plain text a visitor can paste into a bug report. Nothing is sent anywhere. */
function describe(what: string, device: GPUDevice | null, extra: string[] = []): string {
  const info = (device as { adapterInfo?: GPUAdapterInfo } | null)?.adapterInfo;
  const adapter = info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ") : "";
  return [
    "Strata GPU report",
    `when: ${new Date().toISOString()}`,
    `what: ${what}`,
    `adapter: ${adapter || "unknown"}`,
    ...extra,
    `window: ${innerWidth}x${innerHeight} at ${devicePixelRatio}x`,
    `browser: ${navigator.userAgent}`,
    `page: ${location.href}`,
  ].join("\n");
}

export function mountRecovery(options: RecoveryOptions): Recovery {
  const { device, scenes, notify } = options;
  const restart = options.restart ?? defaultRestart;
  const log = new RestartLog(options.storage === undefined ? sessionStore() : options.storage);
  const countdownSeconds = options.countdownSeconds ?? 5;

  const bootParticles = scenes.total;
  let loadChangedAt = performance.now();
  let lost = false;
  let leaving = false;
  let lostWhat = "";
  let card: Card | null = null;
  /** First lines of the GPU errors seen so far, newest last. */
  const errors: string[] = [];
  const remember = (line: string): void => {
    if (errors.length < 6 && !errors.includes(line)) errors.push(line);
  };

  const details = (): string =>
    describe(lostWhat || "running", device, [
      `particles: ${exact(scenes.total)} (opened with ${exact(bootParticles)})`,
      ...errors.map((e) => `error: ${e}`),
    ]);

  const go = (particles: number | null): void => {
    log.mark();
    restart(restartUrl(location.href, particles));
  };

  // ---- a world that does not fit: put the last one back ---------------------
  const load = scenes.loadScene.bind(scenes);
  let serial = 0;
  const wantedOf = (scene: Scene): number => scene.planes.reduce((n, p) => n + p.particleCount, 0);

  const failedFor = (cause: unknown): void => {
    remember(firstLine((cause as { message?: string })?.message ?? cause));
    lostWhat = "the world could not be rebuilt after a failed particle count";
    const less = fewer(Math.min(scenes.total || bootParticles, bootParticles));
    card = showCard({
      title: "The world could not be rebuilt",
      body: ["The GPU ran out of room and the last world would not go back either. A reload starts clean."],
      actions: [
        { label: "reload", run: () => go(null), primary: true },
        { label: `reload with ${formatCount(less)} particles`, run: () => go(less) },
      ],
      details,
    });
  };

  /** createBuffer and getMappedRange throw these when the memory is not there. */
  const isMemory = (err: unknown): boolean =>
    err instanceof RangeError || (err as { name?: string } | null)?.name === "OperationError";

  /** Put `before` back in place of a world that failed. `memory` is false when the failure was some other error. */
  const undo = (before: Scene, wanted: number, cause: unknown, memory: boolean): void => {
    console.warn("Strata: the new world failed to load, going back to the last one.", cause);
    remember(firstLine((cause as { message?: string })?.message ?? cause));
    serial++;
    device.pushErrorScope("out-of-memory");
    let threw: unknown = null;
    try {
      // getScene() hands out the live camera, so loading it leaves the view where it is.
      load({ ...before, camera: scenes.getScene().camera });
    } catch (err) {
      threw = err;
    }
    const scope = device.popErrorScope();
    if (threw) return failedFor(threw);
    scope.then((err) => err && !lost && failedFor(err.message), () => {});
    if (memory) {
      notify?.(`This GPU could not hold ${formatCount(wanted)} particles. Back to ${formatCount(scenes.total)}.`);
    }
  };

  scenes.loadScene = (next) => {
    if (lost) return; // nothing can be built on a lost device
    const before = scenes.current;
    const wanted = wantedOf(next);
    if (wanted !== scenes.total) loadChangedAt = performance.now();
    const mine = ++serial;
    device.pushErrorScope("out-of-memory");
    let threw: unknown = null;
    try {
      load(next);
    } catch (err) {
      threw = err;
    }
    const scope = device.popErrorScope();
    if (threw) {
      // The scene host is half built at this point (old planes gone, some new ones made).
      undo(before, wanted, threw, isMemory(threw));
      if (!isMemory(threw)) throw threw; // not ours to explain: the caller reports it as before
      return;
    }
    // The GPU answers a moment later. Only undo if no newer world replaced this one meanwhile.
    scope.then((err) => err && !lost && mine === serial && undo(before, wanted, err.message, true), () => {});
  };

  // ---- errors nobody asked about --------------------------------------------
  let lastMemoryNote = -Infinity;
  const onError = (event: Event): void => {
    const error = (event as GPUUncapturedErrorEvent).error;
    remember(firstLine(error?.message));
    if (!(error instanceof GPUOutOfMemoryError) || lost) return;
    const now = performance.now();
    if (now - lastMemoryNote < 15_000) return;
    lastMemoryNote = now;
    notify?.("The GPU ran out of memory. If the picture looks wrong, lower the particle count or reload.");
  };
  device.addEventListener("uncapturederror", onError);

  // ---- device lost ------------------------------------------------------------
  const describePlan = (plan: RestartPlan): string => {
    if (plan.particles !== null) return `Restarting with ${formatCount(plan.particles)} particles.`;
    if (plan.blameLoad && scenes.total > bootParticles) {
      return `Restarting with the ${formatCount(bootParticles)} particles the page opened with.`;
    }
    return "Restarting where the page opened.";
  };

  const showLost = (plan: RestartPlan): void => {
    const less = plan.particles ?? fewer(Math.min(scenes.total || bootParticles, bootParticles));
    const reload: CardAction = { label: "reload", run: () => go(null) };
    const reloadLess: CardAction = { label: `reload with ${formatCount(less)} particles`, run: () => go(less) };
    const cause = plan.blameLoad
      ? "The picture is frozen. This often means the GPU ran out of memory."
      : "The picture is frozen. A driver reset, sleep, or another heavy app can do this.";
    /** The choices without a countdown. */
    const manual = (body: string[]): void => {
      card = showCard({
        title: "The graphics device stopped",
        body,
        actions: [{ ...reload, primary: true }, reloadLess, { label: "hide", run: () => card?.close() }],
        details,
      });
    };

    if (plan.repeat) {
      card = showCard({
        title: "The graphics device stopped again",
        body: [
          "The page restarted a moment ago and the GPU stopped once more, so it will not restart by itself this time.",
        ],
        actions: [{ ...reloadLess, primary: true }, reload],
        hint: KEEPS_HAPPENING,
        details,
      });
    } else if (!plan.auto) {
      manual([cause, options.busy?.() ? "A render is still running. Reload when it is done." : "Reload to carry on."]);
    } else {
      card = showCard({
        title: "The graphics device stopped",
        body: [cause, describePlan(plan)],
        actions: [{ label: "restart now", run: () => go(plan.particles), primary: true }],
        countdown: {
          seconds: countdownSeconds,
          label: (s) => `restarting in ${s} s`,
          run: () => go(plan.particles),
          stopLabel: "stay here",
          // The person wants to look at the frozen frame: leave the choices up, without a clock.
          onStop: () => manual(["The picture stays frozen until the page reloads."]),
        },
        details,
      });
    }
  };

  const onLost = (info: GPUDeviceLostInfo): void => {
    if (lost || leaving) return;
    lost = true;
    lostWhat = `device lost (${info.reason ?? "unknown"}): ${firstLine(info.message)}`;
    try {
      options.onLost?.();
    } catch (err) {
      console.error(err);
    }
    showLost(
      planRestart({
        particles: scenes.total,
        bootParticles,
        sinceLoadChangeMs: performance.now() - loadChangedAt,
        sinceRestartMs: log.sinceLast(),
        // A reload would also end a record render that may still be running on a device of its own.
        mayAuto: log.works() && !options.busy?.(),
      }),
    );
  };
  void device.lost.then(onLost);
  // Leaving the page tears the device down too; that is not a failure.
  const onLeave = (): void => void (leaving = true);
  const onReturn = (): void => void (leaving = false); // back from the page cache
  addEventListener("pagehide", onLeave);
  addEventListener("pageshow", onReturn);

  return {
    get lost() {
      return lost;
    },
    details,
    dispose() {
      leaving = true;
      scenes.loadScene = load;
      device.removeEventListener("uncapturederror", onError);
      removeEventListener("pagehide", onLeave);
      removeEventListener("pageshow", onReturn);
      card?.close();
    },
  };
}

export interface BootFailureOptions {
  /** Particles the page tried to open with, to offer a lighter reload. */
  particles?: number;
  restart?: (url: string) => void;
}

/** startApp threw after the GPU came up: say so on a card instead of leaving a black page. */
export function reportBootFailure(error: unknown, options: BootFailureOptions = {}): Card {
  console.error(error);
  const restart = options.restart ?? defaultRestart;
  const message = firstLine((error as { message?: string })?.message ?? error);
  const actions: CardAction[] = [{ label: "reload", run: () => restart(location.href), primary: true }];
  if (options.particles) {
    const less = fewer(options.particles);
    actions.push({
      label: `reload with ${formatCount(less)} particles`,
      run: () => restart(restartUrl(location.href, less)),
    });
  }
  return showCard({
    title: "Strata could not start",
    body: ["Something failed while setting up the world on this GPU.", message],
    actions,
    hint: KEEPS_HAPPENING,
    details: () => describe(`boot failure: ${message}`, null, options.particles ? [`particles: ${exact(options.particles)}`] : []),
  });
}

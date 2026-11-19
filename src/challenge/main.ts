/**
 * Challenge mode page: how many particles can this GPU run?
 *
 * Opens with a small count and ramps it up until the frame rate falls to the
 * target, then confirms and shows the sustained count and the tier reached.
 * Runs on its own (src/challenge/index.html) or from the main page with
 * `?challenge`.
 *
 * URL options
 *   mode=sim|proc   simulated (stored state) or procedural (stateless). Default sim.
 *   fps=30          frame rate to hold. Default 30, the Tier 1 definition.
 *   res=1080p       1080p (default), 1440p, 4k, native, or WIDTHxHEIGHT.
 *   planes=24       number of sheets, up to 64.
 *   count=100M      run a fixed count instead of ramping (k, M, B suffixes).
 *   start=1M        first count of the ramp.
 *   wg=256          compute workgroup size, for experiments.
 *   seed=1
 *
 * Keys
 *   M mode   R restart the ramp   C copy the result as JSON   I hide all text
 *   - =  exposure
 *
 * The count at the top and its buttons (copy result, run again, back to the
 * world, details) are in viewer.ts; what they say is in share.ts.
 */

import { TOKENS } from "../core/contracts";
import type { PlaneDesc, Quat } from "../core/contracts";
import { attachCameraInput, cameraMath, createCamera } from "../ux/camera";
import { BYTES_PER_PARTICLE, ChallengeEngine } from "./engine";
import type { ChallengeMode } from "./engine";
import { Ramp } from "./ramp";
import { measureRefresh, screenLimit } from "./refresh";
import { ROW } from "./shaders";
import { describeGpu, mountChallengeViewer } from "./viewer";
import { adapterOptions } from "../gpu/adapter-options";
import { detectCapability, explainUnsupported } from "../ux/experience/capability";

/** The shared challenge target for realtime: simulated particles, 1080p, 30 fps. */
export const TIER1 = { particles: 100_000_000, fps: 30, width: 1920, height: 1080 } as const;

export interface ChallengeResult {
  mode: ChallengeMode;
  /** Particles processed every frame. In "sim" mode each one has stored state that is integrated every frame. */
  particles: number;
  /** Frames per second measured over GPU-completed frames. */
  fps: number;
  targetFps: number;
  /**
   * Frames per second a measured window had to reach. It is `targetFps`, or
   * 95 percent of `refreshHz` on a screen that refreshes at the target or
   * slower: such a screen can meet the target but never exceed it.
   */
  passFps: number;
  /** The screen's refresh rate as this page is paced, measured before the run. Null when it could not be measured. */
  refreshHz: number | null;
  /** True once the count passed several measurement windows in a row. */
  sustained: boolean;
  /** Why the ramp stopped: frame rate, a memory or mode ceiling, or the floor. */
  stoppedBy: string | null;
  /** Failed windows the ramp measured again instead of believing at once (noise it ignored). */
  remeasuredWindows: number;
  /** Times a confirming count's headroom reopened the ramp's search. */
  rampReopens: number;
  width: number;
  height: number;
  planes: number;
  particlesPerPixel: number;
  bytesPerParticle: number;
  /** GPU time of the compute pass, when the browser allows timestamp queries. */
  gpuMs: number | null;
  /** Particles the GPU itself counted in the latest checked frame (null before the first check). */
  gpuCount: number | null;
  /**
   * True when the GPU counted exactly `particles` in the latest checked frame
   * and no checked frame since the run started came out different. Required
   * for a tier: a frame whose work the browser dropped would otherwise look fast.
   */
  gpuCountVerified: boolean;
  tier1: boolean;
  /** What WebGPU says about the adapter, for example "nvidia turing". */
  adapter: string;
  /**
   * The card's name as people know it ("NVIDIA GeForce RTX 2070"), from WebGL
   * when that is the same vendor as the adapter, else the same words as
   * `adapter`. Empty when the browser names nothing.
   */
  gpuName: string;
  workgroupSize: number;
}

const parseCount = (text: string | null): number | null => {
  if (!text) return null;
  const m = /^([\d.]+)\s*([kmb]?)$/i.exec(text.trim());
  if (!m) return null;
  const scale = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  const n = Number(m[1]) * scale;
  return Number.isFinite(n) && n > 0 ? n : null;
};

const parseRes = (text: string | null): [number, number] | null => {
  const named: Record<string, [number, number]> = {
    "720p": [1280, 720],
    "1080p": [1920, 1080],
    "1440p": [2560, 1440],
    "4k": [3840, 2160],
  };
  const key = (text ?? "1080p").toLowerCase();
  if (key === "native") return null;
  if (named[key]) return named[key];
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : named["1080p"];
};

/** The default world: horizontal sheets stacked like strata, each turned a little. */
export const stackLayout = (planes: number, seed: number): PlaneDesc[] => {
  const { quatFromAxisAngle, quatMul } = cameraMath;
  const out: PlaneDesc[] = [];
  const height = 1.7;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < planes; i++) {
    const t = planes > 1 ? i / (planes - 1) - 0.5 : 0;
    // Deterministic small tilts so sheets cross each other's silhouettes.
    const tiltA = Math.sin(i * 12.9898 + seed * 78.233) * 0.07;
    const tiltB = Math.sin(i * 39.3467 + seed * 11.135) * 0.07;
    const flat = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
    const turn = quatFromAxisAngle([0, 1, 0], i * golden);
    const tilt = quatMul(quatFromAxisAngle([1, 0, 0], tiltA), quatFromAxisAngle([0, 0, 1], tiltB));
    const rotation = quatMul(tilt, quatMul(turn, flat)) as Quat;
    out.push({
      id: `challenge-${i}`,
      position: [0, t * height, 0],
      rotation,
      halfSize: [1, 1],
      behaviorId: "challenge",
      particleCount: 0,
      seed: ((i * 0.6180339887 + seed * 0.137) % 1 + 1) % 1,
    });
  }
  return out;
};

const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtShort = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${(n / 1e3).toFixed(0)}k`;

/**
 * Start Challenge mode on a canvas. Resolves once the first frame is running.
 * The latest result is also at `window.__strataChallenge`.
 */
export async function startChallenge(
  canvas: HTMLCanvasElement,
  query: URLSearchParams = new URLSearchParams(location.search),
): Promise<void> {
  const hud = document.createElement("div");
  Object.assign(hud.style, {
    position: "fixed",
    left: `${TOKENS.unit * 4}px`,
    bottom: `${TOKENS.unit * 4}px`,
    font: TOKENS.font,
    letterSpacing: TOKENS.letterSpacing,
    color: TOKENS.color.foreground,
    whiteSpace: "pre",
    pointerEvents: "none",
    userSelect: "none",
    textShadow: "0 0 4px #000, 0 0 2px #000",
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(hud);
  const say = (text: string) => {
    hud.textContent = text;
  };

  // How often this screen shows a frame. Measured while the GPU is being set up, used by the search below.
  const refreshing = measureRefresh();

  // The count block: the number, what it means, and buttons (viewer.ts).
  const viewer = mountChallengeViewer({ readout: hud, restart: () => restart() });
  /** No run is possible: say why in plain words, with the way back to the world. */
  const cannot = async (status?: "no-adapter" | "device-failed") => {
    const cap = await detectCapability();
    const why = explainUnsupported(status ? { ...cap, status } : cap);
    viewer.explain("challenge mode needs WebGPU", why.reason, why.action);
  };

  if (!navigator.gpu) return cannot();
  const adapter = await navigator.gpu.requestAdapter(adapterOptions());
  if (!adapter) return cannot("no-adapter");
  const features: GPUFeatureName[] = adapter.features.has("timestamp-query") ? ["timestamp-query"] : [];
  let device: GPUDevice;
  try {
    device = await adapter.requestDevice({ requiredFeatures: features });
  } catch (err) {
    console.warn(err);
    return cannot("device-failed");
  }
  const card = describeGpu(adapter, adapterOptions());
  const info = adapter.info;
  const adapterName = [info?.vendor, info?.architecture, info?.device, info?.description]
    .filter((s) => s)
    .join(" ") || "unknown adapter";

  const context = canvas.getContext("webgpu");
  if (!context) return cannot("device-failed");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  // Fixed drawing buffer, so a result means the same thing on every screen.
  const res = parseRes(query.get("res"));
  const sizeCanvas = () => {
    if (res) {
      canvas.width = res[0];
      canvas.height = res[1];
    } else {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    }
  };
  canvas.style.objectFit = "contain";
  canvas.style.background = TOKENS.color.background;
  sizeCanvas();

  const seed = Math.round(Number(query.get("seed")) || 1);
  const planeCount = Math.min(64, Math.max(1, Math.round(Number(query.get("planes")) || 24)));
  const targetFps = Math.max(1, Number(query.get("fps")) || TIER1.fps);
  const fixedCount = parseCount(query.get("count"));
  const startCount = parseCount(query.get("start")) ?? 1_048_576;

  const engine = new ChallengeEngine({
    device,
    width: canvas.width,
    height: canvas.height,
    planes: stackLayout(planeCount, seed),
    workgroupSize: Number(query.get("wg")) || undefined,
    seed,
  });
  engine.mode = query.get("mode") === "proc" ? "proc" : "sim";

  const camera = createCamera(
    { target: [0, 0, 0], yaw: 0.6, pitch: -0.52, distance: 3.7, fovY: (45 * Math.PI) / 180 },
    {
      near: 0.02,
      far: 200,
      minDistance: 0.3,
      maxDistance: 40,
      idle: { enabled: true, delay: 0, rampIn: 2, orbitRate: 0.09, swayPitch: 0.06, breathe: 0.05 },
    },
  );
  attachCameraInput(canvas, camera.rig, { observeResize: false });

  // ------------------------------------------------------------ ramp ----

  let ramp: Ramp | null = null;
  let requested = 0;
  let status = "";
  let fps = 0;
  let lost: string | null = null;
  let errorText = "";
  let hidden = false;

  // Measurement: frames are counted between two moments at which the GPU had
  // finished everything submitted so far, so a backlog cannot inflate the rate.
  let epoch = 0; // bumps whenever the current window must be thrown away
  let settle = 0; // frames to skip before opening a window
  let windowOpen = false;
  let windowClosing = false;
  let windowStart = 0;
  let windowFrames = 0;
  let busy = false; // a count change is being applied

  const invalidate = (skip = 4) => {
    epoch++;
    settle = skip;
    windowOpen = false;
    windowClosing = false;
  };

  const apply = (count: number) => {
    requested = count;
    busy = true;
    invalidate();
    const mine = epoch;
    engine.setCount(count).then(
      () => {
        busy = false;
        if (mine === epoch) invalidate();
      },
      (err) => {
        busy = false;
        errorText = String(err);
      },
    );
  };

  // A screen that refreshes at the target or slower (30 Hz: a phone in low
  // power mode, a browser's energy saver) can meet the target but never
  // exceed it, so "at least 30 fps" would pass or fail on measurement noise
  // and the search would end far too low. There, holding the frame rate means
  // showing every refresh, and the result says which screen it was measured on.
  const refreshHz = await refreshing;
  const { screenHz, passFps } = screenLimit(refreshHz, targetFps);

  const restart = () => {
    engine.resetCountCheck();
    if (fixedCount) {
      ramp = null;
      status = "fixed count";
      apply(fixedCount);
    } else {
      ramp = new Ramp({ targetFps: passFps, start: startCount, quantum: ROW, blind: screenHz !== null });
      status = "climbing";
      apply(ramp.count);
    }
    fps = 0;
  };

  const result = (): ChallengeResult => {
    const sustained = ramp ? ramp.phase === "hold" && ramp.record > 0 : false;
    const particles = sustained ? ramp!.record : engine.count;
    const rate = sustained ? ramp!.recordFps : fps;
    const gpuCountVerified =
      engine.countMismatches === 0 && engine.gpuCount === particles && engine.gpuCountExpected === particles;
    return {
      mode: engine.mode,
      particles,
      fps: Math.round(rate * 10) / 10,
      targetFps,
      passFps: Math.round(passFps * 10) / 10,
      refreshHz: refreshHz > 0 ? Math.round(refreshHz * 10) / 10 : null,
      sustained,
      stoppedBy: ramp?.stop ?? null,
      remeasuredWindows: ramp?.remeasured ?? 0,
      rampReopens: ramp?.reopens ?? 0,
      width: canvas.width,
      height: canvas.height,
      planes: engine.planeCount,
      particlesPerPixel: Math.round((particles / (canvas.width * canvas.height)) * 10) / 10,
      bytesPerParticle: engine.mode === "sim" ? BYTES_PER_PARTICLE : 0,
      gpuMs: engine.gpuMs === null ? null : Math.round(engine.gpuMs * 100) / 100,
      gpuCount: engine.gpuCount,
      gpuCountVerified,
      tier1:
        engine.mode === "sim" &&
        sustained &&
        gpuCountVerified &&
        particles >= TIER1.particles &&
        rate >= TIER1.fps &&
        canvas.width * canvas.height >= TIER1.width * TIER1.height,
      adapter: adapterName,
      gpuName: card.name,
      workgroupSize: engine.workgroupSize,
    };
  };

  const onWindow = (measured: number) => {
    fps = measured;
    if (!ramp || ramp.phase === "hold") return;
    const applied = engine.count;
    const ceiling = applied < requested || applied >= engine.maxCount;
    const next = ramp.report(measured, applied, ceiling);
    status =
      ramp.phase === "climb"
        ? "climbing"
        : ramp.phase === "refine"
          ? "narrowing"
          : ramp.phase === "confirm"
            ? "confirming"
            : ramp.record > 0
              ? "sustained"
              : `cannot hold ${targetFps} fps`;
    if (next !== applied) apply(next);
    else requested = next;
  };

  const render = () => {
    const r = result();
    (window as unknown as { __strataChallenge: ChallengeResult }).__strataChallenge = r;
    viewer.update({
      result: r,
      phase: ramp ? ramp.phase : "fixed",
      mismatches: engine.countMismatches,
      memoryLimited: engine.memoryLimited,
      software: card.software,
      screenHz,
      lost,
    });
    if (hud.style.display === "none") return;
    const lines: string[] = [];
    const modeName = r.mode === "sim" ? "simulated" : "procedural (stateless, not a tier entry)";
    lines.push(`CHALLENGE  ${modeName}`);
    lines.push(`${fmtInt(r.particles)} particles   ${fps ? fps.toFixed(1) : "--"} fps   ${r.particlesPerPixel} per pixel`);
    lines.push(
      engine.countMismatches > 0
        ? `GPU COUNT MISMATCH in ${engine.countMismatches} checked frame(s): some particles did not run, result invalid`
        : r.gpuCount === null
          ? "GPU count: waiting for the first checked frame"
          : `GPU count ${fmtInt(r.gpuCount)} particles in the last checked frame`,
    );
    const limit =
      r.stoppedBy === "ceiling"
        ? engine.memoryLimited
          ? "  (limited by GPU memory, not frame rate)"
          : "  (limited by the mode's cap, not frame rate)"
        : "";
    const running = ramp && ramp.phase !== "hold" ? `, trying ${fmtShort(engine.count)}` : "";
    lines.push(`${status}${running}${limit}`);
    if (r.mode === "sim") {
      const pct = Math.min(100, Math.floor((r.particles / TIER1.particles) * 100));
      const sized = canvas.width * canvas.height >= TIER1.width * TIER1.height;
      lines.push(
        r.tier1
          ? `TIER 1 REACHED  100M simulated at ${TIER1.fps}+ fps, 1080p`
          : `Tier 1 (100M at ${TIER1.fps} fps, 1080p): ${
              !sized
                ? "needs a 1080p or larger buffer"
                : targetFps < TIER1.fps
                  ? `needs fps=${TIER1.fps}`
                  : engine.countMismatches > 0
                    ? "refused, the GPU count did not match"
                    : `${pct}%`
            }`,
      );
    }
    const gpu = r.gpuMs === null ? "" : `GPU ${r.gpuMs.toFixed(1)} ms   `;
    const mem = r.mode === "sim" ? `${(engine.stateBytes / 2 ** 20).toFixed(0)} MB state   ` : "";
    lines.push(`${gpu}${mem}${canvas.width}x${canvas.height}   ${r.planes} sheets   target ${targetFps} fps`);
    if (screenHz) lines.push(`screen ${screenHz.toFixed(1)} Hz, at or under the target: a window passes at ${passFps.toFixed(1)} fps`);
    lines.push(card.name && card.name !== adapterName ? `${card.name}   (${adapterName})` : adapterName);
    if (lost) lines.push(`GPU device lost: ${lost}`);
    if (errorText) lines.push(errorText);
    lines.push("M mode   R restart   C copy JSON   I hide");
    say(lines.join("\n"));
  };

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.code) {
      case "KeyM":
        engine.mode = engine.mode === "sim" ? "proc" : "sim";
        restart();
        break;
      case "KeyR":
        restart();
        break;
      case "KeyC":
        void navigator.clipboard?.writeText(JSON.stringify(result(), null, 2));
        break;
      case "KeyI":
        viewer.toggle(); // the count block and the readout, for a clean picture
        break;
      case "Minus":
        engine.exposure *= 0.8;
        break;
      case "Equal":
        engine.exposure *= 1.25;
        break;
    }
  });
  document.addEventListener("visibilitychange", () => {
    hidden = document.hidden;
    invalidate(8);
  });
  window.addEventListener("resize", () => {
    if (res) return;
    sizeCanvas();
    engine.setSize(canvas.width, canvas.height);
    invalidate();
  });
  device.lost.then((e) => {
    lost = e.message || e.reason || "unknown reason";
    render();
  });
  device.addEventListener("uncapturederror", (e) => {
    errorText = (e as GPUUncapturedErrorEvent).error.message.split("\n")[0];
  });

  // ------------------------------------------------------------ loop ----

  let last = performance.now();
  let time = 0;
  let frame = 0;
  let lastHud = 0;

  const tick = (now: number) => {
    if (lost) return;
    const real = Math.min((now - last) / 1000, 0.1);
    last = now;
    // The simulation step is clamped, so a slow frame slows time instead of
    // taking a large unstable step.
    const dt = Math.min(real, 1 / 30);
    time += dt;

    camera.update(real);
    const viewProj = camera.viewProjection(canvas.width / canvas.height);

    const encoder = device.createCommandEncoder();
    engine.encode(encoder, { viewProj, time, dt, frame });
    engine.resolveToCanvas(encoder, context.getCurrentTexture().createView(), format);
    device.queue.submit([encoder.finish()]);
    engine.afterSubmit();
    frame++;

    if (!hidden && !busy) {
      if (windowOpen) {
        windowFrames++;
        if (!windowClosing && now - windowStart >= 1000 && windowFrames >= 8) {
          windowClosing = true;
          const mine = epoch;
          const frames = windowFrames;
          void device.queue.onSubmittedWorkDone().then(() => {
            if (mine !== epoch) return;
            const seconds = (performance.now() - windowStart) / 1000;
            invalidate(0);
            onWindow(frames / seconds);
          });
        }
      } else if (settle > 0) {
        settle--;
      } else if (settle === 0) {
        settle = -1; // waiting for the GPU to drain before the window opens
        const mine = epoch;
        void device.queue.onSubmittedWorkDone().then(() => {
          if (mine !== epoch) return;
          windowOpen = true;
          windowStart = performance.now();
          windowFrames = 0;
        });
      }
    }

    if (now - lastHud > 200) {
      lastHud = now;
      render();
    }
    requestAnimationFrame(tick);
  };

  restart();
  requestAnimationFrame(tick);
}

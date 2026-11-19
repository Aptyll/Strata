/**
 * The perf HUD's three blocks for the Esc menu's perf page, as plain DOM:
 *
 *   timing     frame time graph, pacing (average, 1% low, worst), script and GPU
 *              time, where the frame goes pass by pass, the governor, headroom
 *   particles  how many, and where each count comes from
 *   gpu        the adapter and what it allows
 *
 * `paint(snapshot)` writes a PerfSnapshot (model.ts) into them. It only
 * touches text that changed and skips blocks that are not on screen, so it is
 * cheap to call a few times a second. Nothing here reads the engine.
 *
 * A row is a name, a value and a short note (20 characters at most, so it
 * fits the menu). The longer explanation is the row's hover text.
 */
import { DESIGN } from "../design";
import { formatCount, formatExact } from "../hud/index.js";
import { SCALING_STAGES } from "./fit";
import {
  boundMark,
  formatBytes,
  formatFps,
  formatMs,
  formatShare,
  gpuLoad,
  particlesPerSecond,
  type PerfSnapshot,
} from "./model";
import { installPerfHudStyles } from "./styles";

export interface PerfViews {
  timing: HTMLElement;
  particles: HTMLElement;
  gpu: HTMLElement;
  paint(snapshot: PerfSnapshot): void;
}

export interface PerfViewOptions {
  /**
   * The GPU's product name, when the page can find one (webglRendererName in
   * gpuFacts.ts). Asked once, the first time the gpu block is on screen.
   */
  product?: () => string | null;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

/** One line: a name, a value, and a short note saying what the value is or where it comes from. */
interface Row {
  /** Shows the row with this value and note. `title` is the hover text. */
  set(value: string, note?: string, title?: string): void;
  hide(): void;
}

function createRow(parent: HTMLElement, name: string): Row {
  const row = el("div", "ph-row");
  const value = el("span", "ph-v");
  const note = el("span", "ph-n");
  row.append(el("span", "ph-k", name), value, note);
  parent.append(row);
  let shownValue = "";
  let shownNote = "";
  let shownTitle = "";
  return {
    set(v, n = "", title = "") {
      row.hidden = false;
      if (v !== shownValue) value.textContent = shownValue = v;
      if (n !== shownNote) note.textContent = shownNote = n;
      if (title !== shownTitle) row.title = shownTitle = title;
    },
    hide() {
      row.hidden = true;
    },
  };
}

/** One pass under the gpu line: its name, its milliseconds, and a hairline as long as its share of the slowest pass. */
interface PassRow {
  set(name: string, value: string, share: number, title: string): void;
  hide(): void;
}

function createPassRow(parent: HTMLElement): PassRow {
  const row = el("div", "ph-row ph-sub");
  // Name and value share one cell, so a long pass name takes the room a short value leaves.
  const pair = el("span", "ph-kv");
  const key = el("span", "ph-k");
  const value = el("span", "ph-v");
  const note = el("span", "ph-n");
  const meter = el("i", "ph-meter");
  note.append(meter);
  pair.append(key, value);
  row.append(pair, note);
  parent.append(row);
  let shownName = "";
  let shownValue = "";
  let shownTitle = "";
  let shownShare = "";
  return {
    set(name, v, share, title) {
      row.hidden = false;
      if (name !== shownName) key.textContent = shownName = name;
      if (v !== shownValue) value.textContent = shownValue = v;
      if (title !== shownTitle) row.title = shownTitle = title;
      const p = `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%`;
      if (p !== shownShare) meter.style.setProperty("--p", (shownShare = p));
    },
    hide() {
      row.hidden = true;
    },
  };
}

/** A name and free text, for adapter names and the like. Hidden while the text is empty. */
function createWideRow(parent: HTMLElement, name: string): { set(text: string | null, title?: string): void } {
  const row = el("div", "ph-row ph-wide");
  const value = el("span", "ph-v");
  row.append(el("span", "ph-k", name), value);
  parent.append(row);
  let shown: string | null = "";
  let shownTitle = "";
  return {
    set(text, title = "") {
      row.hidden = text === null || text === "";
      if (text !== shown) value.textContent = (shown = text) ?? "";
      if (title !== shownTitle) row.title = shownTitle = title;
    },
  };
}

/** A line of prose under the rows. Text inside `**` pairs is emphasised. */
function createNote(parent: HTMLElement): { set(text: string | null): void } {
  const note = el("div", "ph-note");
  note.hidden = true;
  parent.append(note);
  let shown: string | null = null;
  return {
    set(text) {
      if (text === shown) return;
      shown = text;
      note.hidden = !text;
      note.textContent = "";
      (text ?? "").split("**").forEach((part, i) => note.append(i % 2 ? el("b", undefined, part) : part));
    },
  };
}

const visible = (node: HTMLElement) => node.offsetParent !== null;

/** Frame time, frame by frame, newest at the right, with the target frame time as a dashed line. */
function drawGraph(canvas: HTMLCanvasElement, intervals: Float32Array, count: number, targetMs: number): void {
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (!w || !h) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const g = canvas.getContext("2d");
  if (!g) return;
  g.clearRect(0, 0, w, h);
  if (count < 2) return;
  let longest = 0;
  for (let i = 0; i < count; i++) longest = Math.max(longest, intervals[i]);
  // The target sits at half height or lower. A long hitch clips at the top edge instead of flattening the rest.
  const top = Math.min(targetMs * 4, Math.max(targetMs * 2, longest * 1.1));
  const y = (ms: number) => h - 1 - (Math.min(ms, top) / top) * (h - 2);
  g.strokeStyle = getComputedStyle(canvas).color || "#fff";
  g.lineWidth = dpr;
  // The target line is fainter than the measured one. A canvas cannot read a CSS token, so the level comes from DESIGN.
  g.globalAlpha = DESIGN.alpha.faint;
  g.setLineDash([2 * dpr, 3 * dpr]);
  g.beginPath();
  g.moveTo(0, y(targetMs));
  g.lineTo(w, y(targetMs));
  g.stroke();
  g.setLineDash([]);
  g.globalAlpha = 1;
  g.beginPath();
  const slots = intervals.length;
  const step = w / (slots - 1);
  for (let i = 0; i < count; i++) {
    const x = (slots - count + i) * step;
    if (i) g.lineTo(x, y(intervals[i]));
    else g.moveTo(x, y(intervals[i]));
  }
  g.stroke();
}

/** A particle count on one pixel: every digit while it is short, rounded once it is not. */
const formatPeak = (n: number) => (n < 100_000 ? formatExact(n) : formatCount(n));

export function createPerfViews(options: PerfViewOptions = {}): PerfViews {
  installPerfHudStyles();

  // ---- timing ------------------------------------------------------------
  const timing = el("div", "ph ph-timing");
  const graph = el("canvas", "ph-graph");
  graph.setAttribute("role", "img");
  graph.setAttribute("aria-label", "Time of each frame over the last few seconds, with the target as a dashed line");
  graph.title = "Time between frames, one point per frame, newest at the right. The dashed line is the target.";
  timing.append(graph);
  const frameRow = createRow(timing, "frame");
  const lowRow = createRow(timing, "1% low");
  const worstRow = createRow(timing, "worst");
  const scriptRow = createRow(timing, "script");
  const gpuRow = createRow(timing, "gpu");
  const bar = el("div", "ph-bar");
  bar.setAttribute("role", "img");
  const segments = [el("i"), el("i"), el("i")];
  bar.append(...segments);
  timing.append(bar);
  const passRows: PassRow[] = [];
  const passHost = el("div");
  timing.append(passHost);
  const governorRow = createRow(timing, "drawing");
  const fitNote = createNote(timing);

  const passRow = (i: number) => {
    while (passRows.length <= i) passRows.push(createPassRow(passHost));
    return passRows[i];
  };

  const paintTiming = (s: PerfSnapshot) => {
    const targetMs = 1000 / s.targetFps;
    graph.hidden = s.state !== "live";
    if (s.state === "live") drawGraph(graph, s.intervals, s.intervalCount, targetMs);

    if (s.state === "offline") {
      frameRow.set("offline", "render in progress", "An offline render is stepping the world frame by frame, as fast as it can and not in real time. Frame pacing means nothing until it ends.");
      for (const r of [lowRow, worstRow, scriptRow]) r.hide();
    } else if (s.state === "paused" || !s.now) {
      frameRow.set("paused", "nothing drawn lately", "No frame of the world was drawn lately: an offline render has the GPU, or the page was in the background.");
      for (const r of [lowRow, worstRow, scriptRow]) r.hide();
    } else {
      const r = s.recent ?? s.now;
      frameRow.set(formatMs(s.now.avgMs), formatFps(s.now.fps), "Average time between frames over the last second, and the frame rate that is.");
      lowRow.set(
        formatMs(r.low1Ms),
        `${formatFps(r.low1Fps)}, slowest 1%`,
        `The slowest hundredth of the last ${r.frames} frames, averaged. An average frame rate hides stutter; this number does not.`,
      );
      worstRow.set(formatMs(r.worstMs), "slowest in 5 s", "The single slowest frame of the last 5 seconds.");
      scriptRow.set(
        formatMs(s.now.cpuMs),
        "javascript a frame",
        `JavaScript time in the frame loop, from its first hook to its last. Slowest in the last 5 seconds: ${formatMs(r.cpuWorstMs)}. The browser's own work is not in it.`,
      );
    }

    const { gpu } = s;
    const load = gpuLoad(s);
    if (s.state === "paused") gpuRow.hide();
    else if (gpu.status === "unavailable") {
      gpuRow.set("-", "no gpu timestamps", "This browser does not offer GPU timestamps (the timestamp-query feature), so GPU time cannot be measured here.");
    } else if (gpu.status === "stopped") {
      gpuRow.set("-", "stopped after an error", "A GPU validation error arrived while passes were being timed, so timing was switched off for this session.");
    } else if (gpu.status === "waiting") {
      gpuRow.set("-", "measuring");
    } else {
      gpuRow.set(
        `${gpu.truncated ? ">" : ""}${formatMs(gpu.totalMs)}`,
        load === null ? "in passes, a frame" : `${formatShare(load)} of the frame`,
        "GPU time inside the frame's passes, from GPU timestamps, averaged over about a dozen frames. As a share of the frame: well under 100% the GPU has room, near 100% the GPU sets the frame rate.",
      );
    }

    const showPasses = gpu.status === "on" && s.state !== "paused";
    // Where the frame goes: per-particle work, then the rest; the empty part of the bar is headroom.
    bar.hidden = !showPasses || load === null;
    if (!bar.hidden && s.now) {
      let simulate = 0;
      let draw = 0;
      let rest = 0;
      for (const p of gpu.passes) {
        if (p.stage === "simulate") simulate += p.ms;
        else if (SCALING_STAGES.includes(p.stage)) draw += p.ms;
        else rest += p.ms;
      }
      const scale = 100 / Math.max(s.now.avgMs, gpu.totalMs);
      [simulate, draw, rest].forEach((ms, i) => (segments[i].style.width = `${(ms * scale).toFixed(2)}%`));
      const text = `GPU time in a ${formatMs(s.now.avgMs)} frame: simulate ${formatMs(simulate)}, draw ${formatMs(draw)}, the rest ${formatMs(rest)}. The empty part is headroom.`;
      if (bar.title !== text) {
        bar.title = text;
        bar.setAttribute("aria-label", text);
      }
    }
    let longest = 0;
    for (const p of gpu.passes) longest = Math.max(longest, p.ms);
    const shown = showPasses ? gpu.passes.length : 0;
    for (let i = 0; i < shown; i++) {
      const p = gpu.passes[i];
      passRow(i).set(
        p.name,
        formatMs(p.ms),
        longest > 0 ? p.ms / longest : 0,
        `${p.name}: ${p.stage} stage, ${p.gpuPasses} GPU ${p.gpuPasses === 1 ? "pass" : "passes"}. The line is its time next to the slowest pass.`,
      );
    }
    for (let i = shown; i < passRows.length; i++) passRows[i].hide();

    if (s.governor === null) governorRow.hide();
    else {
      governorRow.set(
        formatShare(s.governor),
        `to hold ${formatFps(s.targetFps)}`,
        '"Hold frame rate" is on: the governor multiplies every sheet\'s particle count by this to keep the target frame rate.',
      );
    }

    fitNote.set(
      s.fit === null || s.state !== "live"
        ? null
        : `room for about **${formatCount(s.fit)}** particles at ${formatFps(s.targetFps)}, estimated from gpu time`,
    );
  };

  // ---- particles ---------------------------------------------------------
  const particles = el("div", "ph ph-particles");
  const simulatedRow = createRow(particles, "simulated");
  const inFrameRow = createRow(particles, "in frame");
  const rateRow = createRow(particles, "per second");
  const perPixelRow = createRow(particles, "per pixel");
  const litRow = createRow(particles, "lit pixels");
  const peakRow = createRow(particles, "densest");
  const storedRow = createRow(particles, "stored");

  const paintParticles = (s: PerfSnapshot) => {
    const p = s.particles;
    const pixels = p.width * p.height;
    if (s.state === "paused") {
      simulatedRow.set("paused", "not being stepped", "The world is not being stepped right now: an offline render has the GPU, or the page was in the background.");
    } else {
      simulatedRow.set(
        formatCount(p.simulated),
        s.state === "offline" ? "per offline frame" : "stepped this frame",
        `${formatExact(p.simulated)} particles were sent to the GPU's simulate pass for this frame. Each has stored state and is stepped: simulated, not procedural.`,
      );
    }
    const rate = particlesPerSecond(s);
    if (rate === null) rateRow.hide();
    else rateRow.set(formatCount(rate), "simulated x fps", "Particles stepped per second: the simulated count times the measured frame rate.");

    const t = s.state === "paused" ? null : p.tally;
    if (!p.countable) {
      inFrameRow.set("-", "no gpu count here", "This renderer blends points and keeps no per-pixel count. The compute rasterizer (render: compute) does.");
      for (const r of [perPixelRow, litRow, peakRow]) r.hide();
    } else if (!t) {
      inFrameRow.set("-", s.state === "paused" ? "" : "counting");
      for (const r of [perPixelRow, litRow, peakRow]) r.hide();
    } else {
      const mark = boundMark(t.bound);
      if (t.inFrame === null) {
        inFrameRow.set("-", "depth cues are on", "With depth cues on, each particle adds a different amount of light, so the light in the picture is not a particle count.");
        perPixelRow.hide();
      } else {
        const exact = formatExact(t.inFrame);
        inFrameRow.set(
          mark + formatCount(t.inFrame),
          t.bound === "exact" ? "counted on the gpu" : "gpu light sum",
          t.bound === "exact"
            ? `${exact} particles landed inside the picture. Counted on the GPU: the rasterizer's light buffer, summed, divided by the light one particle adds.`
            : t.bound === "about"
              ? `About ${exact} particles landed inside the picture: the rasterizer's light buffer, summed on the GPU. Sub-pixel splats round each particle's light at random, so this is right on average, not to the particle.`
              : `At least ${exact} particles landed inside the picture: the rasterizer's light buffer, summed on the GPU. Sheets are drawn at different brightness (fading in, out or with distance), so the light gives a floor, not the exact count.`,
        );
        perPixelRow.set(
          mark + (pixels > 0 ? (t.inFrame / pixels).toFixed(2) : "-"),
          `over ${formatCount(pixels)} pixels`,
          `Particles in frame divided by the ${formatExact(pixels)} pixels of the drawing buffer. Above 1 the picture holds more particles than pixels.`,
        );
      }
      litRow.set(
        pixels > 0 ? formatShare(t.litPixels / pixels) : "-",
        "hold a particle",
        `${formatExact(t.litPixels)} of ${formatExact(pixels)} pixels hold at least one particle's light. Counted on the GPU.`,
      );
      if (t.peak === null) peakRow.hide();
      else peakRow.set(mark + formatPeak(t.peak), "on one pixel", "The most particles on a single pixel, from the same GPU count.");
    }
    storedRow.set(
      formatCount(p.stored),
      `${formatBytes(p.stored * p.bytesPerParticle)} in gpu memory`,
      `${formatExact(p.stored)} particles held in GPU memory at ${p.bytesPerParticle} bytes each. Sheets out of view are stored but not stepped.`,
    );
  };

  // ---- gpu ---------------------------------------------------------------
  const gpu = el("div", "ph ph-gpu");
  const adapterRow = createWideRow(gpu, "adapter");
  const productRow = createWideRow(gpu, "webgl says");
  const timingRow = createWideRow(gpu, "pass timing");
  const sheetRow = createWideRow(gpu, "one sheet");
  const canvasRow = createWideRow(gpu, "canvas");
  const softwareNote = createNote(gpu);
  let product: string | null | undefined;

  const paintGpu = (s: PerfSnapshot) => {
    const f = s.facts;
    if (product === undefined) product = options.product?.() ?? null;
    adapterRow.set(f.adapter, "The adapter WebGPU runs on, as the browser names it: vendor and architecture.");
    productRow.set(product, "The GPU's product name as this browser's WebGL reports it. On a machine with two GPUs, WebGL and WebGPU can be on different ones.");
    timingRow.set(
      s.gpu.status === "unavailable" ? "not offered here" : s.gpu.status === "stopped" ? "stopped after an error" : "gpu timestamps",
      "Per-pass GPU time needs the timestamp-query feature. Chrome rounds timestamps to 0.1 ms, so the numbers are averages.",
    );
    sheetRow.set(
      `up to ${formatCount(f.maxSheetParticles)} particles`,
      `One sheet is one GPU buffer. The largest this GPU binds is ${formatBytes(Math.min(f.maxBufferBytes, f.maxBindingBytes))}, which at ${s.particles.bytesPerParticle} bytes each is ${formatExact(f.maxSheetParticles)} particles.`,
    );
    canvasRow.set(`${s.particles.width}x${s.particles.height} ${s.canvasFormat}`, "The drawing buffer's size in pixels and its format.");
    softwareNote.set(f.software ? "software renderer: no speed number here means anything" : null);
  };

  return {
    timing,
    particles,
    gpu,
    paint(snapshot) {
      if (visible(timing)) paintTiming(snapshot);
      if (visible(particles)) paintParticles(snapshot);
      if (visible(gpu)) paintGpu(snapshot);
    },
  };
}

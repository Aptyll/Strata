/**
 * Standalone page for the soundtrack: a pretend scene with sliders, and
 * offline renders to WAV. No WebGPU needed.
 */
import {
  CHORDS,
  VOICES,
  compose,
  createSoundtrack,
  densityOf,
  encodeWav,
  ladderScore,
  measureLoudness,
  renderPerformance,
  renderScore,
  type SoundFrame,
  type SoundScore,
} from "..";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

const soundtrack = createSoundtrack({ seed: 1 });
const power = $<HTMLButtonElement>("power");
const ladderButton = $<HTMLButtonElement>("ladder");
const status = $("status");
const voices = $("voices");
const dots = Array.from({ length: VOICES }, () => voices.appendChild(document.createElement("i")));

const count = (n: number) =>
  n >= 1e12 ? `${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));

power.addEventListener("click", () => {
  const on = !soundtrack.enabled;
  power.setAttribute("aria-pressed", String(on));
  power.textContent = on ? "sound on" : "sound off";
  soundtrack.setEnabled(on).catch((err) => (status.textContent = `audio failed: ${err}`));
});
$("roll").addEventListener("click", () => soundtrack.event({ type: "roll", seed: (Math.random() * 2 ** 32) >>> 0 }));
$("accent").addEventListener("click", () => soundtrack.event({ type: "accent" }));

// The climb: 1M to 1T in log space over 60 seconds, like the video.
let climb: number | null = null;
ladderButton.addEventListener("click", () => {
  climb = climb === null ? 0 : null;
  ladderButton.setAttribute("aria-pressed", String(climb !== null));
});

let yaw = 0.6;
let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (climb !== null) {
    climb += dt;
    input("particles").value = String(Math.min(12, 6 + (6 * climb) / 60));
    if (climb >= 60) {
      climb = null;
      ladderButton.setAttribute("aria-pressed", "false");
    }
  }
  const particles = Math.pow(10, Number(input("particles").value));
  const fill = Number(input("fill").value);
  if (input("auto-density").checked) input("density").value = String(densityOf(particles / Math.max(1, fill * 1920 * 1080)));
  const density = Number(input("density").value);
  const orbit = Number(input("orbit").value);
  yaw += orbit * dt;
  const frame: SoundFrame = { particles, fill, density, yaw, pitch: -0.35, distance: 10 * Math.pow(2, Number(input("zoom").value)) };
  soundtrack.frame(frame, dt);

  $("particles-out").textContent = count(particles);
  $("fill-out").textContent = fill.toFixed(2);
  $("density-out").textContent = density.toFixed(2);
  $("orbit-out").textContent = `${orbit.toFixed(2)} rad/s`;
  $("zoom-out").textContent = `${Number(input("zoom").value) > 0 ? "out" : "in"} ${Math.abs(Number(input("zoom").value)).toFixed(1)}`;
  const controls = soundtrack.controls;
  dots.forEach((dot, v) => (dot.style.opacity = String(0.08 + 0.9 * Math.min(1, (controls?.level[v] ?? 0) * 1.6))));
  $("chord").textContent = CHORDS[soundtrack.chord].name;
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function renderToWav(score: SoundScore, name: string): Promise<void> {
  const seconds = score.frames.length / score.fps;
  status.textContent = `rendering ${seconds.toFixed(1)} s`;
  const started = performance.now();
  const buffer = await renderScore(score, { onProgress: (f) => (status.textContent = `rendering ${Math.round(f * 100)}%`) });
  const elapsed = (performance.now() - started) / 1000;
  const { integrated, peak } = measureLoudness([buffer.getChannelData(0), buffer.getChannelData(1)], buffer.sampleRate);
  download(encodeWav(buffer), name);
  status.textContent =
    `${seconds.toFixed(1)} s rendered in ${elapsed.toFixed(1)} s (${(seconds / elapsed).toFixed(0)}x realtime)\n` +
    `${integrated.toFixed(1)} LUFS, peak ${peak.toFixed(1)} dBFS`;
}

$("render").addEventListener("click", () => void renderToWav(ladderScore({ seconds: 60 }), "strata-climb.wav"));
$("load").addEventListener("click", () => input("file").click());
input("file").addEventListener("change", async () => {
  const file = input("file").files?.[0];
  if (!file) return;
  try {
    const score = JSON.parse(await file.text()) as SoundScore;
    if (score.version !== 1 || !Array.isArray(score.frames) || !(score.fps > 0)) throw new Error("not a version 1 SoundScore");
    await renderToWav({ ...score, events: score.events ?? [] }, file.name.replace(/\.json$/i, "") + ".wav");
  } catch (err) {
    status.textContent = `could not render ${file.name}: ${(err as Error).message}`;
  }
});

/** Hooks for a headless browser: render a preview, and check that chunked renders join without a seam. */
async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
(window as unknown as { __soundDemo: unknown }).__soundDemo = {
  async preview(seconds = 60) {
    const started = performance.now();
    const buffer = await renderScore(ladderScore({ seconds }));
    const ms = performance.now() - started;
    const loudness = measureLoudness([buffer.getChannelData(0), buffer.getChannelData(1)], buffer.sampleRate);
    return { wav: await toBase64(encodeWav(buffer)), ms, loudness };
  },
  async seam(seconds = 40, chunkSeconds = 7) {
    const perf = compose(ladderScore({ seconds }));
    const whole = await renderPerformance(perf, { chunkSeconds: seconds });
    const pieces = await renderPerformance(perf, { chunkSeconds });
    let maxDiff = 0;
    let maxAt = 0;
    for (let ch = 0; ch < 2; ch++) {
      const a = whole.getChannelData(ch);
      const b = pieces.getChannelData(ch);
      for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > maxDiff) [maxDiff, maxAt] = [d, i];
      }
    }
    return { maxDiff, maxAtSeconds: maxAt / whole.sampleRate };
  },
};

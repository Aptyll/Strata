/**
 * Color life demo: one wrapping sheet of particles whose color is their
 * species, and species attract or repel each other by a rolled rule matrix.
 *
 * URL: ?n=1000000 particles, ?grid=<cells per side>, ?species=2..8,
 *      ?style=random|symmetric|chase|cells, #r=<seed> (shareable roll).
 * Keys: R roll new rules (the dice), S more species, Shift+S fewer,
 *       X scatter again, Space pause, M hide/show the rule matrix,
 *       [ ] exposure, 0 reset view. Drag to pan, wheel to zoom.
 *
 * The particle count on screen is the GPU's own tally (particles binned by
 * the grid sort this frame), read back twice a second.
 */

import { ColorLifeEngine } from "../engine";
import { clampSpecies, newSeed, rollRules, RULE_STYLES, type ColorRules, type RuleStyle } from "../rules";

const canvas = document.getElementById("view") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const rulesEl = document.getElementById("rules") as HTMLDivElement;

const q = new URLSearchParams(location.search);
const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);

function seedFromHash(): number | undefined {
  const m = /r=(\d+)/.exec(location.hash);
  return m ? Number(m[1]) >>> 0 : undefined;
}

function fail(msg: string): never {
  hud.textContent = msg;
  hud.style.color = "#c66";
  throw new Error(msg);
}

async function main(): Promise<void> {
  if (!navigator.gpu) fail("WebGPU is not available in this browser.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) fail("No WebGPU adapter found.");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  });
  device.lost.then((info) => fail(`WebGPU device lost: ${info.message}`));
  const context = canvas.getContext("webgpu");
  if (!context) fail("Could not create a WebGPU canvas context.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  const engine = new ColorLifeEngine(device, format, { count: num("n") ?? 1_000_000, grid: num("grid") });

  const styleArg = q.get("style") as RuleStyle | null;
  let style: RuleStyle | undefined = styleArg && RULE_STYLES.includes(styleArg) ? styleArg : undefined;
  let species: number | undefined = num("species") !== undefined ? clampSpecies(num("species")!) : undefined;
  let rules: ColorRules;

  const apply = (seed: number) => {
    rules = rollRules(seed, { species, style });
    engine.setRules(rules);
    history.replaceState(null, "", `${location.pathname}${location.search}#r=${rules.seed}`);
    drawRules();
  };

  // The rule matrix as a small grid: row = who feels it, column = who causes it.
  // Green pulls, red pushes. Color dots head the rows and columns.
  let showRules = true;
  const css = (rgb: Float32Array, i: number) =>
    `rgb(${[0, 1, 2].map((c) => Math.round(255 * Math.min(1, rgb[i * 4 + c]))).join(",")})`;
  function drawRules(): void {
    rulesEl.replaceChildren();
    rulesEl.style.display = showRules ? "grid" : "none";
    const n = rules.species;
    rulesEl.style.gridTemplateColumns = `repeat(${n + 1}, 12px)`;
    const cell = (cls: string, bg: string, title = "") => {
      const s = document.createElement("span");
      s.className = cls;
      s.style.background = bg;
      if (title) s.title = title;
      rulesEl.append(s);
    };
    cell("", "transparent");
    for (let b = 0; b < n; b++) cell("dot", css(rules.palette, b));
    for (let a = 0; a < n; a++) {
      cell("dot", css(rules.palette, a));
      for (let b = 0; b < n; b++) {
        const v = rules.matrix[a * 8 + b];
        const k = Math.round(Math.abs(v) * 200 + 30);
        cell("", v >= 0 ? `rgb(20,${k},40)` : `rgb(${k},20,30)`, v.toFixed(2));
      }
    }
  }

  apply(seedFromHash() ?? newSeed());
  window.addEventListener("hashchange", () => {
    const s = seedFromHash();
    if (s !== undefined && s !== rules.seed) apply(s);
  });

  // View: the sheet is [-1, 1]^2; zoom 1 fits it to the short side of the window.
  let cx = 0;
  let cy = 0;
  let zoom = 1;
  let exposureBias = 1;
  let paused = false;

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  resize();
  window.addEventListener("resize", resize);

  const scale = (): [number, number] => {
    const s = Math.min(canvas.width, canvas.height);
    return [(zoom * s) / canvas.width, (zoom * s) / canvas.height];
  };

  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", () => (drag = null));
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [sx, sy] = scale();
    cx -= ((e.clientX - drag.x) / canvas.clientWidth) * (2 / sx);
    cy += ((e.clientY - drag.y) / canvas.clientHeight) * (2 / sy);
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [sx, sy] = scale();
      // Keep the point under the cursor fixed.
      const ndcX = (e.clientX / canvas.clientWidth) * 2 - 1;
      const ndcY = 1 - (e.clientY / canvas.clientHeight) * 2;
      const wx = cx + ndcX / sx;
      const wy = cy + ndcY / sy;
      zoom = Math.max(0.25, Math.min(400, zoom * Math.exp(-e.deltaY * 0.0015)));
      const [nx, ny] = scale();
      cx = wx - ndcX / nx;
      cy = wy - ndcY / ny;
    },
    { passive: false },
  );

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.code) {
      case "KeyR":
        apply(newSeed());
        break;
      case "KeyS":
        species = clampSpecies((species ?? rules.species) + (e.shiftKey ? -1 : 1));
        apply(newSeed());
        break;
      case "KeyX":
        engine.reset();
        break;
      case "Space":
        paused = !paused;
        e.preventDefault();
        break;
      case "KeyM":
        showRules = !showRules;
        drawRules();
        break;
      case "BracketLeft":
        exposureBias /= 1.25;
        break;
      case "BracketRight":
        exposureBias *= 1.25;
        break;
      case "Digit0":
        cx = cy = 0;
        zoom = 1;
        break;
    }
  });

  let tally: number | null = null;
  let last = performance.now();
  let fps = 0;
  let nextTally = 0;

  const frame = (now: number) => {
    const dt = (now - last) / 1000;
    last = now;
    fps = fps * 0.95 + (dt > 0 ? 1 / dt : 0) * 0.05;

    const encoder = device.createCommandEncoder();
    const reading = now >= nextTally;
    if (reading) {
      engine.requestTally();
      nextTally = now + 500;
    }
    if (!paused) engine.step(encoder, dt);

    // Exposure from the mean particles per pixel over the visible sheet, so a
    // million particles and ten million both land in the same tonal range.
    const sheetPx = Math.pow(Math.min(canvas.width, canvas.height) * zoom, 2);
    const perPixel = engine.count / sheetPx;
    const energy = Math.min(1, 4 / Math.max(perPixel, 1e-6));
    const exposure = (0.4 / Math.max(perPixel * energy, 0.15)) * exposureBias;
    engine.draw(encoder, context.getCurrentTexture().createView(), canvas.width, canvas.height, {
      center: [cx, cy],
      scale: scale(),
      energy,
      exposure,
    });
    device.queue.submit([encoder.finish()]);
    if (reading && !paused) {
      engine.readTally().then((n) => {
        if (n !== null) tally = n;
      });
    }

    const count = tally === null ? "counting" : `${tally.toLocaleString("en-US")} simulated (GPU count)`;
    hud.textContent =
      `color life  ${count}  ${rules.species} colors  ${rules.style}  seed ${rules.seed}  ${fps.toFixed(0)} fps\n` +
      `R roll   S / Shift+S colors   X scatter   Space pause   M rules   [ ] exposure   drag, wheel, 0 view`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  console.error(err);
  if (!hud.textContent) hud.textContent = String(err?.message ?? err);
});

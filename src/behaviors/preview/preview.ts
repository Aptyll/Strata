/**
 * Behavior preview page: one sheet, one behavior, sliders for its params.
 *
 *   npm run dev, then open /src/behaviors/preview/
 *   #b=<behavior id>&n=<particle count>&<param>=<value>... selects a setup.
 *
 * Drag to pan, wheel to zoom, space to pause, R to reset, H to hide the panel.
 */
import { TOKENS, type Behavior } from "../../core/contracts";
import { PreviewHarness } from "./harness";

const modules = import.meta.glob<{ default: Behavior }>("../*.behavior.ts", { eager: true });
const behaviors = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.id.localeCompare(b.id));

const COUNTS = [250_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000, 16_000_000, 32_000_000, 64_000_000];

const canvas = document.querySelector<HTMLCanvasElement>("#view")!;
const hash = new URLSearchParams(location.hash.slice(1));

const panel = document.createElement("div");
panel.style.cssText = `position:fixed;top:${TOKENS.unit * 4}px;left:${TOKENS.unit * 4}px;width:220px;
  color:${TOKENS.color.foreground};font:${TOKENS.font};letter-spacing:${TOKENS.letterSpacing};user-select:none;`;
document.body.append(panel);

const style = document.createElement("style");
style.textContent = `
  .pv-dim { opacity: ${TOKENS.opacityDim}; }
  .pv-row { display: flex; justify-content: space-between; margin-top: ${TOKENS.unit * 2}px; opacity: ${TOKENS.opacityStrong}; }
  .pv select, .pv input[type=range] { width: 100%; margin: 0; }
  .pv select, .pv button { background: #000; color: #fff; border: 1px solid rgba(255,255,255,${TOKENS.opacityDim});
    font: inherit; letter-spacing: inherit; padding: ${TOKENS.unit / 2}px ${TOKENS.unit}px; border-radius: 0; }
  .pv input[type=range] { appearance: none; height: 1px; background: rgba(255,255,255,${TOKENS.opacityDim}); margin: ${TOKENS.unit * 2}px 0 ${TOKENS.unit}px; }
  .pv input[type=range]::-webkit-slider-thumb { appearance: none; width: 3px; height: 11px; background: #fff; }
  .pv input[type=range]::-moz-range-thumb { width: 3px; height: 11px; background: #fff; border: 0; border-radius: 0; }
  .pv pre { white-space: pre-wrap; font: inherit; margin: ${TOKENS.unit * 2}px 0 0; }
`;
document.head.append(style);
panel.className = "pv";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  parent.append(node);
  return node;
}

function slider(
  parent: HTMLElement,
  label: string,
  spec: { min: number; max: number; step?: number },
  value: number,
  onInput: (v: number) => void,
): void {
  const row = el("div", parent);
  row.className = "pv-row";
  el("span", row, label);
  const readout = el("span", row, String(value));
  readout.className = "pv-dim";
  const input = el("input", parent);
  input.type = "range";
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step ?? (spec.max - spec.min) / 200);
  input.value = String(value);
  input.addEventListener("input", () => {
    readout.textContent = input.value;
    onInput(Number(input.value));
  });
}

async function main(): Promise<void> {
  const stats = el("div", panel, "starting");
  stats.className = "pv-dim";
  let harness: PreviewHarness;
  try {
    harness = await PreviewHarness.create(canvas);
  } catch (error) {
    stats.textContent = String(error instanceof Error ? error.message : error);
    return;
  }

  const behaviorSelect = el("select", panel);
  behaviorSelect.style.marginTop = `${TOKENS.unit * 2}px`;
  for (const b of behaviors) el("option", behaviorSelect, b.label ?? b.id).value = b.id;
  const countSelect = el("select", panel);
  countSelect.style.marginTop = `${TOKENS.unit}px`;
  for (const n of COUNTS) {
    if (n <= harness.maxParticles) el("option", countSelect, `${n.toLocaleString("en-US")} particles`).value = String(n);
  }
  const controls = el("div", panel);
  const errors = el("pre", panel);

  behaviorSelect.value = behaviors.some((b) => b.id === hash.get("b")) ? hash.get("b")! : behaviors[0]!.id;
  const wanted = Number(hash.get("n")) || 1_000_000;
  if (![...countSelect.options].some((o) => Number(o.value) === wanted)) {
    el("option", countSelect, `${wanted.toLocaleString("en-US")} particles`).value = String(wanted);
  }
  countSelect.value = String(wanted);

  async function load(useHash: boolean): Promise<void> {
    const behavior = behaviors.find((b) => b.id === behaviorSelect.value)!;
    const overrides: Record<string, number> = {};
    if (useHash) {
      for (const name of Object.keys(behavior.params)) {
        if (hash.has(name)) overrides[name] = Number(hash.get(name));
      }
    }
    const error = await harness.setBehavior(behavior, Number(countSelect.value), overrides);
    errors.textContent = error ?? "";
    controls.replaceChildren();
    if (error) return;
    for (const [name, spec] of Object.entries(behavior.params)) {
      slider(controls, spec.label ?? name, spec, harness.values[name]!, (v) => harness.setParam(name, v));
    }
    slider(controls, "exposure", { min: 0.02, max: 2, step: 0.01 }, harness.exposure, (v) => (harness.exposure = v));
    slider(controls, "time scale", { min: 0, max: 4, step: 0.05 }, harness.speed, (v) => (harness.speed = v));
    const reset = el("button", controls, "reset");
    reset.style.marginTop = `${TOKENS.unit * 3}px`;
    reset.addEventListener("click", () => harness.reset());
  }

  behaviorSelect.addEventListener("change", () => void load(false));
  countSelect.addEventListener("change", () => void load(false));
  if (hash.has("exposure")) harness.exposure = Number(hash.get("exposure"));
  await load(true);

  // Pan, zoom, keys.
  let dragging = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointerup", () => (dragging = false));
  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const unit = (harness.zoom * Math.min(canvas.clientWidth, canvas.clientHeight)) / 2;
    harness.center = [harness.center[0] - e.movementX / unit, harness.center[1] + e.movementY / unit];
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      harness.zoom = Math.min(200, Math.max(0.2, harness.zoom * Math.exp(-e.deltaY * 0.0015)));
    },
    { passive: false },
  );
  addEventListener("keydown", (e) => {
    if (e.key === " ") harness.paused = !harness.paused;
    if (e.key === "r") harness.reset();
    if (e.key === "h") panel.style.display = panel.style.display === "none" ? "" : "none";
  });
  if (hash.has("ui") && hash.get("ui") === "0") panel.style.display = "none";

  let last = performance.now();
  let fps = 0;
  let shown = 0;
  function frame(now: number): void {
    const scale = Math.min(devicePixelRatio, 2);
    const w = Math.round(canvas.clientWidth * scale);
    const h = Math.round(canvas.clientHeight * scale);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    harness.tick();
    const instant = 1000 / Math.max(1, now - last);
    fps = fps ? fps * 0.95 + instant * 0.05 : instant;
    last = now;
    if (now - shown > 250) {
      shown = now;
      stats.textContent = `${fps.toFixed(0)} fps  ${harness.count.toLocaleString("en-US")} particles`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();

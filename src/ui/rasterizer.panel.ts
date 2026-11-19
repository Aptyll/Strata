import { TOKENS, type AppContext, type UIPanel } from "../core/contracts";

const POINTS = "points";
const ATOMIC = "raster-atomic";

/** Exactly one rasterize pass runs: the point-list one or the compute one. */
function select(app: AppContext, atomic: boolean): void {
  const points = app.passes.find((p) => p.name === POINTS);
  const compute = app.passes.find((p) => p.name === ATOMIC);
  if (!points || !compute) return;
  points.enabled = !atomic;
  compute.enabled = atomic;
}

const isAtomic = (app: AppContext) => app.passes.find((p) => p.name === ATOMIC)?.enabled === true;

/**
 * Switches between the two rasterizers so they can be compared on the same
 * scene. ?raster=atomic starts with the compute rasterizer.
 */
const panel: UIPanel = {
  id: "rasterizer",
  title: "Rasterizer",
  mount(container, app) {
    if (new URLSearchParams(location.search).get("raster") === "atomic") select(app, true);

    const row = document.createElement("div");
    row.style.cursor = "pointer";
    row.style.userSelect = "none";
    const render = () => {
      const atomic = isAtomic(app);
      row.innerHTML = "";
      for (const [label, on] of [["points", !atomic], ["compute", atomic]] as const) {
        const span = document.createElement("span");
        span.textContent = label;
        span.style.opacity = String(on ? TOKENS.opacityStrong : TOKENS.opacityDim);
        span.style.marginRight = `${TOKENS.unit * 3}px`;
        row.appendChild(span);
      }
    };
    row.addEventListener("click", () => {
      select(app, !isAtomic(app));
      render();
    });
    container.appendChild(row);
    render();
  },
};

export default panel;

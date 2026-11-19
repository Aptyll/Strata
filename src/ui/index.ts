import { TOKENS, type AppContext, type UIPanel } from "../core/contracts";

// Every `*.panel.ts` file in this folder is registered automatically.
const modules = import.meta.glob<{ default: UIPanel }>("./*.panel.ts", { eager: true });
const panels = Object.keys(modules).sort().map((path) => modules[path].default);

/**
 * Mounts all panels in a column on the right. Hidden by default so the void
 * stays empty; Tab toggles it.
 */
export function mountPanels(app: AppContext): void {
  if (panels.length === 0) return;
  const host = document.createElement("div");
  host.id = "panels";
  Object.assign(host.style, {
    position: "fixed", right: "12px", top: "10px", bottom: "10px", width: "240px",
    overflowY: "auto", display: "none", font: TOKENS.font, letterSpacing: TOKENS.letterSpacing,
    color: TOKENS.color.foreground,
  });
  document.body.appendChild(host);

  for (const panel of panels) {
    const section = document.createElement("section");
    section.dataset.panel = panel.id;
    section.style.marginBottom = `${TOKENS.unit * 4}px`;
    const title = document.createElement("div");
    title.textContent = panel.title;
    title.style.opacity = String(TOKENS.opacityDim);
    title.style.marginBottom = `${TOKENS.unit}px`;
    const body = document.createElement("div");
    section.append(title, body);
    host.appendChild(section);
    panel.mount(body, app);
  }

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Tab") return;
    e.preventDefault();
    host.style.display = host.style.display === "none" ? "block" : "none";
  });
  setInterval(() => {
    if (host.style.display !== "none") for (const p of panels) p.update?.(app);
  }, 250);
}

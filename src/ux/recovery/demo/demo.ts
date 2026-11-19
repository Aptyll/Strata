/**
 * Recovery demo: every card and notice from src/ux/recovery, driven by a
 * stand-in device so it runs anywhere (no WebGPU). Restarts are logged, not done.
 */
import type { Scene } from "../../../core/contracts";
import { mountRecovery, reportBootFailure, type Recovery, type RecoveryScenes } from "../index";

const logEl = document.getElementById("log")!;
const log = (text: string): void => void (logEl.textContent = `${text}\n${logEl.textContent ?? ""}`);

/** The few GPUDevice members recovery touches. */
function standInDevice() {
  let lose: (info: GPUDeviceLostInfo) => void = () => {};
  const lost = new Promise<GPUDeviceLostInfo>((resolve) => (lose = resolve));
  const device = {
    lost,
    pushErrorScope: () => {},
    popErrorScope: () => Promise.resolve(null),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as GPUDevice, lose };
}

const sceneOf = (particles: number): Scene => ({
  version: 1,
  seed: 1,
  planes: [
    { id: "a", position: [0, 0, 0], rotation: [0, 0, 0, 1], halfSize: [1, 1], behaviorId: "flow", particleCount: particles, seed: 0.5 },
  ],
  camera: { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 4, fovY: 1 },
  render: { brightness: 1 },
});

/** A scene host whose GPU holds at most `limit` particles. */
function standInScenes(particles: number, limit: number): RecoveryScenes {
  let current = sceneOf(particles);
  const host: RecoveryScenes = {
    get current() {
      return current;
    },
    get total() {
      return current.planes.reduce((n, p) => n + p.particleCount, 0);
    },
    loadScene(next) {
      const wanted = next.planes.reduce((n, p) => n + p.particleCount, 0);
      if (wanted > limit) throw new RangeError(`createBuffer failed: ${wanted * 16} bytes is too large`);
      current = next;
    },
    getScene: () => current,
  };
  return host;
}

let live: Recovery | null = null;
/** Mount recovery on a fresh stand-in. `sinceRestartMs` seeds the restart log, as if the page had just restarted. */
function mount(opts: { particles?: number; sinceRestartMs?: number; storage?: boolean } = {}) {
  live?.dispose();
  const store = new Map<string, string>();
  if (opts.sinceRestartMs !== undefined) store.set("strata.recovery.restart", String(Date.now() - opts.sinceRestartMs));
  const { device, lose } = standInDevice();
  const scenes = standInScenes(opts.particles ?? 2_000_000, 32_000_000);
  live = mountRecovery({
    device,
    scenes,
    notify: (text) => log(`status line: ${text}`),
    onLost: () => log("frame loop told to stop"),
    restart: (url) => log(`restart -> ${url}`),
    storage:
      opts.storage === false
        ? null
        : { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
  });
  return { scenes, lose };
}

const demos: Record<string, () => void> = {
  "device lost soon after boot": () => mount().lose({ reason: "unknown", message: "The GPU process crashed." } as GPUDeviceLostInfo),
  "device lost again (just restarted)": () =>
    mount({ sinceRestartMs: 20_000 }).lose({ reason: "unknown", message: "The GPU process crashed." } as GPUDeviceLostInfo),
  "device lost, restarts cannot be remembered": () =>
    mount({ storage: false }).lose({ reason: "unknown", message: "Device removed." } as GPUDeviceLostInfo),
  "particle count that does not fit": () => {
    const { scenes } = mount({ particles: 16_000_000 });
    scenes.loadScene(sceneOf(64_000_000));
    log(`world holds ${scenes.total.toLocaleString("en-US")} particles after the failed load`);
  },
  "boot failure": () => {
    live?.dispose();
    reportBootFailure(new Error("createComputePipeline failed: shader did not compile"), {
      particles: 2_000_000,
      restart: (url) => log(`restart -> ${url}`),
    });
  },
};

const buttons = document.getElementById("buttons")!;
for (const [label, run] of Object.entries(demos)) {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", run);
  buttons.append(b);
}
// ?show=<index> opens one straight away, for screenshots.
const show = new URLSearchParams(location.search).get("show");
if (show !== null) Object.values(demos)[Number(show)]?.();

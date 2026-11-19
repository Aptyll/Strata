/**
 * Strata shared contracts.
 *
 * Every thread builds against these types. They are types only, except for
 * PASS_ORDER and TOKENS which are tiny constants. See docs/architecture.md.
 *
 * Rule of thumb for avoiding merge conflicts: add new files that implement
 * these interfaces (a behavior, a pass, a panel) instead of editing shared ones.
 * If a contract has to change, do it in its own small PR.
 */

// ---------------------------------------------------------------- math ----

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Quaternion, xyzw. */
export type Quat = [number, number, number, number];
/** Column-major 4x4, WebGPU clip space (depth 0..1). */
export type Mat4 = Float32Array;

// ------------------------------------------------------------ behaviors ----

/** One tunable float of a behavior. UI builds sliders from this. */
export interface ParamSpec {
  default: number;
  min: number;
  max: number;
  step?: number;
  label?: string;
}

/** A behavior may declare at most this many params (they share one uniform block). */
export const MAX_BEHAVIOR_PARAMS = 8;

/**
 * The 2D rule a plane's particles follow: a WGSL snippet that runs once per
 * particle per frame inside a compute shader. It must define
 *
 *   fn update(p: Particle, i: u32) -> Particle
 *
 * with `Particle { pos: vec2f, vel: vec2f }` in plane-local space, the sheet
 * spanning [-1, 1] on both axes. In scope: `globals.time`, `globals.dt`,
 * `globals.frame`, `plane.params.<name>`, `plane.seed`, `plane.count`, and the
 * helpers listed in docs/architecture.md (rand, noise2, outside, wrap, respawn).
 *
 * One behavior per file: src/behaviors/<id>.behavior.ts, default export.
 * Files matching that pattern are registered automatically.
 */
export interface Behavior {
  /** Unique, stable, kebab-case. Scenes refer to behaviors by this id. */
  id: string;
  label?: string;
  /** Up to MAX_BEHAVIOR_PARAMS params, exposed in WGSL as `plane.params.<name>`. */
  params: Record<string, ParamSpec>;
  /** WGSL defining `fn update(p: Particle, i: u32) -> Particle` (plus any helpers). */
  wgsl: string;
  /**
   * Optional CPU-side initial state. `out` has 4 floats per particle
   * (pos.x, pos.y, vel.x, vel.y). Default: uniform random positions at rest.
   */
  init?(out: Float32Array, count: number, random: () => number): void;
}

// --------------------------------------------------------------- planes ----

/** Serializable description of one sheet floating in the world. */
export interface PlaneDesc {
  /** Optional stable id, for UI selection and scene diffing. */
  id?: string;
  position: Vec3;
  rotation: Quat;
  /** Half extents in world units. Particles live in [-1, 1]^2 locally. */
  halfSize: Vec2;
  behaviorId: string;
  /** Maximum particles this plane can hold (its buffer capacity). */
  particleCount: number;
  /** In [0, 1). Makes two planes with the same behavior look different. */
  seed: number;
  /** Overrides for the behavior's param defaults. */
  params?: Record<string, number>;
}

/** Live GPU-side plane, owned by the simulation. */
export interface PlaneInstance {
  readonly desc: PlaneDesc;
  readonly behavior: Behavior;
  /** Buffer capacity in particles (== desc.particleCount). */
  readonly capacity: number;
  /** Particles simulated and drawn this frame, 0..capacity. Set by the ParticleBudget. */
  activeCount: number;
  /** 16 bytes per particle (pos.xy, vel.xy as f32). Usage: STORAGE | VERTEX | COPY_DST | COPY_SRC. */
  readonly particles: GPUBuffer;
  /** Plane uniform: model matrix, params, count, seed. */
  readonly uniform: GPUBuffer;
  /** group(1) for compute pipelines: uniform + read_write particle storage. */
  readonly simBindGroup: GPUBindGroup;
  /** group(1) for render pipelines: uniform only (bind `particles` as a vertex buffer). */
  readonly renderBindGroup: GPUBindGroup;
}

// ---------------------------------------------------------------- scene ----

export interface CameraState {
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number;
  /** Vertical field of view in radians. */
  fovY: number;
}

export interface RenderSettings {
  /** Light added per particle per pixel before tonemapping. */
  brightness: number;
}

/** Whole world as plain JSON. Loading the same scene gives the same world. */
export interface Scene {
  version: 1;
  name?: string;
  seed: number;
  planes: PlaneDesc[];
  camera: CameraState;
  render: RenderSettings;
}

// --------------------------------------------------------------- camera ----

export interface CameraController {
  state: CameraState;
  /** Advance inertia, input and any animation. Called once per frame. */
  update(dt: number): void;
  eye(): Vec3;
  viewProjection(aspect: number): Mat4;
}

// ---------------------------------------------------------- frame graph ----

/**
 * Stages run in this order every frame. Several passes may share a stage;
 * within a stage they run in registration order.
 *
 * simulate   step each plane's particles (compute)
 * interplane anything that couples planes or builds shared fields (compute)
 * rasterize  draw particles additively into the HDR target
 * depth      depth-aware effects on the HDR target (fog, focus, occlusion)
 * tonemap    HDR target to the canvas
 * ui         in-canvas overlays drawn on top of the tonemapped image
 * capture    read back or record the finished frame
 */
export const PASS_ORDER = ["simulate", "interplane", "rasterize", "depth", "tonemap", "ui", "capture"] as const;
export type PassStage = (typeof PASS_ORDER)[number];

/** Shared GPU state. Bind group 0 is always the Globals uniform. */
export interface GpuContext {
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  canvasFormat: GPUTextureFormat;
  /** Format of the additive accumulation target (rgba16float). */
  hdrFormat: GPUTextureFormat;
  layouts: {
    /** group(0): Globals uniform, visible to all stages. */
    globals: GPUBindGroupLayout;
    /** group(1) for compute: plane uniform + read_write particles. */
    planeSim: GPUBindGroupLayout;
    /** group(1) for render: plane uniform. */
    planeRender: GPUBindGroupLayout;
  };
  globalsBuffer: GPUBuffer;
  globalsBindGroup: GPUBindGroup;
}

/** Everything a pass may need for one frame. */
export interface FrameContext {
  gpu: GpuContext;
  encoder: GPUCommandEncoder;
  planes: readonly PlaneInstance[];
  camera: CameraController;
  /** Seconds since start, and seconds simulated this frame (clamped). */
  time: number;
  dt: number;
  frame: number;
  /** Drawing buffer size in pixels. */
  width: number;
  height: number;
  /** Additive float target. Cleared by the first rasterize pass. */
  hdrView: GPUTextureView;
  hdrTexture: GPUTexture;
  /** The canvas for this frame. Written by tonemap, then ui. */
  canvasView: GPUTextureView;
}

export interface Pass {
  /** Unique name, for toggling and debugging. */
  name: string;
  stage: PassStage;
  /** Disabled passes are skipped. Defaults to true. */
  enabled?: boolean;
  /** Called when the drawing buffer size changes, and once before the first frame. */
  resize?(gpu: GpuContext, width: number, height: number): void;
  /** Encode this pass' work into frame.encoder. */
  execute(frame: FrameContext): void;
  dispose?(): void;
}

// ------------------------------------------------------ particle budget ----

export interface BudgetPlaneInfo {
  capacity: number;
  /** World distance from the camera eye to the plane center. */
  distance: number;
  /** False when the plane is entirely outside the view frustum. */
  visible: boolean;
  /** Approximate fraction of the screen the plane covers, 0..1. */
  screenCoverage: number;
}

export interface BudgetInput {
  planes: readonly BudgetPlaneInfo[];
  /** Smoothed frames per second, and the target to hold. */
  fps: number;
  targetFps: number;
}

/**
 * Decides how many particles each plane simulates and draws this frame, so
 * the frame rate holds while the visible count stays as high as possible.
 */
export interface ParticleBudget {
  /** Returns activeCount per plane, same order as input.planes, each 0..capacity. */
  allocate(input: BudgetInput): number[];
}

// ------------------------------------------------------------------- ui ----

/** What UI code may touch. */
export interface AppContext {
  gpu: GpuContext;
  camera: CameraController;
  planes: readonly PlaneInstance[];
  behaviors: readonly Behavior[];
  passes: readonly Pass[];
  getScene(): Scene;
  /** Rebuild the world from a scene. */
  loadScene(scene: Scene): void;
  /** Push a plane's changed desc (transform, params) to the GPU. */
  updatePlane(plane: PlaneInstance): void;
  /** Smoothed frames per second and particles active this frame. */
  stats(): { fps: number; particles: number; planes: number };
  /**
   * Change render settings on the running world without rebuilding it.
   * Optional so UI can ship before an engine implements it: UI shows the
   * matching controls only when this exists.
   */
  setRender?(patch: Partial<RenderSettings>): void;
}

/** A DOM panel. One per file: src/ui/<id>.panel.ts, default export, auto-registered. */
export interface UIPanel {
  id: string;
  title: string;
  /** Build DOM inside `container`. May return a cleanup function. */
  mount(container: HTMLElement, app: AppContext): void | (() => void);
  /** Called a few times per second for live values. */
  update?(app: AppContext): void;
}

// -------------------------------------------------------- design tokens ----

/** The whole visual language: white on black, one font, two opacities, one easing. */
export const TOKENS = {
  color: { background: "#000", foreground: "#fff" },
  font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  letterSpacing: "0.04em",
  /** Primary text and active controls. */
  opacityStrong: 0.9,
  /** Secondary text, idle controls, hairlines. */
  opacityDim: 0.45,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  durationMs: 180,
  /** Spacing unit in px. Use multiples. */
  unit: 4,
} as const;

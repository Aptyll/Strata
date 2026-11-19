/**
 * Standalone demo for interplane crossing. It fakes just enough of the engine
 * (globals, per-plane particle buffers, a trivial in-plane rule, a point
 * renderer) to drive the real passes from ../interplane.pass through the
 * shared contracts. Nothing here is meant to be reused by the engine.
 *
 * Run `npm run dev` and open /src/interplane/demo/.
 * URL: layout=ring|stairs|tiles  n=<particles per plane>  couriers=<per link>
 *      leak, margin, speed, pinch, twist, boost  dist=<camera>  spin=0  hud=0
 * Keys: 1-3 layout, space pause, h hide readout. Drag to orbit, wheel to zoom.
 */
import { TOKENS, type CameraController, type FrameContext, type GpuContext, type PlaneDesc, type PlaneInstance, type Quat, type Vec3 } from "../../core/contracts";
import { createInterplane, type Interplane } from "../interplane.pass";
import { planeModel } from "../links";

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const hud = document.getElementById("hud")!;
const canvas = document.getElementById("c") as HTMLCanvasElement;
hud.style.font = TOKENS.font;
hud.style.letterSpacing = TOKENS.letterSpacing;
hud.style.opacity = String(TOKENS.opacityDim);

// ------------------------------------------------------------- layouts ----

const axisAngle = (axis: Vec3, a: number): Quat => {
  const s = Math.sin(a / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)];
};
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const desc = (position: Vec3, rotation: Quat, halfSize: [number, number], behaviorId: string, i: number, count: number): PlaneDesc => ({
  position, rotation, halfSize, behaviorId, particleCount: count, seed: (i * 0.6180339887) % 1,
});

const LAYOUTS: Record<string, (count: number) => PlaneDesc[]> = {
  /** Carousel of panels with gaps; a conveyor on each sends a loop of streams around it. */
  ring(count) {
    const n = 10, R = 3.2, half = R * Math.tan(Math.PI / n) * 0.62;
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * Math.PI * 2;
      return desc([Math.sin(a) * R, 0, Math.cos(a) * R], axisAngle([0, 1, 0], a), [half, 1.1], "conveyor", i, count);
    });
  },
  /** Spiral staircase of horizontal steps. */
  stairs(count) {
    const n = 14;
    const flat = axisAngle([1, 0, 0], -Math.PI / 2);
    return Array.from({ length: n }, (_, i) => {
      const a = i * 0.62;
      return desc([Math.sin(a) * 2.2, (i - (n - 1) / 2) * 0.42, Math.cos(a) * 2.2], qmul(axisAngle([0, 1, 0], a), flat), [0.62, 0.95], i % 3 === 0 ? "vortex" : "conveyor", i, count);
    });
  },
  /** A wall of separated tiles; swirls leak in every direction. */
  tiles(count) {
    const out: PlaneDesc[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) {
      out.push(desc([(x - 1.5) * 2.6, (y - 1) * 2.4, 0], [0, 0, 0, 1], [1, 0.9], (x + y) % 2 ? "vortex" : "swirl", out.length, count));
    }
    return out;
  },
};
const KIND: Record<string, number> = { conveyor: 0, swirl: 1, vortex: 2 };

// ------------------------------------------------------------- shaders ----

const GLOBALS = /* wgsl */ `
struct Globals { viewProj: mat4x4f, time: f32, dt: f32, frame: u32, brightness: f32 }
@group(0) @binding(0) var<uniform> globals: Globals;
struct Plane { model: mat4x4f, kind: u32, count: u32, seed: f32, pad: f32 }
@group(1) @binding(0) var<uniform> plane: Plane;
struct Particle { pos: vec2f, vel: vec2f }
`;

// Stand-in for the engine's behaviors: three simple flows.
const SIM = /* wgsl */ `
${GLOBALS}
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;
fn hash(x: u32) -> u32 {
  let s = x * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn rand01(x: u32) -> f32 { return f32(x >> 8u) * (1.0 / 16777216.0); }
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= plane.count) { return; }
  var p = particles[i];
  let t = globals.time;
  let ph = plane.seed * 40.0;
  var want: vec2f;
  if (plane.kind == 0u) {
    want = vec2f(0.55, 0.22 * sin(p.pos.x * 4.0 + t * 0.7 + ph) + 0.1 * sin(p.pos.y * 9.0 - t + ph));
  } else if (plane.kind == 1u) {
    let a = p.pos * 2.6 + vec2f(ph, t * 0.15);
    want = 0.5 * vec2f(-sin(a.x) * sin(a.y) + cos(2.1 * a.y + t * 0.3) * cos(1.7 * a.x),
                       -cos(a.x) * cos(a.y) + 0.8 * sin(2.1 * a.y + t * 0.3) * sin(1.7 * a.x));
  } else {
    let r = length(p.pos) + 1e-3;
    want = vec2f(-p.pos.y, p.pos.x) / r * 0.8 * smoothstep(0.0, 0.3, r) + p.pos / r * 0.16;
  }
  p.vel += (want - p.vel) * min(1.0, 3.0 * globals.dt);
  p.pos += p.vel * globals.dt;
  if (any(abs(p.pos) > vec2f(1.0))) {
    let a = hash(i ^ hash(globals.frame)); let b = hash(a);
    p = Particle(vec2f(rand01(a), rand01(b)) * 2.0 - 1.0, vec2f(0.0));
  }
  particles[i] = p;
}
`;

const DRAW = /* wgsl */ `
${GLOBALS}
@vertex fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return globals.viewProj * plane.model * vec4f(pos, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { let b = globals.brightness; return vec4f(b, b, b, 0.0); }
`;

// ------------------------------------------------------------ mat4 bits ----

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far / (near - far), -1, 0, 0, (far * near) / (near - far), 0];
}
function lookAt(eye: Vec3, target: Vec3): number[] {
  const nrm = (a: number[]) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = nrm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = nrm(cross([0, 1, 0], z));
  const y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
function mul4(a: number[], b: number[]): Float32Array {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

// ----------------------------------------------------------------- main ----

async function main(): Promise<void> {
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("WebGPU is not available in this browser.");
  const device = await adapter.requestDevice();
  void device.lost.then((info) => console.error("GPU device lost:", info.message));
  device.addEventListener("uncapturederror", (e) => console.error("GPU error:", (e as GPUUncapturedErrorEvent).error.message));
  const context = canvas.getContext("webgpu")!;
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format: canvasFormat, alphaMode: "opaque" });

  const buffer = (type: GPUBufferBindingType): GPUBufferBindingLayout => ({ type });
  const all = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT | GPUShaderStage.COMPUTE;
  const layouts = {
    globals: device.createBindGroupLayout({ entries: [{ binding: 0, visibility: all, buffer: buffer("uniform") }] }),
    planeSim: device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: buffer("uniform") }, { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: buffer("storage") }] }),
    planeRender: device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: buffer("uniform") }] }),
  };
  const globalsBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const gpu: GpuContext = {
    device, canvas, context, canvasFormat,
    hdrFormat: canvasFormat, // the demo draws straight to the canvas
    layouts, globalsBuffer,
    globalsBindGroup: device.createBindGroup({ layout: layouts.globals, entries: [{ binding: 0, resource: { buffer: globalsBuffer } }] }),
  };

  const simPipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.globals, layouts.planeSim] }),
    compute: { module: device.createShaderModule({ code: SIM }), entryPoint: "main" },
  });
  const drawModule = device.createShaderModule({ code: DRAW });
  const add: GPUBlendComponent = { srcFactor: "one", dstFactor: "one" };
  const drawPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layouts.globals, layouts.planeRender] }),
    vertex: { module: drawModule, entryPoint: "vs", buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] }] },
    fragment: { module: drawModule, entryPoint: "fs", targets: [{ format: canvasFormat, blend: { color: add, alpha: add } }] },
    primitive: { topology: "point-list" },
  });

  const perPlane = num("n", 200_000);
  let layoutName = q.get("layout") ?? "ring";
  let planes: PlaneInstance[] = [];
  let interplane: Interplane;
  let paused = false;

  function build(name: string): void {
    layoutName = LAYOUTS[name] ? name : "ring";
    planes.forEach((p) => { p.particles.destroy(); p.uniform.destroy(); });
    interplane?.passes.forEach((p) => p.dispose?.());
    planes = LAYOUTS[layoutName](perPlane).map((d) => {
      const particles = device.createBuffer({ size: d.particleCount * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, mappedAtCreation: true });
      const f = new Float32Array(particles.getMappedRange());
      for (let i = 0; i < d.particleCount; i++) { f[i * 4] = Math.random() * 2 - 1; f[i * 4 + 1] = Math.random() * 2 - 1; }
      particles.unmap();
      const data = new ArrayBuffer(80);
      planeModel(d, new Float32Array(data));
      new Uint32Array(data).set([KIND[d.behaviorId], d.particleCount], 16);
      new Float32Array(data)[18] = d.seed;
      const uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(uniform, 0, data);
      return {
        desc: d, behavior: { id: d.behaviorId, params: {}, wgsl: "" }, capacity: d.particleCount, activeCount: d.particleCount, particles, uniform,
        simBindGroup: device.createBindGroup({ layout: layouts.planeSim, entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: particles } }] }),
        renderBindGroup: device.createBindGroup({ layout: layouts.planeRender, entries: [{ binding: 0, resource: { buffer: uniform } }] }),
      };
    });
    interplane = createInterplane({
      couriersPerLink: num("couriers", 16384),
      link: { maxDistance: num("maxDistance", 3) },
      leak: num("leak", 0.5), margin: num("margin", 0.04), speed: num("speed", 1.2),
      pinch: num("pinch", 0.85), twist: num("twist", 1), boost: num("boost", 1),
    });
    Object.assign(window, { interplane }); // console: await interplane.countInFlight()
  }
  build(layoutName);

  const state = { target: [0, 0, 0] as Vec3, yaw: num("yaw", 0.6), pitch: num("pitch", 0.35), distance: num("dist", 9), fovY: 0.8 };
  const eye = (): Vec3 => [Math.sin(state.yaw) * Math.cos(state.pitch) * state.distance, Math.sin(state.pitch) * state.distance, Math.cos(state.yaw) * Math.cos(state.pitch) * state.distance];
  let drag: [number, number] | null = null;
  const camera: CameraController = {
    state,
    update(dt) { if (q.get("spin") !== "0" && !drag) state.yaw += dt * 0.12; },
    eye,
    viewProjection: (aspect) => mul4(perspective(state.fovY, aspect, 0.05, 200), lookAt(eye(), state.target)),
  };
  canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    state.yaw -= (e.clientX - drag[0]) * 0.005;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch + (e.clientY - drag[1]) * 0.005));
    drag = [e.clientX, e.clientY];
  });
  canvas.addEventListener("wheel", (e) => { state.distance = Math.max(1, Math.min(60, state.distance * Math.exp(e.deltaY * 0.001))); e.preventDefault(); }, { passive: false });
  addEventListener("keydown", (e) => {
    const names = Object.keys(LAYOUTS);
    const pick = Number(e.key) - 1;
    if (pick >= 0 && pick < names.length) build(names[pick]);
    if (e.key === " ") paused = !paused;
    if (e.key === "h") hud.style.display = hud.style.display === "none" ? "" : "none";
  });
  if (q.get("hud") === "0") hud.style.display = "none";

  let last = performance.now(), time = 0, frameNo = 0, frames = 0, fpsAt = last;
  function tick(now: number): void {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr)), height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const dt = paused ? 0 : Math.min((now - last) / 1000, 1 / 30);
    last = now;
    time += dt;
    camera.update(dt);

    const total = planes.length * perPlane;
    const g = new ArrayBuffer(80);
    new Float32Array(g).set(camera.viewProjection(width / height));
    new Float32Array(g).set([time, dt], 16);
    new Uint32Array(g)[18] = frameNo;
    // Keep overall exposure roughly constant across counts and resolutions.
    new Float32Array(g)[19] = num("brightness", Math.max(0.03, Math.min(1, (0.5 * width * height) / (total * 6))));
    device.queue.writeBuffer(globalsBuffer, 0, g);

    const encoder = device.createCommandEncoder();
    const view = context.getCurrentTexture().createView();
    const frame: FrameContext = { gpu, encoder, planes, camera, time, dt, frame: frameNo, width, height, hdrView: view, hdrTexture: context.getCurrentTexture(), canvasView: view };

    if (!paused) {
      const sim = encoder.beginComputePass();
      sim.setPipeline(simPipeline);
      sim.setBindGroup(0, gpu.globalsBindGroup);
      for (const p of planes) { sim.setBindGroup(1, p.simBindGroup); sim.dispatchWorkgroups(Math.ceil(p.activeCount / 256)); }
      sim.end();
      interplane.passes[0].execute(frame);
    }
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view, clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(drawPipeline);
    pass.setBindGroup(0, gpu.globalsBindGroup);
    for (const p of planes) { pass.setBindGroup(1, p.renderBindGroup); pass.setVertexBuffer(0, p.particles); pass.draw(p.activeCount); }
    pass.end();
    interplane.passes[1].execute(frame);
    device.queue.submit([encoder.finish()]);

    frameNo++;
    frames++;
    if (now - fpsAt > 500) {
      const fps = (frames * 1000) / (now - fpsAt);
      frames = 0; fpsAt = now;
      hud.textContent = `interplane  ${layoutName}\n${total.toLocaleString()} particles  ${planes.length} planes\n${interplane.links().length} links  ${interplane.capacity().toLocaleString()} couriers\n${fps.toFixed(0)} fps`;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

main().catch((e) => { console.error(e); hud.textContent = String(e.message ?? e); });

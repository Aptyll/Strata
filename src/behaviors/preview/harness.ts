/**
 * Single-sheet stand-in for the engine, used only by the behavior preview page.
 *
 * It provides the WGSL scope that docs/architecture.md promises a behavior
 * (Particle, globals, plane, rand, noise2, outside, wrap, respawn) so a
 * behavior file can be seen and tuned on its own. The engine in src/core owns
 * the real implementation; if the two ever disagree, the engine is right.
 */
import { MAX_BEHAVIOR_PARAMS, type Behavior } from "../../core/contracts";

const PARTICLE_BYTES = 16;
const ROW = 65536;

function scopeWGSL(behavior: Behavior): string {
  const names = Object.keys(behavior.params);
  const fields: string[] = [];
  for (let k = 0; k < MAX_BEHAVIOR_PARAMS; k++) fields.push(`  ${names[k] ?? `_unused${k}`}: f32,`);
  return /* wgsl */ `
struct Particle { pos: vec2f, vel: vec2f }
struct Globals { viewProj: mat4x4f, time: f32, dt: f32, frame: u32, brightness: f32 }
struct Params {
${fields.join("\n")}
}
struct Plane { model: mat4x4f, params: Params, count: u32, seed: f32 }

@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> plane: Plane;
@group(1) @binding(1) var<storage, read_write> particles: array<Particle>;

fn strata_pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rand(i: u32, salt: u32) -> f32 {
  let h = strata_pcg(strata_pcg(i + strata_pcg(globals.frame + bitcast<u32>(plane.seed))) + salt * 0x9E3779B9u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn strata_grad(c: vec2i) -> vec2f {
  let h = strata_pcg(bitcast<u32>(c.x) + strata_pcg(bitcast<u32>(c.y)));
  let a = f32(h >> 8u) * (6.2831853 / 16777216.0);
  return vec2f(cos(a), sin(a));
}

fn noise2(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = dot(strata_grad(i), f);
  let b = dot(strata_grad(i + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(strata_grad(i + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(strata_grad(i + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn outside(pos: vec2f) -> bool {
  return any(abs(pos) > vec2f(1.0));
}

fn wrap(pos: vec2f) -> vec2f {
  return pos - 2.0 * floor(pos * 0.5 + 0.5);
}

fn respawn(i: u32) -> Particle {
  var p: Particle;
  p.pos = vec2f(rand(i, 7001u), rand(i, 7002u)) * 2.0 - 1.0;
  p.vel = vec2f(0.0);
  return p;
}

${behavior.wgsl}

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * ${ROW}u;
  if (i >= plane.count) { return; }
  particles[i] = update(particles[i], i);
}
`;
}

const POINTS_WGSL = /* wgsl */ `
struct Globals { viewProj: mat4x4f, time: f32, dt: f32, frame: u32, brightness: f32 }
@group(0) @binding(0) var<uniform> globals: Globals;

@vertex
fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return globals.viewProj * vec4f(pos, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(globals.brightness);
}
`;

const TONEMAP_WGSL = /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let a = textureLoad(hdr, vec2i(frag.xy), 0).r;
  let v = pow(1.0 - exp(-a), 1.0 / 2.2);
  return vec4f(v, v, v, 1.0);
}
`;

export class PreviewHarness {
  readonly maxParticles: number;
  /** Mean brightness of a uniformly filled sheet, before tonemapping. */
  exposure = 0.3;
  speed = 1;
  paused = false;
  zoom = 0.95;
  center: [number, number] = [0, 0];
  count = 0;
  behavior: Behavior | null = null;
  values: Record<string, number> = {};

  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly globals: GPUBuffer;
  private readonly globalsLayout: GPUBindGroupLayout;
  private readonly globalsGroup: GPUBindGroup;
  private readonly planeLayout: GPUBindGroupLayout;
  private readonly pointPipeline: GPURenderPipeline;
  private readonly tonePipeline: GPURenderPipeline;
  private planeUniform: GPUBuffer | null = null;
  private particles: GPUBuffer | null = null;
  private planeGroup: GPUBindGroup | null = null;
  private simPipeline: GPUComputePipeline | null = null;
  private hdr: GPUTexture | null = null;
  private hdrView: GPUTextureView | null = null;
  private toneGroup: GPUBindGroup | null = null;
  private time = 0;
  private frame = 0;
  private seed = 0.5;
  private generation = 0;

  static async create(canvas: HTMLCanvasElement): Promise<PreviewHarness> {
    if (!navigator.gpu) throw new Error("WebGPU is not available in this browser.");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No WebGPU adapter found.");
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxBufferSize: adapter.limits.maxBufferSize,
      },
    });
    return new PreviewHarness(canvas, device);
  }

  private constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly device: GPUDevice,
  ) {
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("Could not create a WebGPU canvas context.");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "opaque" });
    device.addEventListener("uncapturederror", (e) => console.error(e.error.message));
    void device.lost.then((info) => console.error(`GPU device lost: ${info.message}`));
    this.maxParticles = Math.floor(
      Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / PARTICLE_BYTES,
    );

    this.globals = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globalsLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.globalsGroup = device.createBindGroup({
      layout: this.globalsLayout,
      entries: [{ binding: 0, resource: { buffer: this.globals } }],
    });
    this.planeLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    const points = device.createShaderModule({ code: POINTS_WGSL });
    this.pointPipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.globalsLayout] }),
      vertex: {
        module: points,
        entryPoint: "vs",
        buffers: [
          { arrayStride: PARTICLE_BYTES, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        ],
      },
      fragment: {
        module: points,
        entryPoint: "fs",
        targets: [
          {
            format: "rgba16float",
            blend: {
              color: { srcFactor: "one", dstFactor: "one" },
              alpha: { srcFactor: "one", dstFactor: "one" },
            },
          },
        ],
      },
      primitive: { topology: "point-list" },
    });
    const tone = device.createShaderModule({ code: TONEMAP_WGSL });
    this.tonePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module: tone, entryPoint: "vs" },
      fragment: { module: tone, entryPoint: "fs", targets: [{ format: this.format }] },
    });
  }

  /** Load a behavior. Resolves to null, or to the shader errors if it does not compile. */
  async setBehavior(behavior: Behavior, count: number, values?: Record<string, number>): Promise<string | null> {
    const { device } = this;
    const generation = ++this.generation;

    device.pushErrorScope("validation");
    const module = device.createShaderModule({ code: scopeWGSL(behavior), label: behavior.id });
    const pipeline = await device
      .createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.globalsLayout, this.planeLayout] }),
        compute: { module, entryPoint: "simulate" },
      })
      .catch(() => null);
    const validation = await device.popErrorScope();
    const info = await module.getCompilationInfo();
    const errors = info.messages
      .filter((m) => m.type === "error")
      .map((m) => `${behavior.id}:${m.lineNum}:${m.linePos} ${m.message}`);
    if (!pipeline || validation || errors.length) {
      return [...errors, validation?.message ?? ""].filter(Boolean).join("\n") || "pipeline creation failed";
    }
    if (generation !== this.generation) return null;

    this.behavior = behavior;
    this.simPipeline = pipeline;
    this.values = Object.fromEntries(Object.entries(behavior.params).map(([k, spec]) => [k, spec.default]));
    Object.assign(this.values, values);
    this.count = Math.max(1, Math.min(Math.floor(count), this.maxParticles));

    this.particles?.destroy();
    this.planeUniform?.destroy();
    this.particles = device.createBuffer({
      size: this.count * PARTICLE_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.planeUniform = device.createBuffer({ size: 112, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.planeGroup = device.createBindGroup({
      layout: this.planeLayout,
      entries: [
        { binding: 0, resource: { buffer: this.planeUniform } },
        { binding: 1, resource: { buffer: this.particles } },
      ],
    });
    this.reset();
    return null;
  }

  /** New seed and fresh initial state (the behavior's init, or random positions at rest). */
  reset(): void {
    const { behavior, particles } = this;
    if (!behavior || !particles) return;
    this.seed = Math.random();
    this.time = 0;
    this.frame = 0;
    // Written in chunks so very large counts do not need one giant array.
    const chunk = 1 << 20;
    for (let start = 0; start < this.count; start += chunk) {
      const n = Math.min(chunk, this.count - start);
      const data = new Float32Array(n * 4);
      if (behavior.init) {
        behavior.init(data, n, Math.random);
      } else {
        for (let k = 0; k < n; k++) {
          data[k * 4] = Math.random() * 2 - 1;
          data[k * 4 + 1] = Math.random() * 2 - 1;
        }
      }
      this.device.queue.writeBuffer(particles, start * PARTICLE_BYTES, data);
    }
  }

  setParam(name: string, value: number): void {
    this.values[name] = value;
  }

  private writeUniforms(dt: number): void {
    const { canvas, behavior, planeUniform } = this;
    if (!behavior || !planeUniform) return;
    const m = Math.min(canvas.width, canvas.height);
    const sx = (this.zoom * m) / canvas.width;
    const sy = (this.zoom * m) / canvas.height;
    const sheetPixels = (this.zoom * m) ** 2;

    const g = new ArrayBuffer(80);
    const gf = new Float32Array(g);
    // Orthographic view of the sheet, column-major.
    gf.set([sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -this.center[0] * sx, -this.center[1] * sy, 0, 1]);
    gf[16] = this.time;
    gf[17] = dt;
    new Uint32Array(g)[18] = this.frame;
    gf[19] = Math.min(64, (this.exposure * sheetPixels) / this.count);
    this.device.queue.writeBuffer(this.globals, 0, g);

    const p = new ArrayBuffer(112);
    const pf = new Float32Array(p);
    pf.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    Object.keys(behavior.params).forEach((name, k) => {
      pf[16 + k] = this.values[name] ?? 0;
    });
    new Uint32Array(p)[24] = this.count;
    pf[25] = this.seed;
    this.device.queue.writeBuffer(planeUniform, 0, p);
  }

  private ensureTarget(): void {
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    if (this.hdr && this.hdr.width === w && this.hdr.height === h) return;
    this.hdr?.destroy();
    this.hdr = this.device.createTexture({
      size: [w, h],
      format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    this.hdrView = this.hdr.createView();
    this.toneGroup = this.device.createBindGroup({
      layout: this.tonePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: this.hdrView }],
    });
  }

  /** Simulate one step (unless paused) and draw. */
  tick(): void {
    const { device, simPipeline, planeGroup, particles } = this;
    if (!simPipeline || !planeGroup || !particles) return;
    this.ensureTarget();
    const dt = this.paused ? 0 : (1 / 60) * this.speed;
    this.writeUniforms(dt);

    const encoder = device.createCommandEncoder();
    if (!this.paused) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(simPipeline);
      pass.setBindGroup(0, this.globalsGroup);
      pass.setBindGroup(1, planeGroup);
      const rows = Math.ceil(this.count / ROW);
      pass.dispatchWorkgroups(rows > 1 ? ROW / 64 : Math.ceil(this.count / 64), rows);
      pass.end();
    }

    const draw = encoder.beginRenderPass({
      colorAttachments: [{ view: this.hdrView!, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
    });
    draw.setPipeline(this.pointPipeline);
    draw.setBindGroup(0, this.globalsGroup);
    draw.setVertexBuffer(0, particles);
    draw.draw(this.count);
    draw.end();

    const tone = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    tone.setPipeline(this.tonePipeline);
    tone.setBindGroup(0, this.toneGroup!);
    tone.draw(3);
    tone.end();
    device.queue.submit([encoder.finish()]);

    if (!this.paused) {
      this.time += dt;
      this.frame++;
    }
  }
}

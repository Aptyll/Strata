/**
 * Single-sheet host for the behavior preview page.
 *
 * It runs the engine's own compute shader (buildSimShader in
 * src/gpu/shaderLib.ts) with the engine's uniform layouts (packGlobals,
 * packPlane), so a behavior moves here exactly as it does in the app. Only
 * the drawing is simpler: one additive point per particle into a float
 * target, then the basic tone curve.
 */
import type { Behavior } from "../../core/contracts";
import { requestGpuDevice } from "../../gpu/context";
import {
  buildSimShader,
  dispatchSize,
  GLOBALS_SIZE,
  GLOBALS_WGSL,
  packGlobals,
  packPlane,
  PARTICLE_STRIDE,
  PLANE_UNIFORM_SIZE,
  planeParamValues,
} from "../../gpu/shaderLib";
import { BASIC_TONE_WGSL, FULLSCREEN_VS_WGSL } from "../../gpu/wgsl";
import { mat4Identity } from "../../math";

/** The preview's sheet is the world: its model matrix is the identity. */
const IDENTITY = mat4Identity();

/** One additive point per particle; brightness from the Globals uniform. */
export const POINTS_WGSL = /* wgsl */ `${GLOBALS_WGSL}
@vertex
fn vs(@location(0) pos: vec2f) -> @builtin(position) vec4f {
  return globals.viewProj * vec4f(pos, 0.0, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(globals.brightness);
}
`;

/** Float target to the canvas through the basic tone curve. */
export const TONEMAP_WGSL = /* wgsl */ `${FULLSCREEN_VS_WGSL}${BASIC_TONE_WGSL}
@group(0) @binding(0) var hdr: texture_2d<f32>;

@fragment
fn fs(i: VSOut) -> @location(0) vec4f {
  let v = basicTone(textureLoad(hdr, vec2i(i.pos.xy), 0).r);
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
  /** CPU copies of the two uniforms. writeBuffer copies at call time, so they are reused. */
  private readonly globalsBlock = new DataView(new ArrayBuffer(GLOBALS_SIZE));
  private readonly planeBlock = new DataView(new ArrayBuffer(PLANE_UNIFORM_SIZE));

  static async create(canvas: HTMLCanvasElement): Promise<PreviewHarness> {
    return new PreviewHarness(canvas, await requestGpuDevice());
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
      Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / PARTICLE_STRIDE,
    );

    this.globals = device.createBuffer({ size: GLOBALS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
          { arrayStride: PARTICLE_STRIDE, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
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
    const module = device.createShaderModule({ code: buildSimShader(behavior), label: behavior.id });
    const pipeline = await device
      .createComputePipelineAsync({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.globalsLayout, this.planeLayout] }),
        compute: { module, entryPoint: "main" },
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
      size: this.count * PARTICLE_STRIDE,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    });
    this.planeUniform = device.createBuffer({ size: PLANE_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
      this.device.queue.writeBuffer(particles, start * PARTICLE_STRIDE, data);
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

    packGlobals(this.globalsBlock, 0, {
      // Orthographic view of the sheet, column-major.
      viewProj: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, -this.center[0] * sx, -this.center[1] * sy, 0, 1],
      time: this.time,
      dt,
      frame: this.frame,
      brightness: Math.min(64, (this.exposure * sheetPixels) / this.count),
    });
    this.device.queue.writeBuffer(this.globals, 0, this.globalsBlock.buffer);
    packPlane(this.planeBlock, 0, {
      model: IDENTITY,
      params: planeParamValues(behavior, this.values),
      count: this.count,
      seed: this.seed,
      brightness: 1,
    });
    this.device.queue.writeBuffer(planeUniform, 0, this.planeBlock.buffer);
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
      pass.dispatchWorkgroups(...dispatchSize(this.count));
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

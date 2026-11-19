// A rasterize-stage Pass that draws every plane as depth-cued sprites instead
// of one pixel points: fog into black, depth of field, size and brightness
// falloff. It reads only what src/core/contracts.ts promises:
//   group(0) Globals, group(1) the plane uniform, and each plane's particle
//   buffer bound as an instance vertex buffer (pos.xy at offset 0, 16 bytes).
//
// It is an alternative to the point rasterizer, not an addition: enable one
// or the other. With `clear: true` (the default) it clears the HDR target
// itself, so it also works when it is the only rasterize pass.

import type { FrameContext, GpuContext, Pass, PlaneInstance, Vec3 } from '../core/contracts';
import { depthWGSL } from './depth.wgsl';
import { DepthParams, DEPTH_PARAMS_BYTES, type DepthSettings } from './params';
import { FocusTracker, focusPlaneFromDesc, type FocusTrackerOptions } from './focus';

/**
 * Depth settings sized for a world of the given radius (distance from the
 * world centre to its farthest plane edge), viewed by an orbit camera a couple
 * of radii out. Fog reaches across the whole world, so the far side is dim
 * but present, and particles cover about one pixel at the orbit distance.
 */
export function depthSettingsForWorld(radius: number): Partial<DepthSettings> {
  const r = Math.max(radius, 1e-6);
  const refDist = 2.2 * r;
  return {
    refDist,
    // About one pixel of area at the orbit distance on a 1080p target, so the
    // image carries the same light there as the one pixel point rasterizer.
    baseSize: refDist * 0.00047,
    fogDensity: 1 / (3 * r),
    fogStart: 0,
    nearFade: 0.12 * r,
    focusRange: 0.04 * r,
    focusDist: refDist,
  };
}

/** Radius of the sphere around the planes' centroid that contains them all. */
export function worldRadius(planes: readonly PlaneInstance[]): number {
  if (planes.length === 0) return 0;
  const c = [0, 0, 0];
  for (const p of planes) for (let i = 0; i < 3; i++) c[i] += p.desc.position[i] / planes.length;
  let r = 0;
  for (const p of planes) {
    const d = p.desc.position;
    r = Math.max(r, Math.hypot(d[0] - c[0], d[1] - c[1], d[2] - c[2]) + Math.hypot(p.desc.halfSize[0], p.desc.halfSize[1]));
  }
  return r;
}

export interface DepthSpritePassOptions {
  /**
   * Radius of the world in world units, used to size fog, particle size and
   * focus. Omit it to measure the planes on the first frame; call
   * `pass.fitWorld()` again if the world changes scale.
   */
  worldRadius?: number;
  /** Overrides applied on top of the world-sized settings. Change them later through `pass.params`. */
  params?: Partial<DepthSettings>;
  /** Focus follows the nearest plane on the view axis. Default true. */
  autofocus?: boolean;
  focus?: FocusTrackerOptions;
  /** Clear the HDR target before drawing. Default true. */
  clear?: boolean;
}

export interface DepthSpritePass extends Pass {
  /** Live settings, read every frame. */
  readonly params: DepthParams;
  readonly focus: FocusTracker;
  autofocus: boolean;
  /** Planes skipped last frame because fog had already hidden them. */
  readonly culledPlanes: number;
  /** Resize fog, particle size and focus for a world of this radius (or measure `planes`). */
  fitWorld(source: number | readonly PlaneInstance[]): void;
}

const shader = depthWGSL + /* wgsl */ `
struct Globals {
  viewProj: mat4x4f,
  time: f32,
  dt: f32,
  frame: u32,
  brightness: f32,
};
struct Plane {
  model: mat4x4f,
  params0: vec4f,
  params1: vec4f,
  count: u32,
  seed: f32,
  brightness: f32, // multiplies globals.brightness for this plane
};
struct DepthView {
  eye: vec3f,
  pad0: f32,
  viewport: vec2f,
  pad1: vec2f,
};
@group(0) @binding(0) var<uniform> globals: Globals;
@group(1) @binding(0) var<uniform> plane: Plane;
@group(2) @binding(0) var<uniform> dp: DepthParams;
@group(2) @binding(1) var<uniform> dv: DepthView;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) px: vec2f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) intensity: f32,
  @location(3) @interpolate(flat) defocus: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) local: vec2f) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let corner = corners[vi];
  let world = plane.model * vec4f(local, 0.0, 1.0);
  var clip = globals.viewProj * world;
  let viewZ = clip.w; // perspective projection: w is the distance along the view axis
  var s = depth_sprite(viewZ, distance(world.xyz, dv.eye), dp);
  s.intensity *= globals.brightness * plane.brightness;

  var out: VSOut;
  if (s.intensity < dp.cullIntensity * globals.brightness || viewZ < 1e-3) {
    clip = vec4f(2.0, 2.0, 2.0, 1.0); // outside the clip volume: no fragments
  } else {
    clip = vec4f(clip.xy + depth_quad_offset(corner, s.radiusPx, dv.viewport) * clip.w, clip.zw);
  }
  out.pos = clip;
  out.px = depth_quad_px(corner, s.radiusPx);
  out.radius = s.radiusPx;
  out.intensity = s.intensity;
  out.defocus = s.defocus;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let v = in.intensity * depth_bokeh(in.px, in.radius, in.defocus, dp);
  return vec4f(v, v, v, v);
}
`;

const VIEW_BYTES = 32;

export function createDepthSpritePass(gpu: GpuContext, options: DepthSpritePassOptions = {}): DepthSpritePass {
  const { device } = gpu;
  const params = new DepthParams(options.params);
  const focus = new FocusTracker({ initial: params.focusDist, ...options.focus });
  let first = true;
  let fitted = false;
  const fitWorld = (source: number | readonly PlaneInstance[]): void => {
    const radius = typeof source === 'number' ? source : worldRadius(source);
    if (!(radius > 0)) return;
    Object.assign(params, depthSettingsForWorld(radius), options.params);
    focus.minDist = options.focus?.minDist ?? 0.15 * radius;
    focus.distance = focus.target = params.focusDist;
    fitted = true;
    first = true;
  };
  const clear = options.clear ?? true;

  const layout = device.createBindGroupLayout({
    label: 'depth-sprites',
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ],
  });
  const paramsBuffer = device.createBuffer({
    label: 'depth-params',
    size: DEPTH_PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const viewBuffer = device.createBuffer({
    label: 'depth-view',
    size: VIEW_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const bindGroup = device.createBindGroup({
    layout,
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: viewBuffer } },
    ],
  });
  const module = device.createShaderModule({ label: 'depth-sprites', code: shader });
  const pipeline = device.createRenderPipeline({
    label: 'depth-sprites',
    layout: device.createPipelineLayout({
      bindGroupLayouts: [gpu.layouts.globals, gpu.layouts.planeRender, layout],
    }),
    vertex: {
      module,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: 16,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [
        {
          format: gpu.hdrFormat,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          },
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  });

  const paramsData = new Float32Array(DEPTH_PARAMS_BYTES / 4);
  const viewData = new Float32Array(VIEW_BYTES / 4);
  let culled = 0;

  const planeRadius = (p: PlaneInstance): number => Math.hypot(p.desc.halfSize[0], p.desc.halfSize[1]);

  const pass: DepthSpritePass = {
    name: 'depth-sprites',
    stage: 'rasterize',
    enabled: true,
    params,
    focus,
    autofocus: options.autofocus ?? true,
    get culledPlanes() {
      return culled;
    },
    fitWorld,

    execute(frame: FrameContext): void {
      const eye = frame.camera.eye();
      const state = frame.camera.state;
      if (!fitted) fitWorld(frame.planes);

      if (pass.autofocus) {
        const to: Vec3 = [state.target[0] - eye[0], state.target[1] - eye[1], state.target[2] - eye[2]];
        const len = Math.hypot(to[0], to[1], to[2]);
        if (len > 1e-6) {
          const forward: Vec3 = [to[0] / len, to[1] / len, to[2] / len];
          const planes = frame.planes.map((p) => focusPlaneFromDesc(p.desc));
          params.focusDist = focus.update(eye, forward, planes, first ? 0 : frame.dt);
          if (first) {
            focus.snap();
            params.focusDist = focus.distance;
          }
        }
      }
      first = false;

      params.pack({ viewportH: frame.height, projScaleY: 1 / Math.tan(state.fovY / 2) }, paramsData);
      viewData[0] = eye[0];
      viewData[1] = eye[1];
      viewData[2] = eye[2];
      viewData[4] = frame.width;
      viewData[5] = frame.height;
      device.queue.writeBuffer(paramsBuffer, 0, paramsData);
      device.queue.writeBuffer(viewBuffer, 0, viewData);

      const rp = frame.encoder.beginRenderPass({
        label: 'depth-sprites',
        colorAttachments: [
          {
            view: frame.hdrView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
      });
      rp.setPipeline(pipeline);
      rp.setBindGroup(0, gpu.globalsBindGroup);
      rp.setBindGroup(2, bindGroup);

      // Whole planes that fog has already erased are never submitted.
      const cullDist = params.fogCullDistance();
      culled = 0;
      for (const p of frame.planes) {
        if (p.activeCount <= 0) continue;
        const c = p.desc.position;
        const d = Math.hypot(c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]) - planeRadius(p);
        if (d > cullDist) {
          culled++;
          continue;
        }
        rp.setBindGroup(1, p.renderBindGroup);
        rp.setVertexBuffer(0, p.particles);
        rp.draw(6, p.activeCount);
      }
      rp.end();
    },

    dispose(): void {
      paramsBuffer.destroy();
      viewBuffer.destroy();
    },
  };
  if (options.worldRadius !== undefined) fitWorld(options.worldRadius);
  return pass;
}

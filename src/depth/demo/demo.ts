// Standalone demo for src/depth. It does not depend on the engine: it brings
// its own tiny renderer and procedural particles so the depth cues can be
// judged in isolation. Run `npm run dev` and open /src/depth/demo/.
//
// URL parameters (all optional), useful for captures and tests:
//   fog=0 dof=0 atmosphere=0 parallax=0 autofocus=0   switch a cue off
//   count=2000000   total particles        planes=64    plane count
//   time=12         start time in seconds  paused=1     freeze time
//   ui=0            hide the panel         yaw= pitch=  look direction (rad)
//   offscreen=1     do not present; render only via __depthDemo.readPixels()
//   aperture= focus= fogReach= exposure= speed=          slider values

import type { Vec3 } from '../../core/contracts';
import { BASIC_TONE_WGSL, FULLSCREEN_VS_WGSL, PCG_WGSL, U01_WGSL } from '../../gpu/wgsl';
import { mat4LookAt, mat4Perspective, seededRandom } from '../../math';
import { depthWGSL, DepthParams, DEPTH_PARAMS_BYTES, FocusTracker, ParallaxRig, type FocusPlane } from '../index';

interface DemoHook {
  frames: number;
  focusDist?: number;
  error?: string;
  gpuError?: string;
  ready?: boolean;
  /**
   * Render one frame offscreen, advancing time by dt seconds (ignored while
   * paused), and return tightly packed RGBA8 pixels.
   */
  readPixels?: (dt?: number) => Promise<{ width: number; height: number; data: Uint8Array }>;
}
declare global {
  interface Window {
    __depthDemo: DemoHook;
  }
}

const q = new URLSearchParams(location.search);
const qNum = (k: string, d: number): number => {
  const v = q.get(k);
  return v !== null && v !== '' && Number.isFinite(+v) ? +v : d;
};
const qBool = (k: string, d: boolean): boolean => {
  const v = q.get(k);
  return v === null ? d : v !== '0' && v !== 'false';
};
const $ = <T extends HTMLElement = HTMLInputElement>(id: string): T => document.getElementById(id) as T;

const PLANES = Math.max(1, Math.min(1024, qNum('planes', 64) | 0));
const SPACING = 8;
const HALF = 42;
const DEPTH = PLANES * SPACING;
const BEHIND = SPACING * 1.5;
const FOVY = (55 * Math.PI) / 180;
const NEAR = 0.05;
const FAR = 5000;

// ---------- tiny vector helpers (matrices and the seeded random come from src/math.ts)
const v3 = {
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

// ---------- world: a corridor of tilted paper planes that wraps around the
// camera, so the flight never ends. Fog hides the wrap.
const rand = seededRandom(7);
interface DemoPlane extends FocusPlane {
  baseZ: number;
  off: [number, number];
  pattern: number;
  seed: number;
}
const planeDefs: DemoPlane[] = [];
for (let k = 0; k < PLANES; k++) {
  const tiltX = (rand() - 0.5) * 0.5;
  const tiltY = (rand() - 0.5) * 0.5;
  const roll = rand() * Math.PI * 2;
  const cx = Math.cos(tiltX), sx = Math.sin(tiltX);
  const cy = Math.cos(tiltY), sy = Math.sin(tiltY);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  // rotate the X and Y axes by roll, then tilt about X, then about Y
  const rot = (p: Vec3): Vec3 => {
    let [x, y, z] = p;
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    return [x, y, z];
  };
  planeDefs.push({
    baseZ: -k * SPACING,
    off: [(rand() - 0.5) * 30, (rand() - 0.5) * 20],
    u: v3.scale(rot([1, 0, 0]), HALF),
    v: v3.scale(rot([0, 1, 0]), HALF),
    pattern: k % 4,
    seed: (rand() * 0xffffffff) >>> 0,
    center: [0, 0, 0],
  });
}
const PLANE_STRIDE = 12; // floats: center.xyz pattern | u.xyz seed | v.xyz spin
const planeData = new ArrayBuffer(PLANES * PLANE_STRIDE * 4);
const planeF32 = new Float32Array(planeData);
const planeU32 = new Uint32Array(planeData);
function updatePlanes(camZ: number): void {
  for (let k = 0; k < PLANES; k++) {
    const p = planeDefs[k];
    const top = camZ + BEHIND;
    const m = (((top - p.baseZ) % DEPTH) + DEPTH) % DEPTH;
    p.center = [p.off[0], p.off[1], top - m];
    const o = k * PLANE_STRIDE;
    planeF32.set(p.center, o);
    planeF32[o + 3] = p.pattern;
    planeF32.set(p.u, o + 4);
    planeU32[o + 7] = p.seed;
    planeF32.set(p.v, o + 8);
    planeF32[o + 11] = (k % 2 ? 1 : -1) * (0.02 + 0.03 * ((p.seed & 255) / 255));
  }
}

// ---------- shaders
const sceneWGSL = depthWGSL + PCG_WGSL + U01_WGSL + /* wgsl */ `
struct Globals {
  proj: mat4x4f,
  view: mat4x4f,
  viewport: vec2f,
  time: f32,
  perPlane: u32,
};
struct Plane {
  center: vec3f, pattern: f32,
  u: vec3f, seed: u32,
  v: vec3f, spin: f32,
};
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var<uniform> dp: DepthParams;
@group(0) @binding(2) var<storage, read> planes: array<Plane>;


// Particle position on its plane, in [-1, 1]^2.
fn particle_layout(pl: Plane, i: u32) -> vec3f {
  let h1 = pcg(i ^ pcg(pl.seed));
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  let a = u01(h1); let b = u01(h2); let c = u01(h3);
  let tau = 6.2831853;
  var p: vec2f;
  let pat = u32(pl.pattern);
  if (pat == 0u) {
    // spiral disc
    let r = pow(a, 0.75);
    let arm = floor(b * 3.0) / 3.0;
    let th = (arm + (c - 0.5) * 0.16 * (1.2 - r)) * tau + r * 5.5 + g.time * pl.spin * (2.0 - r);
    p = vec2f(cos(th), sin(th)) * r;
  } else if (pat == 1u) {
    // rings
    let ring = (floor(a * 9.0) + 1.0) / 9.0;
    let th = b * tau + g.time * pl.spin * (1.5 - ring) * 2.0;
    p = vec2f(cos(th), sin(th)) * (ring + (c - 0.5) * 0.012);
  } else if (pat == 2u) {
    // lattice with breathing jitter
    let n = 48.0;
    let cell = (floor(vec2f(a, b) * n) + 0.5) / n * 2.0 - 1.0;
    let ph = c * tau + g.time * pl.spin * 20.0;
    p = cell + vec2f(cos(ph), sin(ph)) * (0.25 / n) * (1.0 + 2.0 * c);
  } else {
    // drifting dust
    p = vec2f(a, b) * 2.0 - 1.0;
    p += 0.03 * vec2f(sin(g.time * 0.2 + c * tau + p.y * 6.0), cos(g.time * 0.17 + c * tau + p.x * 6.0));
  }
  return vec3f(p, 0.35 + 0.65 * c * c);
}

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) px: vec2f,
  @location(1) @interpolate(flat) radius: f32,
  @location(2) @interpolate(flat) intensity: f32,
  @location(3) @interpolate(flat) defocus: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let corner = corners[vi];
  let pl = planes[ii / g.perPlane];
  let l = particle_layout(pl, ii % g.perPlane);
  let world = pl.center + pl.u * l.x + pl.v * l.y;
  let viewPos = (g.view * vec4f(world, 1.0)).xyz;
  var clip = g.proj * vec4f(viewPos, 1.0);
  let viewZ = clip.w;

  var s = depth_sprite(viewZ, length(viewPos), dp);
  s.intensity *= l.z;

  var out: VSOut;
  if (s.intensity < dp.cullIntensity || viewZ < 0.05) {
    clip = vec4f(2.0, 2.0, 2.0, 1.0); // outside the clip volume: no fragments
  } else {
    clip = vec4f(clip.xy + depth_quad_offset(corner, s.radiusPx, g.viewport) * clip.w, clip.zw);
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

// Plain tone curve (basicTone, the app's ?tonemap=basic), not the density
// look from src/render: this page judges the depth cues on their own.
const presentWGSL = FULLSCREEN_VS_WGSL + BASIC_TONE_WGSL + /* wgsl */ `
@group(0) @binding(0) var hdr: texture_2d<f32>;
struct P { exposure: f32, a: f32, b: f32, c: f32 };
@group(0) @binding(1) var<uniform> p: P;
@fragment fn fs(i: VSOut) -> @location(0) vec4f {
  let v = basicTone(textureLoad(hdr, vec2i(i.pos.xy), 0).r * p.exposure);
  return vec4f(v, v, v, 1.0);
}
`;

function fail(msg: string): void {
  const e = $<HTMLDivElement>('err');
  e.style.display = 'flex';
  e.textContent = msg;
  window.__depthDemo = { ...(window.__depthDemo ?? { frames: 0 }), error: msg };
}

async function main(): Promise<void> {
  if (!navigator.gpu) return fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return fail('No WebGPU adapter found.');
  const device = await adapter.requestDevice();
  window.__depthDemo = { frames: 0 };
  void device.lost.then((info) => fail(`WebGPU device lost: ${info.message || info.reason}`));
  device.addEventListener('uncapturederror', (ev) => {
    const e = ev as GPUUncapturedErrorEvent;
    console.error(e.error.message);
    window.__depthDemo.gpuError = e.error.message;
  });

  const canvas = $<HTMLCanvasElement>('c');
  // offscreen=1 never touches the canvas swap chain: frames are only produced
  // on demand through __depthDemo.readPixels(). For headless capture, where
  // presenting a WebGPU canvas is not always possible.
  const offscreen = qBool('offscreen', false);
  const ctx = offscreen ? null : canvas.getContext('webgpu');
  if (!offscreen && !ctx) return fail('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx?.configure({ device, format, alphaMode: 'opaque' });
  const HDR: GPUTextureFormat = 'rgba16float';

  const sceneModule = device.createShaderModule({ code: sceneWGSL });
  const presentModule = device.createShaderModule({ code: presentWGSL });
  for (const m of [sceneModule, presentModule]) {
    const info = await m.getCompilationInfo();
    const errs = info.messages.filter((x) => x.type === 'error');
    if (errs.length) return fail('Shader error: ' + errs.map((x) => `${x.lineNum}: ${x.message}`).join(' | '));
  }

  const scenePipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: sceneModule, entryPoint: 'vs' },
    fragment: {
      module: sceneModule,
      entryPoint: 'fs',
      targets: [{
        format: HDR,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  });
  const presentLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const makePresentPipe = (target: GPUTextureFormat): GPURenderPipeline =>
    device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [presentLayout] }),
      vertex: { module: presentModule, entryPoint: 'vs' },
      fragment: { module: presentModule, entryPoint: 'fs', targets: [{ format: target }] },
      primitive: { topology: 'triangle-list' },
    });
  const presentPipe = makePresentPipe(format);

  const globalsData = new ArrayBuffer(144);
  const globalsF32 = new Float32Array(globalsData);
  const globalsU32 = new Uint32Array(globalsData);
  const globalsBuf = device.createBuffer({ size: 144, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const depthBuf = device.createBuffer({ size: DEPTH_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const planeBuf = device.createBuffer({ size: planeData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const presentBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const sceneBind = device.createBindGroup({
    layout: scenePipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: globalsBuf } },
      { binding: 1, resource: { buffer: depthBuf } },
      { binding: 2, resource: { buffer: planeBuf } },
    ],
  });

  let hdrTex: GPUTexture | null = null;
  let presentBind: GPUBindGroup | null = null;
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (hdrTex && canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    hdrTex?.destroy();
    hdrTex = device.createTexture({
      size: [w, h], format: HDR,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    presentBind = device.createBindGroup({
      layout: presentLayout,
      entries: [
        { binding: 0, resource: hdrTex.createView() },
        { binding: 1, resource: { buffer: presentBuf } },
      ],
    });
  }

  // ---------- state and UI
  const depth = new DepthParams();
  const depthData = new Float32Array(DEPTH_PARAMS_BYTES / 4);
  const focus = new FocusTracker({ initial: 20, tau: 0.7, minDist: 4 });
  const rig = new ParallaxRig();
  const state = {
    time: qNum('time', 0),
    paused: qBool('paused', false),
    yaw: qNum('yaw', 0),
    pitch: qNum('pitch', 0),
    pointer: [0, 0] as [number, number],
    autofocus: true,
    exposure: 1,
    speed: 4,
    total: 0,
  };
  for (const id of ['fog', 'dof', 'atmosphere', 'parallax', 'autofocus']) {
    const el = $(id);
    el.checked = qBool(id, el.checked);
  }
  for (const id of ['fogReach', 'aperture', 'focus', 'exposure', 'speed']) {
    const el = $(id);
    el.value = String(qNum(id, +el.value));
  }
  if (q.has('count')) $('count').value = String(Math.log2(Math.max(1, qNum('count', 2 ** 21))));
  if (!qBool('ui', true)) $('ui').classList.add('hidden');

  function readUI(): void {
    depth.fog = $('fog').checked;
    depth.dof = $('dof').checked;
    depth.atmosphere = $('atmosphere').checked;
    rig.enabled = $('parallax').checked;
    state.autofocus = $('autofocus').checked;
    depth.fogDensity = 1 / +$('fogReach').value;
    depth.aperture = +$('aperture').value;
    state.exposure = 2 ** +$('exposure').value;
    state.speed = +$('speed').value;
    state.total = q.has('count') ? Math.round(qNum('count', 0)) : Math.round(2 ** +$('count').value);
    $('focus').disabled = state.autofocus;
  }
  $('count').addEventListener('input', () => q.delete('count'));

  addEventListener('keydown', (e) => {
    const map: Record<string, string> = { 1: 'fog', 2: 'dof', 3: 'atmosphere', 4: 'parallax', 5: 'autofocus' };
    const id = map[e.key];
    if (id) $(id).checked = !$(id).checked;
    else if (e.key === ' ') { state.paused = !state.paused; e.preventDefault(); }
    else if (e.key === 'h' || e.key === 'H') $('ui').classList.toggle('hidden');
  });
  let drag: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointermove', (e) => {
    state.pointer = [(e.clientX / innerWidth) * 2 - 1, 1 - (e.clientY / innerHeight) * 2];
    if (!drag) return;
    state.yaw -= (e.clientX - drag[0]) * 0.004;
    state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch - (e.clientY - drag[1]) * 0.004));
    drag = [e.clientX, e.clientY];
  });

  // ---------- frame
  let last = performance.now();
  let fps = 0;
  let frames = 0;
  // Encode the scene into the HDR target, then tone map it into `target`.
  function render(dt: number, target: GPUTextureView, pipe: GPURenderPipeline): void {
    readUI();
    resize();
    if (!hdrTex || !presentBind) return;
    if (!state.paused) state.time += dt;
    const t = state.time;

    // camera: drift down the corridor with a slow weave
    const eye0: Vec3 = [Math.sin(t * 0.11) * 9, Math.sin(t * 0.07 + 1) * 6, -t * state.speed];
    const yaw = state.yaw + Math.sin(t * 0.05) * 0.25;
    const pitch = state.pitch + Math.sin(t * 0.04 + 2) * 0.1;
    const fwd: Vec3 = [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)];
    const right = v3.norm(v3.cross(fwd, [0, 1, 0]));
    const up = v3.cross(right, fwd);

    updatePlanes(eye0[2]);
    if (state.autofocus) {
      depth.focusDist = focus.update(eye0, fwd, planeDefs, state.paused ? 0 : dt);
      // On the first frame snap instead of easing in from the default.
      if (frames === 0) {
        focus.snap();
        depth.focusDist = focus.distance;
      }
      $('focus').value = String(depth.focusDist);
    } else {
      depth.focusDist = +$('focus').value;
      focus.distance = depth.focusDist;
    }
    rig.update(state.paused ? 0 : dt, state.pointer[0], state.pointer[1]);
    const cam = rig.apply(eye0, fwd, right, up, depth.focusDist);

    const w = canvas.width;
    const h = canvas.height;
    const proj = mat4Perspective(new Float32Array(16), FOVY, w / h, NEAR, FAR);
    const view = mat4LookAt(new Float32Array(16), cam.eye, cam.target, up);
    const perPlane = Math.max(1, Math.floor(state.total / PLANES));
    globalsF32.set(proj, 0);
    globalsF32.set(view, 16);
    globalsF32[32] = w;
    globalsF32[33] = h;
    globalsF32[34] = t;
    globalsU32[35] = perPlane;
    device.queue.writeBuffer(globalsBuf, 0, globalsData);
    depth.pack({ viewportH: h, projScaleY: proj[5] }, depthData);
    device.queue.writeBuffer(depthBuf, 0, depthData);
    device.queue.writeBuffer(planeBuf, 0, planeData);
    device.queue.writeBuffer(presentBuf, 0, new Float32Array([state.exposure, 0, 0, 0]));

    const enc = device.createCommandEncoder();
    const scene = enc.beginRenderPass({
      colorAttachments: [{ view: hdrTex.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    });
    scene.setPipeline(scenePipe);
    scene.setBindGroup(0, sceneBind);
    scene.draw(6, perPlane * PLANES);
    scene.end();
    const present = enc.beginRenderPass({
      colorAttachments: [{ view: target, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    });
    present.setPipeline(pipe);
    present.setBindGroup(0, presentBind);
    present.draw(3);
    present.end();
    device.queue.submit([enc.finish()]);

    frames++;
    window.__depthDemo.frames = frames;
    window.__depthDemo.focusDist = depth.focusDist;
    hud = { perPlane, w, h };
  }

  let hud = { perPlane: 0, w: 0, h: 0 };
  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (dt > 0) fps += (1 / dt - fps) * 0.05;
    if (!ctx) return;
    render(dt, ctx.getCurrentTexture().createView(), presentPipe);
    const { perPlane, w, h } = hud;
    if (frames % 10 === 1) {
      $('hud').textContent =
        `${(perPlane * PLANES).toLocaleString()} particles\n` +
        `${PLANES} planes, ${w}x${h}\n` +
        `focus ${depth.focusDist.toFixed(1)}  fog cull ${depth.fogCullDistance().toFixed(0)}\n` +
        `${fps.toFixed(0)} fps`;
    }
    requestAnimationFrame(frame);
  }

  // Offscreen capture of exactly what the canvas shows. Used by automated
  // checks, because headless browsers cannot always read a WebGPU canvas.
  let readPipe: GPURenderPipeline | null = null;
  window.__depthDemo.readPixels = async (dt = 0) => {
    readPipe ??= makePresentPipe('rgba8unorm');
    resize();
    const w = canvas.width;
    const h = canvas.height;
    const tex = device.createTexture({
      size: [w, h], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    render(dt, tex.createView(), readPipe);
    const rowBytes = Math.ceil((w * 4) / 256) * 256;
    const buf = device.createBuffer({ size: rowBytes * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: rowBytes }, [w, h]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) data.set(src.subarray(y * rowBytes, y * rowBytes + w * 4), y * w * 4);
    buf.unmap();
    buf.destroy();
    tex.destroy();
    return { width: w, height: h, data };
  };
  window.__depthDemo.ready = true;
  if (!offscreen) requestAnimationFrame(frame);
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));

// Stateless motion demo: one sheet, one law, face-on. Every frame evaluates
// N particles from scratch (nothing is stored per particle), adds 1 per
// particle to a u32 count per pixel, and maps counts to brightness with a log
// curve. Compare laws, tune their params, and switch between hashed keys (what
// the offline renderer does) and a low-discrepancy grid (a preview of
// stratified sampling, much less grain at low counts).
//
// URL: ?law=galaxy&n=4194304&grid=1&speed=1&seed=3&shutter=0.5&p=2,2.4,...
import { STATELESS_LAWS, lawById, lawModuleWgsl, type StatelessLaw } from '../laws';

const $ = (id: string) => document.getElementById(id)!;
const canvas = $('c') as HTMLCanvasElement;
const ui = $('ui');
const stats = $('stats');
const msg = $('msg');
const url = new URLSearchParams(location.search);

const state = {
  law: lawById(url.get('law') ?? '') ?? STATELESS_LAWS[1],
  params: [] as number[],
  n: Number(url.get('n') ?? 1 << 22),
  grid: url.get('grid') === '1',
  speed: Number(url.get('speed') ?? 1),
  shutter: Number(url.get('shutter') ?? 0.5),
  seed: Number(url.get('seed') ?? 1) >>> 0,
  white: Number(url.get('white') ?? 24),
  paused: false,
  t: Number(url.get('t') ?? 0),
};
const urlParams = url.get('p')?.split(',').map(Number);
state.params = urlParams?.length === 8 && urlParams.every(Number.isFinite) ? urlParams : state.law.defaults.slice();

const PER_THREAD = 16;
const WG = 64;

function fail(text: string): never {
  msg.style.display = 'grid';
  msg.textContent = text;
  throw new Error(text);
}

if (!navigator.gpu) fail('This page needs WebGPU (Chrome, Edge or Safari 18+).');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter.');
const device = await adapter.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize },
});
device.lost.then((info) => fail(`GPU device lost: ${info.message}`));
const context = canvas.getContext('webgpu')!;
const format = navigator.gpu.getPreferredCanvasFormat();
context.configure({ device, format, alphaMode: 'opaque' });

// --- GPU resources --------------------------------------------------------

const UNIFORM_BYTES = 80;
const uniform = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const resolveUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
let counts: GPUBuffer | null = null;
let width = 0;
let height = 0;

// The on-screen count comes from the GPU: the splat tallies [evaluated, landed]
// and a few small staging buffers read it back without stalling the frame.
const tally = device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
const freeReadbacks: GPUBuffer[] = [];
let readbacksMade = 0;
let tallyFrame = -1;
const shown = { evaluated: 0, landed: 0 };

function takeReadback(): GPUBuffer | null {
  const free = freeReadbacks.pop();
  if (free) return free;
  if (readbacksMade >= 3) return null;
  readbacksMade++;
  return device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
}

function readTally(buffer: GPUBuffer, frameNo: number): void {
  buffer.mapAsync(GPUMapMode.READ).then(
    () => {
      const v = new Uint32Array(buffer.getMappedRange());
      if (frameNo > tallyFrame) {
        tallyFrame = frameNo;
        shown.evaluated = v[0];
        shown.landed = v[1];
      }
      buffer.unmap();
      freeReadbacks.push(buffer);
    },
    () => {},
  );
}

const STRUCT = /* wgsl */ `
struct U {
  p0: vec4f,
  p1: vec4f,
  t: f32,
  shutter: f32,
  seed: u32,
  n: u32,
  width: u32,
  height: u32,
  size: f32,
  rowStride: u32,
  offX: f32,
  offY: f32,
  grid: u32,
  perThread: u32,
}
`;

function splatWgsl(law: StatelessLaw): string {
  return /* wgsl */ `
${lawModuleWgsl([law])}
${STRUCT}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> counts: array<atomic<u32>>;
// GPU tally for the stats: [evaluated, landed] this frame.
@group(0) @binding(2) var<storage, read_write> tally: array<atomic<u32>, 2>;
var<workgroup> wgEvaluated: atomic<u32>;
var<workgroup> wgLanded: atomic<u32>;

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32) {
  let first = (g.x + g.y * u.rowStride) * u.perThread;
  var evaluated = 0u;
  var landed = 0u;
  if (first < u.n) {
    let last = min(first + u.perThread, u.n);
    let p = array<f32, 8>(u.p0.x, u.p0.y, u.p0.z, u.p0.w, u.p1.x, u.p1.y, u.p1.z, u.p1.w);
    for (var i = first; i < last; i++) {
      let key = particleKey(i, u.seed);
      var q = qFromKey(key);
      if (u.grid == 1u) {
        // Additive recurrence with the plastic-number ratios, in exact u32 fixed point.
        q = vec3f(u01(i * 0xd1b54a31u + 0x9e3779b9u), u01(i * 0xabc98389u + 0x7f4a7c15u), u01(i * 0x8cb92ba7u + 0x6a09e667u));
      }
      let tt = u.t + u.shutter * (u01(draw(key, 6u)) - 0.5);
      let pos = ${law.qFn}(q, tt, p);
      evaluated += 1u;
      let px = u.offX + (pos.x * 0.5 + 0.5) * u.size;
      let py = u.offY + (0.5 - pos.y * 0.5) * u.size;
      if (px >= 0.0 && py >= 0.0 && px < f32(u.width) && py < f32(u.height)) {
        atomicAdd(&counts[u32(py) * u.width + u32(px)], 1u);
        landed += 1u;
      }
    }
  }
  // One global atomic per workgroup for each count, not one per thread.
  atomicAdd(&wgEvaluated, evaluated);
  atomicAdd(&wgLanded, landed);
  workgroupBarrier();
  if (li == 0u) {
    atomicAdd(&tally[0], atomicLoad(&wgEvaluated));
    atomicAdd(&tally[1], atomicLoad(&wgLanded));
  }
}
`;
}

const RESOLVE = /* wgsl */ `
struct R { width: u32, height: u32, white: f32, _pad: f32 }
@group(0) @binding(0) var<storage, read> counts: array<u32>;
@group(0) @binding(1) var<uniform> r: R;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32(i == 1u) * 4.0 - 1.0;
  let y = f32(i == 2u) * 4.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let x = min(u32(pos.x), r.width - 1u);
  let y = min(u32(pos.y), r.height - 1u);
  let c = f32(counts[y * r.width + x]);
  let v = clamp(log(1.0 + c) / log(1.0 + r.white), 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}
`;

const resolveModule = device.createShaderModule({ code: RESOLVE, label: 'stateless:resolve' });
const resolvePipeline = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: resolveModule, entryPoint: 'vs' },
  fragment: { module: resolveModule, entryPoint: 'fs', targets: [{ format }] },
  primitive: { topology: 'triangle-list' },
});

const splatPipelines = new Map<string, GPUComputePipeline>();
async function splatPipeline(law: StatelessLaw): Promise<GPUComputePipeline> {
  const cached = splatPipelines.get(law.id);
  if (cached) return cached;
  const module = device.createShaderModule({ code: splatWgsl(law), label: `stateless:${law.id}` });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) fail(`${law.id}: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n')}`);
  const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  splatPipelines.set(law.id, pipeline);
  return pipeline;
}

let splatBind: GPUBindGroup | null = null;
let resolveBind: GPUBindGroup | null = null;
let pipeline = await splatPipeline(state.law);

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.min(4096, Math.floor(canvas.clientWidth * dpr)));
  const h = Math.max(1, Math.min(4096, Math.floor(canvas.clientHeight * dpr)));
  if (w === width && h === height && counts) return;
  width = w;
  height = h;
  canvas.width = w;
  canvas.height = h;
  counts?.destroy();
  counts = device.createBuffer({ size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  splatBind = null;
  resolveBind = device.createBindGroup({
    layout: resolvePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: counts } },
      { binding: 1, resource: { buffer: resolveUniform } },
    ],
  });
}

// --- UI -------------------------------------------------------------------

function slider(parent: HTMLElement, name: string, min: number, max: number, step: number, value: number,
  set: (v: number) => void, show: (v: number) => string = (v) => String(+v.toFixed(3))): void {
  const label = document.createElement('label');
  const input = document.createElement('input');
  const out = document.createElement('span');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.disabled = min === max;
  out.textContent = show(value);
  input.oninput = () => {
    const v = Number(input.value);
    out.textContent = show(v);
    set(v);
  };
  label.append(Object.assign(document.createElement('span'), { textContent: name }), input, out);
  parent.append(label);
}

const fmtCount = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}k`);
const exact = (v: number) => v.toLocaleString('en-US');

function buildUi(): void {
  const law = state.law;
  ui.innerHTML = '';
  const h1 = Object.assign(document.createElement('h1'), { textContent: 'STATELESS MOTION' });
  const select = document.createElement('select');
  for (const l of STATELESS_LAWS) select.append(new Option(l.title, l.id, false, l.id === law.id));
  select.onchange = () => void setLaw(lawById(select.value)!);
  const lawRow = document.createElement('label');
  lawRow.append(Object.assign(document.createElement('span'), { textContent: 'law' }), select);
  const summary = Object.assign(document.createElement('p'), { textContent: law.summary });
  const cost = Object.assign(document.createElement('p'), {
    textContent: `per particle: ${law.cost.transcendental} transcendental, about ${law.cost.fma} fma. ${law.cost.note}.`,
  });
  ui.append(h1, lawRow, summary, cost);
  ui.append(Object.assign(document.createElement('h2'), { textContent: 'PARAMS' }));
  law.params.forEach((param, i) => {
    const step = param.integer ? 1 : (param.max - param.min) / 200 || 1;
    slider(ui, param.name, param.min, param.max, step, state.params[i], (v) => (state.params[i] = v));
  });
  ui.append(Object.assign(document.createElement('h2'), { textContent: 'VIEW' }));
  slider(ui, 'particles', 16, 27, 1, Math.log2(state.n), (v) => (state.n = 2 ** v), (v) => fmtCount(2 ** v));
  slider(ui, 'time speed', 0, 4, 0.05, state.speed, (v) => (state.speed = v));
  slider(ui, 'shutter', 0, 2, 0.05, state.shutter, (v) => (state.shutter = v), (v) => `${v} fr`);
  slider(ui, 'white', 2, 400, 1, state.white, (v) => (state.white = v), (v) => `${v}x`);
  slider(ui, 'grid sampling', 0, 1, 1, state.grid ? 1 : 0, (v) => (state.grid = v === 1), (v) => (v ? 'on' : 'off'));
  slider(ui, 'key seed', 0, 999, 1, state.seed, (v) => (state.seed = v >>> 0));
}

async function setLaw(law: StatelessLaw): Promise<void> {
  pipeline = await splatPipeline(law);
  splatBind = null;
  state.law = law;
  state.params = law.defaults.slice();
  buildUi();
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === ' ') state.paused = !state.paused;
  else if (e.key === 'h' || e.key === 'H') ui.classList.toggle('hidden');
  else if (e.key === 's' || e.key === 'S') {
    const i = state.law.params.findIndex((x) => x.name === 'seed');
    if (i >= 0) state.params[i] = Math.floor(Math.random() * 1000);
    state.seed = Math.floor(Math.random() * 1000);
    buildUi();
  } else if (/^[1-9]$/.test(e.key) && STATELESS_LAWS[Number(e.key) - 1]) void setLaw(STATELESS_LAWS[Number(e.key) - 1]);
});

// --- frame loop -------------------------------------------------------------

const uniformData = new ArrayBuffer(UNIFORM_BYTES);
const uf = new Float32Array(uniformData);
const uu = new Uint32Array(uniformData);
const resolveData = new ArrayBuffer(16);
const rf = new Float32Array(resolveData);
const ru = new Uint32Array(resolveData);
let last = performance.now();
let fpsAvg = 0;
let frameNo = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fpsAvg = fpsAvg ? fpsAvg * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05 : 60;
  if (!state.paused) state.t += dt * state.speed;
  resize();
  const n = Math.max(1, Math.min(state.n, 2 ** 31)) >>> 0;
  const size = Math.min(width, height) * 0.96;
  const invocations = Math.ceil(n / PER_THREAD);
  const groups = Math.ceil(invocations / WG);
  const gx = Math.min(groups, 65535);
  const gy = Math.ceil(groups / gx);
  uf.set(state.params.slice(0, 8), 0);
  uf[8] = state.t;
  uf[9] = (state.shutter / 60) * state.speed;
  uu[10] = state.seed;
  uu[11] = n;
  uu[12] = width;
  uu[13] = height;
  uf[14] = size;
  uu[15] = gx * WG;
  uf[16] = (width - size) / 2;
  uf[17] = (height - size) / 2;
  uu[18] = state.grid ? 1 : 0;
  uu[19] = PER_THREAD;
  device.queue.writeBuffer(uniform, 0, uniformData);
  // White point: a multiple of the mean count on the sheet.
  const mean = n / (size * size);
  ru[0] = width;
  ru[1] = height;
  rf[2] = Math.max(2, state.white * mean);
  device.queue.writeBuffer(resolveUniform, 0, resolveData);
  splatBind ??= device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: counts! } },
      { binding: 2, resource: { buffer: tally } },
    ],
  });
  const encoder = device.createCommandEncoder();
  encoder.clearBuffer(counts!);
  encoder.clearBuffer(tally);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, splatBind);
  pass.dispatchWorkgroups(gx, gy);
  pass.end();
  const rp = encoder.beginRenderPass({
    colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
  });
  rp.setPipeline(resolvePipeline);
  rp.setBindGroup(0, resolveBind!);
  rp.draw(3);
  rp.end();
  const readback = takeReadback();
  if (readback) encoder.copyBufferToBuffer(tally, 0, readback, 0, 8);
  device.queue.submit([encoder.finish()]);
  if (readback) readTally(readback, frameNo);
  frameNo++;
  const counted = tallyFrame < 0
    ? '<b>...</b>\ncounting on the GPU'
    : `<b>${exact(shown.landed)}</b>\nparticles landed this frame\nof ${exact(shown.evaluated)} evaluated (GPU tally)`;
  stats.innerHTML = `${counted}\nstateless: rendered, not simulated\n${fpsAvg.toFixed(0)} fps, t = ${state.t.toFixed(1)} s\n${state.grid ? 'grid' : 'hashed'} sampling`;
  requestAnimationFrame(frame);
}

buildUi();
requestAnimationFrame(frame);

Object.assign(window, { __stateless: { state, laws: STATELESS_LAWS, setLaw } });

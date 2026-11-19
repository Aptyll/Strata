// Throwaway particle source for the render demo. Stateless: every particle's
// position is a closed form function of its index and time, so there is no
// simulation state to keep. It stands in for the real engine, which only has
// to hand the renderer a buffer of positions.
//
// Particles use the engine layout from src/core/contracts.ts: 16 bytes,
// pos.xy and vel.xy in plane-local space. One buffer holds every plane back
// to back, and each plane carries one of four patterns picked for strong
// density contrast.

import { PCG_WGSL, U01_WGSL } from '../../gpu/wgsl';

const WGSL = PCG_WGSL + U01_WGSL + /* wgsl */ `
struct Sim { time: f32, count: u32, planes: u32, pad: u32 };
@group(0) @binding(0) var<uniform> s: Sim;
@group(0) @binding(1) var<storage, read_write> particles: array<vec4f>;

const TAU = 6.2831853;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x + gid.y * 4194304u;
  if (i >= s.count) { return; }
  let per = max(s.count / s.planes, 1u);
  let plane = min(i / per, s.planes - 1u);
  let h0 = pcg(i);
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  let r = vec3f(u01(h0), u01(h1), u01(h2));
  let t = s.time;
  let ph = f32(plane) * 1.7;
  var p: vec2f;
  switch plane % 4u {
    case 0u {
      // Folded sheet. A uniform square pushed through two sine warps piles
      // up along caustic lines, like light on the bottom of a pool.
      var q = r.xy * 2.0 - 1.0;
      q += 0.20 * sin(q.yx * 5.0 + vec2f(t * 0.50 + ph, t * 0.37));
      q += 0.10 * sin(q.yx * 11.0 + vec2f(-t * 0.60, t * 0.45 + ph));
      q += 0.04 * sin(q.yx * 23.0 + vec2f(t * 0.80 + ph, -t * 0.70));
      p = q * 0.85;
    }
    case 1u {
      // Spiral arms around a dense core.
      let rad = pow(r.x, 1.7) + 0.01;
      let arm = floor(r.z * 3.0);
      let spread = (r.y + fract(r.z * 37.0) - 1.0) * (0.25 + 0.9 * rad);
      let th = arm * TAU / 3.0 + 2.6 * log(rad + 0.04) + spread + t * 0.12 + ph;
      let wob = 0.015 * sin(t * 1.5 + r.z * 50.0);
      p = (rad + wob) * vec2f(cos(th), sin(th));
    }
    case 2u {
      // Thin counter rotating rings with standing waves.
      let n = floor(r.x * 28.0);
      var rad = (n + 1.0) / 29.0 + (r.y - 0.5) * 0.003;
      let dir = 1.0 - 2.0 * f32(u32(n) & 1u);
      let th = r.z * TAU + dir * t * (0.10 + 0.01 * n);
      rad += 0.012 * sin(th * (3.0 + f32(u32(n) % 5u)) + t * 1.3 + ph);
      p = rad * vec2f(cos(th), sin(th));
    }
    default {
      // Bundle of Lissajous strands.
      let a = r.x * TAU;
      let k = floor(r.y * 48.0);
      let j = (r.z - 0.5) * 0.004;
      p = 0.92 * vec2f(
        sin(3.0 * a + k * 0.021 + t * 0.20),
        sin(4.0 * a + ph + k * 0.013 - t * 0.13)) + j;
    }
  }
  // Engine particle layout: pos.xy, vel.xy, plane-local. This demo has no
  // use for velocity.
  particles[i] = vec4f(p, 0.0, 0.0);
}
`;

export class DemoSim {
  readonly device: GPUDevice;
  readonly count: number;
  readonly buffer: GPUBuffer;
  private ubo: GPUBuffer;
  private pipeline: GPUComputePipeline;
  private bind: GPUBindGroup;

  constructor(device: GPUDevice, count: number) {
    this.device = device;
    this.count = count;
    this.buffer = device.createBuffer({
      size: count * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    });
    this.ubo = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.bind = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubo } },
        { binding: 1, resource: { buffer: this.buffer } },
      ],
    });
  }

  encode(encoder: GPUCommandEncoder, time: number, planes: number): void {
    const b = new ArrayBuffer(16);
    const f = new Float32Array(b);
    const u = new Uint32Array(b);
    f[0] = time;
    u[1] = this.count;
    u[2] = planes;
    this.device.queue.writeBuffer(this.ubo, 0, b);
    const groups = Math.ceil(this.count / 256);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.dispatchWorkgroups(Math.min(groups, 16384), Math.ceil(groups / 16384));
    pass.end();
  }

  destroy(): void {
    this.buffer.destroy();
    this.ubo.destroy();
  }
}

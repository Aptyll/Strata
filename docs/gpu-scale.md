# GPU rules for very large particle counts

Review notes on the shared contracts, and the mistakes to avoid in any shader
that should scale to hundreds of millions of particles. Facts marked
(checked) are asserted on a real WebGPU device by `npm run verify`.

## Limits that cap the particle count

| limit | default | what it caps |
| --- | --- | --- |
| `maxStorageBufferBindingSize` | 128 MiB | 8,388,608 particles per plane (16 bytes each) |
| `maxBufferSize` | 256 MiB | 16,777,216 particles per buffer |
| `maxComputeWorkgroupsPerDimension` | 65,535 | 4,194,240 particles per 1D dispatch at `@workgroup_size(64)` |
| `maxComputeInvocationsPerWorkgroup` | 256 | `@workgroup_size` product |
| `maxTextureDimension2D` | 8192 | render and field targets |

1. **Ask for the size limits.** `requestDevice()` with no arguments gives the
   defaults even on a card with 24 GB. Pass
   `requiredLimits: particleScaleLimits(adapter)` (`src/verify/limits.ts`).
2. **Dispatch in 2D past 4.19M particles.** Use `planDispatch(count, 64)`,
   call `dispatchWorkgroups(plan.x, plan.y)`, and compute the index as
   `gid.x + gid.y * rowStride`. (checked)
3. **Always early-out.** `if (i >= count) { return; }` at the top of every
   compute entry point. The last workgroup overshoots, and a write past the end
   of a buffer may be clamped onto its last element.
4. **Split what does not fit.** A plane above the per-buffer limit needs
   several buffers or several bindings of one buffer, each dispatched alone.

## Precision

5. **Never turn a particle index into a float.** f32 is exact only up to
   16,777,216. Above that, neighbours share one value. (checked) Hash the u32.
6. **Unit floats take 24 bits.** `f32(h) / 4294967296.0` returns exactly 1.0
   for the top hash values, once per 17 to 33 million draws, which at these
   counts is several times a frame. (checked) Use
   `f32(h >> 8u) * (1.0 / 16777216.0)`. `rand()` must never return 1.
7. **Clamp pixel and cell indices.** `u32(uv * size)` can equal `size` for
   `uv` just below 1, which lands in the next row. Use `min(.., size - 1u)`.
8. **Half float accumulation saturates.** Adding the same small value to an
   `rgba16float` pixel stops changing it after about 2048 additions (11 bit
   mantissa). Dense regions need a count buffer (`u32`) or a wider target.

## Races

9. **Scatter writes need atomics.** `grid[cell] += 1u` from many invocations
   loses updates. The same shader without atomics lost about a fifth of its
   counts in a verify run. (checked) Use `array<atomic<u32>>` and
   `atomicAdd`, with fixed point for fractional weights.
10. **In-place updates are safe only when each invocation writes its own
    element** and reads nothing another invocation writes. A behavior that
    reads neighbours needs a second buffer (ping-pong) or a field built in an
    earlier pass.
11. **Clear before accumulate.** A count or field buffer must be zeroed each
    frame in a pass that finishes before the first `atomicAdd`.

## Speed

Not measured yet. These follow from how GPUs work and need confirming on
real hardware.

12. **Memory bandwidth is the budget.** One step reads and writes 16 bytes per
    particle, and drawing reads them again. At 100M particles that is about
    4.8 GB per frame before any pixel is written. Packing position into two
    16 bit values would halve it, at the cost of slow particles needing
    dithered rounding.
13. **One pixel points through the rasterizer are slow per particle.** Each
    point pays triangle setup and a blended read-modify-write of 8 bytes into
    `rgba16float`. Compute rasterization (project in a compute shader,
    `atomicAdd` into a `u32` count buffer, resolve in one fullscreen pass) is
    the usual way past roughly 10 to 30 million points. Particles are white
    only, so one channel is enough.
14. **Keep stepping coherent.** Particles in buffer order should stay near
    each other in space where possible, so that field lookups and count
    writes hit the same cache lines. A periodic sort by cell pays for itself
    once random access dominates.
15. **Avoid data dependent branches in the inner loop.** Prefer `select`,
    `step` and arithmetic. Keep `if` for the bounds early-out and for rare
    paths such as respawn.

## Contract review (src/core/contracts.ts)

- The 16 byte particle, the 112 byte plane uniform and the 80 byte globals
  block are laid out correctly for WGSL alignment.
- Nothing in the contracts says who requests device limits or how large
  dispatches are split. Rules 1 and 2 belong to whoever creates the device and
  the simulate pass.
- `hdrFormat` is `rgba16float`. Fine for the default view. Rule 8 applies to
  dense scenes, and rule 13 to the particle count challenge.
- `Globals.time` as f32 seconds is exact to 0.25 ms after one hour, which is
  enough. Offline renders longer than a few hours should pass frame numbers.
- Behaviors update in place and cannot read other particles, which makes rule
  10 hold by construction.

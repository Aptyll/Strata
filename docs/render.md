# Rendering: density beyond screen resolution

`src/render/` turns "many particles landed on this pixel" into a picture. The
goal is that a frame with more particles than pixels still reads as structure,
with dense regions as smooth brightness gradients instead of flat white.

Everything is monochrome. The pipeline carries one float per pixel and only
expands it to white on black at the very end.

```
particles -> splat -> density (HDR, one float per pixel)
                        -> trails -> bloom -> tone map -> target
```

Try it: `npm run dev`, then open `/src/render/demo/`.

## The idea

A particle does not have a colour, it deposits energy. Energy adds up per
pixel without any clamp, so the buffer holds a density: 1 where one particle
sits, 5000 where five thousand overlap. An 8 bit additive target would be
white from 255 particles on; the float buffer keeps counting, and the tone
mapper decides afterwards how density becomes brightness.

The default curve is logarithmic. Going from 1 to 10 particles on a pixel
brightens it by the same step as going from 100 to 1000, so both the sparse
dust and the dense cores keep visible structure.

## Modules

| file | what it does |
| --- | --- |
| `splat.ts` | `SplatAccumulator`: particles to density, three modes |
| `trails.ts` | `Trails`: temporal accumulation on density |
| `bloom.ts` | `Bloom`: threshold, down chain, additive up chain |
| `tonemap.ts` | `ToneMap`: density curve, display curve, sRGB, dither |
| `post.ts` | `DensityPost`: trails + bloom + tone map on any density view |
| `pipeline.ts` | `DensityRenderer`: splat + post in one object |
| `passes.ts` | `Pass` adapters for the frame graph in `src/core/contracts.ts` |
| `demo/` | standalone page with its own throwaway particle source |

Each class takes a `GPUDevice`, has `resize(width, height)`, encodes into a
`GPUCommandEncoder` you pass in, and has `destroy()`. None of them touch the
canvas or own a frame loop.

## Using it

### From the frame graph

The app already uses it: `src/passes/tonemap.pass.ts` builds the density tone
map pass by default. Its live settings are on `strataLook` in the browser
console (`strataLook.tone.white = 400`, `strataLook.bloom.strength = 0`,
`strataLook.trails.halfLife = 0.3`). Open the app with `?tonemap=basic` to get
the earlier plain exponential curve back for comparison.

`createDensityTonemapPass()` is a stage `tonemap` pass. It reads
`frame.hdrView` (red channel) and writes `frame.canvasView`. Use it in place
of a plain tone map pass.

```ts
import { createDensityTonemapPass } from '../render';

const tonemap = createDensityTonemapPass();
passes.push(tonemap);
// later, once it has run or been resized:
tonemap.post!.settings.tone.white = 200;
```

`createDensitySplatPass()` is a stage `rasterize` pass that draws every
plane's active particles into `frame.hdrView` with sub-pixel splatting. It is
an alternative to one pixel points with the same additive result.

### Offline and challenge renders

`DensityPost` is the piece to use when something else already produced a
density texture. It has no dependency on the engine contracts.

```ts
import { DensityPost } from '../render';

const post = new DensityPost(device, { format: targetFormat });
post.resize(width, height);
post.settings.tone.white = 24 * particles / (width * height);

// per frame
post.encode(encoder, densityView, targetView, 1 / 60);
```

- `densityView` is any float texture view of the target's size with density
  in red: `rgba16float`, `r16float`, `r32float`.
- `targetView` can be the canvas or an offscreen texture of `format`.
- Pass a constant `dt` and the result is deterministic. The only per frame
  state is the trail history and a frame counter for dither;
  `post.reset()` drops the history and `post.frame = n` pins the dither.
- For a single still with no history, set `settings.trails.enabled = false`.

### Standalone

```ts
import { DensityRenderer } from '../render';

const renderer = new DensityRenderer(device, { format: canvasFormat, mode: 'compute' });
renderer.resize(width, height);
renderer.render(encoder, {
  batches: [{ buffer, count, mvp, stride: 16, dims: 2 }],
  target: canvasView,
  dt,
});
```

A batch is a range of a particle buffer plus a model view projection matrix.
`stride` and `offset` say where the position sits in a particle, and `dims`
whether it is a `vec3f` or a `vec2f` on the z = 0 plane. Engine planes are
`stride: 16, offset: 0, dims: 2` with `mvp = viewProj * planeModel`.

## Splat modes

| mode | how | use when |
| --- | --- | --- |
| `point` | point list, one fragment per particle | cheapest raster path; particles snap to whole pixels |
| `quad` | instanced quads with a tent kernel | you want smooth sub-pixel motion or particles larger than a pixel |
| `compute` | compute shader, atomic add into a per pixel counter | particles outnumber pixels |

Sub-pixel rendering means two things here.

1. Position. `quad` and `compute` split each particle's energy over the 2x2
   pixels around its true position (bilinear weights). A particle drifting a
   tenth of a pixel changes the image by a tenth, so slow motion is smooth and
   regular lattices do not alias into moire as hard.
2. Size. A particle with apparent diameter `d` pixels deposits
   `energy * d * d`. Below one pixel that is the fraction of the pixel it
   covers, so with `attenuate: true` far particles dim instead of all
   rendering as full one pixel dots.

`compute` skips the rasteriser. Each particle is projected in a compute
shader and added into a `u32` grid with `atomicAdd`, in fixed point
(`fixedScale` steps per unit of energy, default 256) with stochastic rounding
so dim contributions survive on average. A fullscreen pass then copies the
grid into the density target. The cost is one invocation and at most four
atomic adds per particle, independent of overdraw.

Particle buffers need `VERTEX` usage for the raster modes and `STORAGE` for
`compute`. Engine plane buffers have both.

## Precision limits

This matters for the particle count challenge.

| density target | exact up to | notes |
| --- | --- | --- |
| `r16float` / `rgba16float` | about 2048 units per pixel | past that, adding 1 no longer changes the value |
| `r32float` | about 16.7 million units per pixel | additive blending needs the `float32-blendable` device feature |
| compute grid (`u32`) | 16.7 million units per pixel at `fixedScale` 256 | independent of the target format until the resolve |

`SplatAccumulator` picks `r32float` for its own texture when the device has
`float32-blendable`, otherwise `r16float`. The engine's shared HDR target is
`rgba16float`, so additive points into it stop counting at roughly 2048
overlapping particles per pixel at brightness 1. Ways around that for extreme
counts: lower the energy per particle and raise `exposure` by the same factor
(half float keeps 11 bits of mantissa at any scale), or splat with `compute`
into the accumulator's own texture and hand that view to `DensityPost` or to
`createDensityTonemapPass({ source })`.

## Tone mapping

```
luma  = curve(density * exposure)      // 1.0 at the white point
luma += bloom
value = display(luma)                  // roll off above 1.0
out   = srgb(value) + dither
```

Settings (`post.settings.tone`):

| setting | default | meaning |
| --- | --- | --- |
| `exposure` | 1 | multiplies density |
| `white` | 64 | exposed density that reaches full white |
| `curve` | `log` | `log`: `log(1+x)/log(1+white)`. `power`: `(x/white)^power`. `linear`: `x/white` |
| `power` | 0.5 | exponent for `power` |
| `display` | `soft` | `soft`: identity up to 0.75, then a smooth shoulder. `filmic`: ACES style fit with a toe, more contrast, sparse dust sinks toward black. `clip`: hard clamp |
| `dither` | 1 | triangular noise in 8 bit steps; stops banding in dark gradients |

`white` is the control that matters most. A good starting point is a multiple
of the mean density, around `24 * particles * energy / pixels`; the demo does
that when `white` is left on auto. There is no automatic exposure from the
image itself yet.

## Bloom

The prefilter converts density to luma with the same curve as the tone
mapper, subtracts `threshold`, and halves the resolution. Blooming luma
instead of raw density is deliberate: raw density spans orders of magnitude
and its blur would be nothing but the few densest cores. Up to six octaves
are then blurred down and summed back up.

`post.settings.bloom`: `enabled`, `strength` (default 0.35), `threshold`
(default 0.55, in luma, so only the brighter half of the range glows).

## Trails

`Trails` blends each frame's density into a history, before tone mapping.

- `max` (default): `out = max(current, history * decay)`. The present stays
  at full strength with a fading tail behind it. A static image is unchanged.
- `ema`: `out = mix(current, history, decay)`. A running average, like a long
  exposure. Movement becomes smooth streaks and sub-pixel shimmer averages
  out.

`post.settings.trails`: `enabled`, `mode`, `halfLife` in seconds (default
0.12). Decay is computed from `dt`, so trails have the same length at any
frame rate.

Trails live in screen space. When the camera moves, the history smears with
it; that reads as motion blur at slow rotation and should be reset with
`post.reset()` on a cut.

## Demo

`/src/render/demo/` renders a stack of planes filled by a stateless compute
shader (four patterns: folded caustic sheets, spiral arms, rings, Lissajous
bundles). It uses the engine particle layout and one batch per plane, so it
exercises the same path the engine would.

The readout in the corner shows particles per pixel. Drag to orbit, wheel to
zoom, H hides the panel, space pauses. Every control is also a URL parameter:

```
/src/render/demo/?count=16000000&mode=compute&trail=0.3&clean
```

`&offscreen` renders to a texture and never presents to the canvas, and
`strataDemo.capture()` in the console returns the current frame as RGBA
bytes. Both exist for headless testing.

## What was verified, and what was not

Checked in headless Chromium on a software GPU (SwiftShader), 1M particles at
960 x 540: every shader compiles, `compute` and `quad` render the full chain
(splat, trails, bloom, tone map) to images that agree to within 0.01 of mean
8 bit brightness, the output is strictly monochrome, and 0.01% of pixels are
saturated.

Not checked: `point` mode was not rendered (it shares its projection and
energy code with `quad`, but that run was cut short), the two frame graph
passes in `passes.ts` have only been type checked because there is no engine
to run them in yet, and nothing here was run on real hardware. The statements
above about which mode is faster come from how the techniques work, not from
measurements.

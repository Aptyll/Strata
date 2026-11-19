// Strata depth cues: WGSL library.
//
// Exported as a JS string so it can be concatenated in front of any shader
// module without a bundler. Everything is prefixed `depth_` / `Depth` so it
// will not collide with engine code. Monochrome only: every function returns
// scalar intensities, never colour.
//
// Conventions:
//   - "viewZ" is the positive distance along the view axis. With a
//     perspective projection that is simply clip.w.
//   - "dist" is the straight line distance from the eye to the particle
//   - radii are in physical pixels
//
// The struct layout must match DEPTH_PARAMS_FLOATS / DepthParams.pack() in
// params.ts (20 f32, 80 bytes, no implicit padding).

export const depthWGSL: string = /* wgsl */ `
struct DepthParams {
  // fog: fade into black
  fogDensity: f32,      // 1 / world units. 0 disables fog
  fogPower: f32,        // 1 = exponential, 2 = exponential squared
  fogStart: f32,        // world units before fog begins
  nearFade: f32,        // particles closer than this fade out. 0 disables

  // depth of field
  focusDist: f32,       // viewZ that is perfectly sharp
  aperture: f32,        // circle of confusion radius (px) at infinity. 0 disables
  maxCocPx: f32,        // largest sprite radius, in focus or not
  focusRange: f32,      // world units either side of focusDist that stay sharp

  // atmospheric perspective
  baseSize: f32,        // particle radius in world units
  sizeAttenuation: f32, // 0 = constant pixel size, 1 = true perspective
  minPx: f32,           // smallest radius rasterised; below it size becomes dimming
  brightness: f32,      // surface brightness of a sharp, resolved particle

  // projection
  viewportH: f32,       // render target height in px
  projScaleY: f32,      // projection[1][1] = 1 / tan(fovY / 2)
  distDim: f32,         // extra artistic dimming exponent vs distance. 0 disables
  refDist: f32,         // distance at which baseSize is measured

  bokehEdge: f32,       // 0 = flat disc, >0 = brighter rim on defocused discs
  cullIntensity: f32,   // sprites dimmer than this may be discarded
  pointGainMax: f32,    // cap on the brightness gain of near particles in the point path
  pad1: f32,
};

struct DepthSprite {
  radiusPx: f32,   // radius to rasterise
  intensity: f32,  // per pixel additive intensity inside the disc
  defocus: f32,    // 0 = sharp, 1 = entirely circle of confusion
};

// Transmittance through the black fog: 1 near the camera, 0 far away.
fn depth_fog(dist: f32, p: DepthParams) -> f32 {
  let d = max(dist - p.fogStart, 0.0) * p.fogDensity;
  return exp(-pow(d, max(p.fogPower, 0.001)));
}

// Fade for particles about to pass through the lens.
fn depth_near_fade(viewZ: f32, p: DepthParams) -> f32 {
  let f = clamp(viewZ / max(p.nearFade, 1e-6), 0.0, 1.0);
  return f * f * (3.0 - 2.0 * f);
}

// Circle of confusion radius in pixels (thin lens, simplified).
fn depth_coc_px(viewZ: f32, p: DepthParams) -> f32 {
  let off = max(abs(viewZ - p.focusDist) - p.focusRange, 0.0);
  return min(p.aperture * off / max(viewZ, 1e-4), p.maxCocPx);
}

// Geometric (in focus) radius in pixels after size attenuation.
fn depth_geo_radius_px(viewZ: f32, p: DepthParams) -> f32 {
  let rRef = p.baseSize * p.projScaleY * p.viewportH * 0.5 / p.refDist;
  return min(rRef * pow(p.refDist / max(viewZ, 1e-4), p.sizeAttenuation), p.maxCocPx);
}

// Everything except the size dependent energy term.
fn depth_attenuation(viewZ: f32, dist: f32, p: DepthParams) -> f32 {
  let dim = pow(1.0 + dist / p.refDist, -p.distDim);
  return p.brightness * depth_fog(dist, p) * depth_near_fade(viewZ, p) * dim;
}

// Full cue stack for a sprite (quad) renderer. Energy conserving: a particle
// that is blurred or smaller than a pixel spreads the same light over the
// area actually drawn, so dense far planes melt into a smooth haze instead of
// aliasing or blowing out.
fn depth_sprite(viewZIn: f32, dist: f32, p: DepthParams) -> DepthSprite {
  let viewZ = max(viewZIn, 1e-4);
  let rGeo = depth_geo_radius_px(viewZ, p);
  let coc = depth_coc_px(viewZ, p);
  let r = sqrt(rGeo * rGeo + coc * coc);
  let rDraw = clamp(r, p.minPx, max(p.maxCocPx, p.minPx));
  var s: DepthSprite;
  s.radiusPx = rDraw;
  s.intensity = depth_attenuation(viewZ, dist, p) * (rGeo * rGeo) / (rDraw * rDraw);
  s.defocus = coc / max(r, 1e-6);
  return s;
}

// Cheap path for engines that draw 1 px point primitives and cannot grow a
// sprite. Fog, size dimming and the energy loss of defocus are kept, the blur
// itself is not drawn.
fn depth_point_intensity(viewZIn: f32, dist: f32, p: DepthParams) -> f32 {
  let viewZ = max(viewZIn, 1e-4);
  let rGeo = depth_geo_radius_px(viewZ, p);
  let coc = depth_coc_px(viewZ, p);
  let rr = max(rGeo * rGeo + coc * coc, 1.0);
  return depth_attenuation(viewZ, dist, p) * rGeo * rGeo / rr;
}

// ---- Point and accumulation renderers (offline, record scale) -------------
// These draw each particle as a single sample, so they cannot grow a sprite.
// Depth of field comes from lens sampling instead: every particle is nudged
// by a random point inside its circle of confusion. One sample is noise; a
// dense plane, or many accumulated frames, converges to the same bokeh the
// sprite path draws, at no extra cost per particle.

// Weight of one sample: fog, near fade, brightness, and the size cue turned
// into gain (a particle twice as close covers four times the area, so it
// carries four times the light, capped by pointGainMax). Use this together
// with depth_lens_jitter_px; the jitter does the defocus spreading, so no
// energy is removed for blur here.
fn depth_point_weight(viewZIn: f32, dist: f32, p: DepthParams) -> f32 {
  let viewZ = max(viewZIn, 1e-4);
  let gain = min(pow(p.refDist / viewZ, 2.0 * p.sizeAttenuation), max(p.pointGainMax, 1.0));
  return depth_attenuation(viewZ, dist, p) * gain;
}

// Pixel offset for one lens sample. u is two independent uniform numbers in
// [0, 1), different per particle (and per frame if frames are accumulated).
// bokehEdge pushes samples toward the rim, matching depth_bokeh.
fn depth_lens_jitter_px(viewZ: f32, u: vec2f, p: DepthParams) -> vec2f {
  let coc = depth_coc_px(viewZ, p);
  // Radial density 1 + e t^4: a uniform disc (radius sqrt(u)) mixed with a rim
  // term (radius u^(1/6)) that is picked with probability e / (3 + e). The
  // pick reuses the low bits of u.y, which the angle does not visibly need.
  let e = p.bokehEdge;
  let rim = fract(u.y * 64.0) < e / (3.0 + e);
  let r = select(sqrt(u.x), pow(u.x, 1.0 / 6.0), rim);
  let a = 6.2831853 * u.y;
  return coc * r * vec2f(cos(a), sin(a));
}

// The same offset in NDC. Multiply by clip.w and add to clip.xy.
fn depth_lens_jitter_ndc(viewZ: f32, u: vec2f, viewport: vec2f, p: DepthParams) -> vec2f {
  return depth_lens_jitter_px(viewZ, u, p) * 2.0 / viewport;
}

// NDC offset for one quad corner (corner in [-1, 1]^2). Multiply by clip.w
// and add to clip.xy. The quad is padded by 1 px for the antialiased edge.
fn depth_quad_offset(corner: vec2f, radiusPx: f32, viewport: vec2f) -> vec2f {
  return corner * (radiusPx + 1.0) * 2.0 / viewport;
}

// Pixel offset from the sprite centre for the same corner. Pass it to the
// fragment stage as an interpolated varying.
fn depth_quad_px(corner: vec2f, radiusPx: f32) -> vec2f {
  return corner * (radiusPx + 1.0);
}

// Fragment coverage of the disc. px is the interpolated pixel offset from the
// centre. Sharp sprites are a flat antialiased dot; defocused ones become a
// bokeh disc whose rim brightens with bokehEdge while keeping total energy.
fn depth_bokeh(px: vec2f, radiusPx: f32, defocus: f32, p: DepthParams) -> f32 {
  let d = length(px);
  let disc = clamp(radiusPx + 0.5 - d, 0.0, 1.0);
  let t = clamp(d / max(radiusPx, 1e-4), 0.0, 1.0);
  let e = p.bokehEdge * defocus;
  let t2 = t * t;
  let rim = (1.0 + e * t2 * t2) / (1.0 + e / 3.0);
  return disc * rim;
}
`;

export default depthWGSL;

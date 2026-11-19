// Records short clips of the Strata app in headless Chromium (software WebGPU),
// one per "look" (a dice roll seed + theme + camera move), with a fixed dt per
// frame, then writes one MP4 per look and a JSON sidecar with what the GPU drew.
//
//   node tools/montage/record-looks.mjs <looks.json> <outDir> [--only i,j]
//
// looks.json: { width, height, fps, particles, warmup, frames, looks: [
//   { name, seed, theme, camera: { focusPlane?, rotate?: [yaw, pitch], zoom?, orbitRate? } } ] }
//
// Software GPU: this shows the look and motion, never real-GPU speed.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [lookFile, outDir] = process.argv.slice(2);
const onlyArg = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const cfg = JSON.parse(readFileSync(lookFile, 'utf8'));
mkdirSync(outDir, { recursive: true });
const only = onlyArg ? new Set(onlyArg.split(',').map(Number)) : null;

// Same ramps and sampling as src/ux/theme/index.ts (an SVG filter in sRGB on the canvas,
// which a texture readback does not see), applied here to the read-back pixels.
const themeSrc = readFileSync(join(here, '../../src/ux/theme/index.ts'), 'utf8');
function themeLut(id) {
  const m = new RegExp(`id: "${id}"[^\\n]*stops: (\\[.*\\])\\s*\\}`).exec(themeSrc);
  const stops = m ? JSON.parse(m[1]) : [];
  if (stops.length < 2) return null;
  const n = 17, last = stops.length - 1, table = [[], [], []];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * last, a = Math.min(last - 1, Math.floor(t)), f = t - a;
    for (let c = 0; c < 3; c++) table[c].push(+(stops[a][c] * (1 - f) + stops[a + 1][c] * f).toFixed(3));
  }
  const lut = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const x = v / 255, k = Math.min(n - 2, Math.floor(x * (n - 1))), f = x * (n - 1) - k;
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = Math.round(255 * (table[c][k] + (table[c][k + 1] - table[c][k]) * f));
  }
  return lut;
}

const server = await createServer({ root: join(here, '../..'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
});
const shim = readFileSync(join(here, 'shim.js'), 'utf8');
const dtMs = 1000 / cfg.fps;

try {
  for (const [i, look] of cfg.looks.entries()) {
    if (only && !only.has(i)) continue;
    const t0 = Date.now();
    const page = await browser.newPage({ viewport: { width: cfg.width, height: cfg.height }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.log(`[${look.name}] page error:`, e.message));
    await page.addInitScript({ content: shim });
    const query = `?intro=0&particles=${cfg.particles}${look.query ? '&' + look.query : ''}`;
    await page.goto(`${base}${query}#r=${look.seed}`);
    await page.waitForFunction(() => window.strata, null, { timeout: 120000 });
    await page.evaluate(() => window.__step(1000 / 30)); // first frame: scene and roll are in place
    const adapter = await page.evaluate(async () => {
      const a = await navigator.gpu.requestAdapter();
      return a?.info ? `${a.info.vendor} ${a.info.architecture} ${a.info.device} ${a.info.description}`.trim() : 'unknown';
    });
    await page.evaluate((cam) => {
      const rig = window.strata.camera.rig;
      const idle = rig.options.idle;
      idle.enabled = true;
      idle.delay = 0;
      idle.rampIn = 0.5;
      idle.orbitRate = cam.orbitRate ?? 0.12;
      if (cam.focusPlane != null) rig.focusPlane(rig.planes?.[cam.focusPlane] ?? window.strata.planes[cam.focusPlane], {});
      if (cam.rotate) rig.rotate(cam.rotate[0], cam.rotate[1]);
      if (cam.zoom) rig.zoom(cam.zoom);
    }, look.camera ?? {});
    for (let f = 0; f < cfg.warmup; f++) await page.evaluate((ms) => window.__step(ms), dtMs);

    const scene = await page.evaluate(() =>
      window.strata.planes.map((p) => ({ behavior: p.desc.behaviorId, params: p.desc.params, capacity: p.capacity, active: p.activeCount })),
    );
    const lut = themeLut(look.theme ?? 'white');
    const file = join(outDir, `${String(i).padStart(2, '0')}-${look.name}.mp4`);
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${cfg.width}x${cfg.height}`,
      '-r', String(cfg.fps), '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', file], { stdio: ['pipe', 'inherit', 'inherit'] });
    const counts = [];
    let lit = 0;
    for (let f = 0; f < cfg.frames; f++) {
      await page.evaluate((ms) => window.__step(ms), dtMs);
      const g = await page.evaluate(() => window.__grab());
      counts.push(await page.evaluate(() => window.strata.stats().particles));
      const px = Buffer.from(g.b64, 'base64');
      const bgra = g.format.startsWith('bgra');
      for (let p = 0; p < px.length; p += 4) {
        if (bgra) { const b = px[p]; px[p] = px[p + 2]; px[p + 2] = b; }
        if (lut) {
          const l = Math.min(255, Math.round(0.2126 * px[p] + 0.7152 * px[p + 1] + 0.0722 * px[p + 2]));
          px[p] = lut[l * 3]; px[p + 1] = lut[l * 3 + 1]; px[p + 2] = lut[l * 3 + 2];
        }
        px[p + 3] = 255;
        if (f === cfg.frames - 1 && px[p] + px[p + 1] + px[p + 2] > 24) lit++;
      }
      if (!ff.stdin.write(px)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    const meta = {
      index: i, ...look, url: `/${query}#r=${look.seed}`, adapter, width: cfg.width, height: cfg.height, fps: cfg.fps,
      warmupFrames: cfg.warmup, frames: cfg.frames,
      particlesSteppedPerFrame: { min: Math.min(...counts), max: Math.max(...counts) },
      litFractionLastFrame: +(lit / (cfg.width * cfg.height)).toFixed(4),
      planes: scene, seconds: (Date.now() - t0) / 1000,
    };
    writeFileSync(file.replace(/\.mp4$/, '.json'), JSON.stringify(meta, null, 2));
    console.log(`[${look.name}] done in ${meta.seconds.toFixed(0)} s, ${meta.particlesSteppedPerFrame.min}..${meta.particlesSteppedPerFrame.max} particles, lit ${meta.litFractionLastFrame}`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

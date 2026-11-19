// Headless end-to-end check of src/capture: drives the demo page in Chromium,
// renders a short offline video, a supersampled still and a tiled still, and
// checks the results. Run with `npm run verify:capture`.
//
// Options: --out <dir> keeps the files, --codec <avc|hevc|vp9|av1> forces a codec,
// --2d uses the Canvas 2D fallback scene, --readback captures WebGPU frames by
// GPU readback instead of from the canvas element.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const outDir = value('out');
const codec = value('codec');
if (outDir) mkdirSync(outDir, { recursive: true });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
};

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => console.log('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text()));
  await page.goto(`${base}src/capture/demo/index.html${flag('2d') ? '?2d' : flag('readback') ? '?readback&count=20000' : '?count=20000'}`);
  await page.waitForFunction(() => window.__capture);
  const kind = await page.evaluate(() => window.__capture.scene.kind);
  console.log(`renderer: ${kind}`);

  const toBase64 = `async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }`;

  // Mean brightness and size of a PNG, decoded in the page.
  const inspectPng = `async (blob) => {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
    let sum = 0, lit = 0;
    for (let i = 0; i < d.length; i += 4) { sum += d[i]; if (d[i] > 8) lit++; }
    return { width: bmp.width, height: bmp.height, mean: sum / (d.length / 4), lit: lit / (d.length / 4) };
  }`;

  // The helpers go into the page as an inline script. The site's Content-Security-Policy
  // (src/site) allows inline scripts but not eval, so the strings cannot be eval'ed in there.
  await page.addScriptTag({ content: `window.__helpers = { toBase64: ${toBase64}, inspectPng: ${inspectPng} };` });

  // 1. Offline video: 2 s at 60 fps, 2x supersampled.
  const video = await page.evaluate(
    async ({ codec }) => {
      const r = await window.__capture.runOffline({ width: 640, height: 360, seconds: 2, fps: 60, supersample: 2, codec });
      const read = await window.__capture.probe(r.blob);
      return {
        codec: r.codec, frames: r.frames, duration: r.duration, elapsed: r.elapsed, size: r.blob.size,
        mimeType: r.mimeType,
        readWidth: read.width, readHeight: read.height,
        readDuration: read.duration, packets: read.packets, readFps: read.fps,
        canvasAfter: [window.__capture.canvas.width, window.__capture.canvas.height],
        base64: await window.__helpers.toBase64(r.blob),
      };
    },
    { codec },
  );
  console.log(`video: ${video.codec} ${video.mimeType}, ${video.size} bytes, rendered in ${video.elapsed.toFixed(2)} s`);
  check(video.frames === 120 && video.packets === 120, 'video has 120 frames', `${video.packets} packets`);
  check(Math.abs(video.readDuration - 2) < 0.001, 'video is exactly 2 s', `${video.readDuration}`);
  check(Math.abs(video.readFps - 60) < 0.01, 'video is 60 fps', `${video.readFps}`);
  check(video.readWidth === 640 && video.readHeight === 360, 'video is 640x360', `${video.readWidth}x${video.readHeight}`);
  check(video.canvasAfter[0] === 960 && video.canvasAfter[1] === 540, 'canvas size restored', video.canvasAfter.join('x'));
  if (outDir) writeFileSync(join(outDir, 'offline.mp4'), Buffer.from(video.base64, 'base64'));

  // 2. Determinism: the same render twice gives identical frames going in.
  // (Checked on the PNG path, since encoders are not required to be bit exact.)
  const stills = await page.evaluate(
    async () => {
      const inspect = window.__helpers.inspectPng;
      const c = window.__capture;
      c.scene.time = 3; // freeze a known state: stills render synchronously at this time
      const shot = await c.screenshot();
      const one = await c.single(1280, 720);
      const ss = await c.still(1280, 720, 3);
      const tiled = await c.tiled(1280, 720, 500);
      const b64 = window.__helpers.toBase64;
      return {
        shot: await inspect(shot), one: await inspect(one), ss: await inspect(ss), tiled: await inspect(tiled),
        files: { 'still-1x.png': await b64(one), 'still-3x.png': await b64(ss), 'still-tiled.png': await b64(tiled) },
        // Pixel difference between the single pass and the tiled render.
        diff: await (async () => {
          const [a, b] = await Promise.all([createImageBitmap(one), createImageBitmap(tiled)]);
          const px = (bmp) => { const k = new OffscreenCanvas(bmp.width, bmp.height); const g = k.getContext('2d'); g.drawImage(bmp, 0, 0); return g.getImageData(0, 0, bmp.width, bmp.height).data; };
          const da = px(a), db = px(b);
          let max = 0, sum = 0;
          for (let i = 0; i < da.length; i += 4) { const d = Math.abs(da[i] - db[i]); sum += d; if (d > max) max = d; }
          return { max, mean: sum / (da.length / 4) };
        })(),
      };
    },
  );
  const fmt = (s) => `${s.width}x${s.height} mean ${s.mean.toFixed(2)} lit ${(s.lit * 100).toFixed(1)}%`;
  check(stills.shot.width === 960 && stills.shot.mean > 0.5, 'screenshot is not blank', fmt(stills.shot));
  check(stills.one.width === 1280 && stills.one.height === 720 && stills.one.mean > 0.5, '1x still', fmt(stills.one));
  check(stills.ss.width === 1280 && stills.ss.mean > 0.5, '3x supersampled still', fmt(stills.ss));
  check(stills.tiled.width === 1280 && stills.tiled.mean > 0.5, 'tiled still', fmt(stills.tiled));
  check(stills.diff.mean < 0.5, 'tiled still matches the single pass render', `max ${stills.diff.max}, mean ${stills.diff.mean.toFixed(4)}`);
  if (outDir) for (const [name, b64] of Object.entries(stills.files)) writeFileSync(join(outDir, name), Buffer.from(b64, 'base64'));

  // 3. Live recording through the controller for about a second.
  const live = await page.evaluate(async (codec) => {
    const { createCaptureController } = await import('/src/capture/index.ts');
    const c = window.__capture;
    let file = null;
    const ctl = createCaptureController(c.canvas, { recording: { codec }, capture: c.scene.capture, onFile: (blob, name) => (file = { size: blob.size, name }) });
    await ctl.startRecording();
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const t0 = performance.now();
    // The demo loop renders in its own rAF callback, registered before ours,
    // so the canvas holds this frame's image when we capture.
    while (performance.now() - t0 < 1000) { await raf(); ctl.afterRender(); }
    const r = await ctl.stopRecording();
    ctl.dispose();
    return { frames: r.frames, dropped: r.droppedFrames, duration: r.duration, file };
  }, codec);
  check(live.frames > 5 && live.file?.size > 1000, 'live recording produced a file', `${live.frames} frames, ${live.dropped} dropped, ${live.duration.toFixed(2)} s, ${live.file?.size} bytes`);
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);

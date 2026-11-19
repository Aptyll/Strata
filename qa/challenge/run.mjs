#!/usr/bin/env node
/**
 * Headless driver for the challenge QA page (qa/challenge/index.html).
 *
 *   node qa/challenge/run.mjs                       every scenario, software GPU
 *   node qa/challenge/run.mjs ladder mp4            only these scenarios
 *   node qa/challenge/run.mjs --out /tmp/qa         where raw frames go
 *   node qa/challenge/run.mjs --opts '{"ladder":{"counts":[1e6]}}'
 *   node qa/challenge/run.mjs --hardware            the machine's real GPU (opens a window)
 *
 * Writes raw frames (<name>.rgba, <name>.density, <name>.mp4, each with a
 * .json sidecar) into the output folder. qa/challenge/annotate.py turns them
 * into annotated images. Needs Playwright with Chromium.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const WITH_VALUE = new Set(['--out', '--opts']);
const value = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const names = args.filter((a, i) => !a.startsWith('--') && !WITH_VALUE.has(args[i - 1]));
const hardware = args.includes('--hardware');
const out = resolve(value('--out') ?? join(tmpdir(), 'strata-qa', 'challenge'));
const opts = JSON.parse(value('--opts') ?? '{}');
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

// No HMR and no file watching: a checkout or edit mid-run must not reload the page.
const server = await createServer({ root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: !hardware,
  args: hardware
    ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan']
    : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader', '--ignore-gpu-blocklist'],
});

let code = 0;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(`console ${m.type()}: ${m.text()}`);
  });
  await page.exposeFunction('qaSave', (name, b64, meta) => {
    writeFileSync(join(out, name), Buffer.from(b64, 'base64'));
    writeFileSync(join(out, `${name}.json`), meta);
  });
  await page.goto(`${base}qa/challenge/index.html`);
  await page.waitForFunction(() => window.qa, undefined, { timeout: 60_000 });
  const info = await page.evaluate(() => window.qa.info());
  // The commit the frames' code comes from, so every figure can say which code
  // it shows: the last commit that changed src/, so the harness's own commits
  // on a QA branch do not hide the main commit underneath them.
  const git = (...a) => {
    try {
      return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  const commit = git('log', '-1', '--format=%h', 'HEAD', '--', 'src') || git('rev-parse', '--short', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no', '--', 'src') ? true : false;
  writeFileSync(join(out, 'info.json'), JSON.stringify({ ...info, hardware, commit, dirty, date: new Date().toISOString() }, null, 2));
  console.log(`adapter: ${JSON.stringify(info.adapter)}, max particles per buffer ${info.maxCount}`);
  const run = names.length ? names : await page.evaluate(() => window.qa.scenarios);
  const results = {};
  for (const name of run) {
    const t0 = Date.now();
    try {
      results[name] = await page.evaluate(([n, o]) => window.qa.run(n, o), [name, opts[name] ?? {}]);
      console.log(`${name}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s${results[name] ? ` ${JSON.stringify(results[name])}` : ''}`);
    } catch (e) {
      // One broken scenario should not cost the others.
      results[name] = { error: e instanceof Error ? e.message : String(e) };
      console.error(`${name}: failed: ${results[name].error}`);
      code = 1;
    }
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`raw frames in ${out}`);
} catch (e) {
  console.error(`qa: ${e instanceof Error ? e.message : e}`);
  code = 1;
} finally {
  await browser.close();
  await server.close();
}
process.exit(code);

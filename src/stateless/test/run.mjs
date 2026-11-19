// Runs the stateless checks: bundles the TypeScript with esbuild (installed
// with Vite), then hands the result to Node's built-in test runner.
//   node src/stateless/test/run.mjs
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'strata-stateless-test-'));
const only = process.argv[2];
const entries = readdirSync(here).filter((f) => f.endsWith('.test.js') && (!only || f.includes(only)));
try {
  const outfiles = [];
  for (const entry of entries) {
    const outfile = join(dir, entry.replace(/\.js$/, '.mjs'));
    await build({
      entryPoints: [join(here, entry)],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'warning',
    });
    outfiles.push(outfile);
  }
  const result = spawnSync(process.execPath, ['--test', ...outfiles], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

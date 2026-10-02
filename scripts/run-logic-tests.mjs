// Bundles each tests/*.test.mjs with esbuild (real src code,
// webextension-polyfill aliased to a stub), runs them under node, and cleans
// up. Exit code follows the test run.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
if (!files.length) {
  console.error('no test files found');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'ssb-tests-'));
let failed = 0;
try {
  for (const f of files) {
    const out = join(dir, f.replace(/\.mjs$/, '.bundle.mjs'));
    await build({
      entryPoints: [join(root, 'tests', f)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'error',
      alias: { 'webextension-polyfill': './tests/polyfill-stub.mjs' },
    });
    console.log(`── ${f} ──`);
    const res = spawnSync(process.execPath, [out], { stdio: 'inherit' });
    if ((res.status ?? 1) !== 0) failed++;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error(`${failed} test file(s) FAILED`);
  process.exit(1);
}
console.log('ALL TEST FILES PASSED');

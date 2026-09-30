// Bundles tests/badge-logic.test.mjs with esbuild (real src code,
// webextension-polyfill aliased to a stub), runs it under node, and cleans
// up. Exit code follows the test run.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ssb-tests-'));
const out = join(dir, 'badge-logic.test.bundle.mjs');
try {
  await build({
    entryPoints: ['tests/badge-logic.test.mjs'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: out,
    logLevel: 'error',
    alias: { 'webextension-polyfill': './tests/polyfill-stub.mjs' },
  });
  const res = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  process.exit(res.status ?? 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

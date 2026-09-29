// Package: zip the built dist/ for sideloading or sharing.
// Chrome and Firefox need different MV3 background declarations, so this
// emits two zips: -chrome.zip (service_worker) and -firefox.zip (scripts
// event page). Usage: npm run package   (runs the build first)
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

async function zipDir(srcDir, zipPath) {
  const out = createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  await new Promise((resolve, reject) => {
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.directory(srcDir, false);
    void archive.finalize();
  });
  console.log(`packaged -> ${zipPath}`);
}

// Chrome: dist/ as-is (service_worker background).
await zipDir(distDir, join(root, `${pkg.name}-${pkg.version}-chrome.zip`));

// Firefox: same files, but the manifest's background becomes the scripts
// event-page form (Firefox ignores service_worker; Chrome rejects scripts).
const fxDir = await mkdtemp(join(tmpdir(), 'soulsync-fx-'));
await cp(distDir, fxDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(fxDir, 'manifest.json'), 'utf8'));
manifest.background = {
  scripts: ['background/service-worker.js'],
  type: 'module',
};
await writeFile(join(fxDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await zipDir(fxDir, join(root, `${pkg.name}-${pkg.version}-firefox.zip`));
await rm(fxDir, { recursive: true, force: true });

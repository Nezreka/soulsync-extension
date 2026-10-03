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

// Chrome: dist/ plus the side panel entries for the mini player.
const chDir = await mkdtemp(join(tmpdir(), 'soulsync-ch-'));
await cp(distDir, chDir, { recursive: true });
const chManifest = JSON.parse(await readFile(join(chDir, 'manifest.json'), 'utf8'));
if (!chManifest.permissions.includes('sidePanel')) chManifest.permissions.push('sidePanel');
chManifest.side_panel = { default_path: 'mini-player/mini.html' };
await writeFile(join(chDir, 'manifest.json'), JSON.stringify(chManifest, null, 2) + '\n');
await zipDir(chDir, join(root, `${pkg.name}-${pkg.version}-chrome.zip`));
await rm(chDir, { recursive: true, force: true });

// Firefox: same files, but the manifest's background becomes the scripts
// event-page form (Firefox ignores service_worker; Chrome rejects scripts),
// and the mini player becomes a real browser sidebar.
const fxDir = await mkdtemp(join(tmpdir(), 'soulsync-fx-'));
await cp(distDir, fxDir, { recursive: true });
const manifest = JSON.parse(await readFile(join(fxDir, 'manifest.json'), 'utf8'));
manifest.background = {
  scripts: ['background/service-worker.js'],
  type: 'module',
};
manifest.sidebar_action = {
  default_panel: 'mini-player/mini.html',
  default_title: 'SoulSync mini player',
  default_icon: {
    16: 'icons/icon-16.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
};
await writeFile(join(fxDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await zipDir(fxDir, join(root, `${pkg.name}-${pkg.version}-firefox.zip`));
await rm(fxDir, { recursive: true, force: true });

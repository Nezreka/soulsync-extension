// Package: zip the built dist/ for sideloading or sharing.
// Usage: npm run package   (runs the build first)
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const zipPath = join(root, `soulsync-companion-${pkg.version}.zip`);

const out = createWriteStream(zipPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

await new Promise((resolve, reject) => {
  out.on('close', resolve);
  archive.on('error', reject);
  archive.pipe(out);
  archive.directory(join(root, 'dist'), false);
  void archive.finalize();
});

console.log(`packaged -> ${zipPath}`);

// Build: esbuild bundles src/*.ts -> dist/, then static assets are copied and
// the manifest version is synced from package.json.
// Usage: npm run build   (load dist/ as an unpacked extension)
import { build } from 'esbuild';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
const src = join(root, 'src');

/** Some player sources land from sibling workstreams; include them when present. */
const exists = async (p) => (await stat(p).catch(() => null)) !== null;

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

await mkdir(outdir, { recursive: true });

// Background service worker must stay a real ES module for MV3.
await build({
  entryPoints: [join(src, 'background/service-worker.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: join(outdir, 'background/service-worker.js'),
});

// Content scripts and UI scripts as self-contained IIFE bundles.
// The '.css': 'text' loader lets page-badges.ts import its stylesheet as a
// string, bundling it into the JS — no runtime fetch of a
// chrome-extension:// URL, which Chrome refuses on some pages.
const iifeEntries = [
  join(src, 'content/media-session.ts'),
  join(src, 'content/bandcamp.ts'),
  join(src, 'content/beatport.ts'),
  join(src, 'content/page-badges.ts'),
  join(src, 'content/video-badges.ts'),
  join(src, 'popup/popup.ts'),
  join(src, 'options/options.ts'),
  // Mini player UI: docked browser panel (Chrome side panel / Firefox
  // sidebar) via the ⧉ button, with a real OS popup window as fallback.
  join(src, 'mini-player/mini.ts'),
  // In-extension player: Chrome offscreen audio host, and the video player
  // tab (player-tab sources are built by a sibling workstream — included
  // here so the wiring is one commit; skipped until the files land).
  join(src, 'offscreen/player.ts'),
];
if (await exists(join(src, 'player-tab/player.ts'))) {
  iifeEntries.push(join(src, 'player-tab/player.ts'));
}
await build({
  entryPoints: iifeEntries,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  loader: { '.css': 'text' },
  outbase: src,
  outdir,
});

// Static HTML/CSS (page-badges.css is bundled into page-badges.js as a
// string via the esbuild text loader — it is not copied or fetched).
const staticFiles = [
  'popup/popup.html',
  'popup/popup.css',
  'popup/chat.css',
  'mini-player/mini.html',
  'mini-player/mini.css',
  'options/options.html',
  'options/options.css',
  // Player statics. The player-tab files land with the sibling workstream;
  // copy them as soon as they exist.
  'offscreen/player.html',
  'player-tab/player.html',
  'player-tab/player.css',
];
for (const f of staticFiles) {
  const from = join(src, f);
  if (!(await exists(from))) continue;
  const dest = join(outdir, f);
  await mkdir(dirname(dest), { recursive: true });
  await cp(from, dest);
}

// Icons.
await mkdir(join(outdir, 'icons'), { recursive: true });
await cp(join(src, 'icons'), join(outdir, 'icons'), { recursive: true });

// Manifest with version synced from package.json.
const manifest = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
await writeFile(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`built ${pkg.name} v${pkg.version} -> dist/`);

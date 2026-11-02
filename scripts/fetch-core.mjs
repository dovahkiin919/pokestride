// Downloads the mGBA (libretro) WebAssembly core once and self-hosts it in public/cores,
// so the emulator works fully offline and doesn't depend on a CDN at runtime.
//
//   npm run fetch-core                      # (also runs on `npm install`)
//   POKESTRIDE_CORE_ZIP=./mgba_libretro.zip npm run fetch-core   # use a zip you already have
//
// Failure is non-fatal: the app falls back to loading the core from jsDelivr at runtime
// (the service worker caches it after the first successful load).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';

const root = process.cwd();
const out = join(root, 'public', 'cores');
const force = process.argv.includes('--force');

if (!force && existsSync(join(out, 'mgba_libretro.wasm')) && existsSync(join(out, 'mgba_libretro.js'))) {
  console.log('[pokestride] emulator core already present (use --force to re-download)');
  process.exit(0);
}

// Keep the core build in sync with what the installed Nostalgist expects.
let version = 'v1.22.2';
try {
  const src = readFileSync(join(root, 'node_modules', 'nostalgist', 'dist', 'nostalgist.js'), 'utf8');
  version = src.match(/coreVersion\s*=\s*"([^"]+)"/)?.[1] ?? version;
} catch {
  /* use default */
}

try {
  let zipBytes;
  if (process.env.POKESTRIDE_CORE_ZIP) {
    zipBytes = new Uint8Array(readFileSync(process.env.POKESTRIDE_CORE_ZIP));
  } else {
    const url = `https://cdn.jsdelivr.net/gh/arianrhodsandlot/retroarch-emscripten-build@${version}/retroarch/mgba_libretro.zip`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    zipBytes = new Uint8Array(await res.arrayBuffer());
  }
  const files = unzipSync(zipBytes);
  const jsName = Object.keys(files).find((n) => n.endsWith('.js'));
  const wasmName = Object.keys(files).find((n) => n.endsWith('.wasm'));
  if (!jsName || !wasmName) throw new Error('zip is missing the .js or .wasm file');

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'mgba_libretro.js'), files[jsName]);
  writeFileSync(join(out, 'mgba_libretro.wasm'), files[wasmName]);
  writeFileSync(join(out, 'index.json'), JSON.stringify({ cores: ['mgba'], version }));
  console.log(`[pokestride] mGBA core ${version} self-hosted in public/cores`);
} catch (err) {
  console.warn(`[pokestride] could not self-host the emulator core (${err.message}).`);
  console.warn('[pokestride] The app will load it from the CDN on first launch. Re-run `npm run fetch-core` when online.');
}

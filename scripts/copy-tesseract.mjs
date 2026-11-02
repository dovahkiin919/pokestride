// Copies offline-OCR assets (Tesseract worker, WASM core, English language data)
// from node_modules into public/tesseract so OCR works with no network access.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, 'public', 'tesseract');
mkdirSync(join(out, 'core'), { recursive: true });
mkdirSync(join(out, 'lang'), { recursive: true });

// 1. Worker script
const worker = join(root, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js');
if (existsSync(worker)) cpSync(worker, join(out, 'worker.min.js'));
else console.warn('[pokestride] tesseract.js worker not found');

// 2. WASM core builds (self-contained .wasm.js files)
const coreDir = join(root, 'node_modules', 'tesseract.js-core');
if (existsSync(coreDir)) {
  for (const f of readdirSync(coreDir)) {
    if (/^tesseract-core.*\.wasm\.js$/.test(f)) cpSync(join(coreDir, f), join(out, 'core', f));
  }
} else console.warn('[pokestride] tesseract.js-core not found');

// 3. English language data (gzipped traineddata)
const dataRoot = join(root, 'node_modules', '@tesseract.js-data', 'eng');
const candidates = ['4.0.0_best_int', '4.0.0', '4.0.0_fast'];
let copied = false;
for (const c of candidates) {
  const f = join(dataRoot, c, 'eng.traineddata.gz');
  if (existsSync(f)) {
    cpSync(f, join(out, 'lang', 'eng.traineddata.gz'));
    copied = true;
    break;
  }
}
if (!copied) console.warn('[pokestride] eng language data not found; OCR will fall back to CDN on first use');
else console.log('[pokestride] offline OCR assets ready in public/tesseract');

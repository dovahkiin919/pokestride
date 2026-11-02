# PokéStride

Mobile-first dark PWA: local workout image vault + on-device OCR + XP Bank ledger.
React + TypeScript + Tailwind + Dexie (IndexedDB) + Tesseract.js + Lucide.

## Run it

```bash
npm install          # also copies offline OCR assets into public/tesseract
npm run dev          # UI development (service worker is disabled in dev)
npm run build && npm run preview   # production build with PWA + service worker
```

## Testing the Android share target

The Web Share Target only works when the app is **installed** and served over **HTTPS**
(or `localhost`). Deploy `dist/` to any static HTTPS host (Netlify, Vercel, Cloudflare Pages,
GitHub Pages at a domain root), open it in Chrome on Android, choose *Install app*, then in
Strava use Share → image → PokéStride. The service worker (`public/sw.js`) receives the
`POST /share-target`, stashes the image in a cache, and redirects to `/?shared=N`, where the app
picks it up and runs OCR.

The app is served from the domain root (`/`). For a sub-path deploy, change `start_url`, `scope`,
`share_target.action` in `manifest.json` and the paths in `sw.js` / `ocrService.ts`.

## Layout

| File | Purpose |
|---|---|
| `src/db.ts` | Dexie schema (images + SHA-256, workouts, XP bank), atomic save, backup/restore |
| `src/ocrService.ts` | Tesseract worker (self-hosted, CDN fallback) + distance/elevation/time parser |
| `src/xp.ts` | XP formulas |
| `src/imageUtils.ts` | SHA-256 hashing + thumbnails |
| `src/App.tsx` | Ingest queue, duplicate guard, share-target pickup, tabs, backup/restore |
| `src/components/*` | Vault tab, Play tab, confirm modal, party preview modal, toasts |
| `public/manifest.json` | PWA manifest with `share_target` (POST, multipart/form-data, `image/*`) |
| `public/sw.js` | Offline caching + share-target handler |

## Part 2: GBA emulator (Play Game tab)

- Engine: Nostalgist.js (pinned `0.23.0`) running the mGBA libretro core as WebAssembly, lazy-loaded
  only when you press Start.
- `npm install` runs `scripts/fetch-core.mjs`, which downloads the core once into `public/cores` so
  play works offline. If that fails (no network), the app loads the core from jsDelivr on first launch
  and the service worker caches it. Retry any time with `npm run fetch-core`
  (or `POKESTRIDE_CORE_ZIP=./mgba_libretro.zip npm run fetch-core` with a zip you already have).
- ROM: validated (.gba/.agb, size, GBA header) and stored as a Blob in IndexedDB (`roms` table).
- Saves: battery save (SRAM / .sav) is written to IndexedDB (`saves` table, keyed by ROM hash) every
  10 s, and on pause, tab switch, backgrounding and page close. Export/Import Save buttons move `.sav`
  files in and out. Save State / Load State use one quick slot.
- The emulator hook (`src/emulator/useEmulator.ts`) lives at App level and the Play tab is only hidden
  when you switch tabs, so the running game is never restarted. It pauses while hidden.
- Backups (`.json`) now include game saves (version 2). ROMs are never included.

## Part 3: Spend XP drawer (Pokémon Emerald)

**Play Game → ⚡ Spend Banked XP** pauses the game, reads your party straight out of emulator RAM, and lets you
move banked XP into a Pokémon, clamped to your gym-badge level cap.

How it works (all in `src/emerald/`):
- `ram.ts` finds the emulated EWRAM inside `Module.HEAPU8` (a GBA address like `0x020244EC` is *not* a heap index) by
  recognising a checksum-valid party, and uses the core's own pointer to that buffer to ignore stale copies
  (old save-state buffers, the ROM image). Badge flags come from SaveBlock1 via the pointer at `0x03005D8C`.
- `gen3.ts` implements the Gen 3 party format: XOR key, 24 substructure orderings, checksum, experience tables,
  nature/stat formulas. **Experience is not at offset 0x1C** (that's the checksum); it's encrypted inside the Growth
  substructure, so a raw write there would turn the Pokémon into a Bad Egg.
- `baseStats.ts` reads species base stats/growth rates from *your* ROM (found by fingerprint), so nothing is bundled.
- `levelCaps.ts` is the badge cap table: 0-1 badges Lv 15, then 19, 24, 29, 31, 33, 42, 46; Elite Four 58; Post-Game 100.
  The XP at a cap depends on each species' growth rate, so it is computed per Pokémon.
- Confirming: charges the bank atomically (`spendXp`), writes exp + level + recalculated stats + HP + checksum, reads it
  back to verify, and refunds the bank if anything fails. Then the game resumes and the `.sav` is backed up.

Limits: it sets experience/level/stats directly. It does **not** play the level-up scene, learn moves, or evolve
(Gen 3 only does that at a battle level-up or with a Rare Candy; an over-level Pokémon evolves at its next battle
level-up). Spend in the overworld, then save in-game. Elite Four progress can't be detected, so pick it manually.

Tests: `npm test` (unit), `npm run make-test-rom` + `tools/e2e-spend-xp.cjs` (real mGBA core in Chromium against a
synthetic Emerald-shaped ROM; needs `playwright` and `npm run fetch-core`).

## XP formulas

- Running: 320 XP/km + 2.5 XP/m elevation
- Cycling: 95 XP/km + 2.0 XP/m elevation
- Walking: 180 XP/km + 2.5 XP/m elevation
- Gym: 40 XP per moving minute

## Backup / Restore

Header buttons export everything (including images) to `pokestride-backup-YYYY-MM-DD.json`
and restore from one (restore replaces current data after a confirmation prompt).

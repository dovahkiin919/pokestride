import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Nostalgist } from 'nostalgist';
import { db, deleteRom, getRom, getSave, putSave, saveId, saveRom } from '../db';
import { sha256 } from '../imageUtils';
import { downloadBlob } from './download';
import { normaliseRomName, validateGbaRom } from './rom';

export type EmuStatus = 'idle' | 'booting' | 'running' | 'paused' | 'error';
export type SyncStatus = 'none' | 'saving' | 'synced' | 'error';
export type PadButton = 'up' | 'down' | 'left' | 'right' | 'a' | 'b' | 'l' | 'r' | 'start' | 'select';
type Notify = (text: string, kind?: 'success' | 'warn' | 'info') => void;

const SRAM_INTERVAL_MS = 10_000;
const SRAM_TIMEOUT_MS = 3_000;
const MAX_SAV_BYTES = 256 * 1024;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Use self-hosted mGBA core (public/cores, fetched by `npm run fetch-core`) when present. */
let localCoreCheck: Promise<boolean> | null = null;
function hasLocalCore(): Promise<boolean> {
  if (!localCoreCheck) {
    localCoreCheck = fetch('/cores/index.json')
      .then(async (r) => {
        if (!r.ok) return false;
        const j = (await r.json()) as { cores?: string[] };
        return Array.isArray(j.cores) && j.cores.includes('mgba');
      })
      .catch(() => false);
  }
  return localCoreCheck;
}

interface Options {
  /** True while the Play tab is visible. The emulator pauses when false. */
  active: boolean;
  notify: Notify;
}

/**
 * Owns the emulator for the whole app lifetime. App mounts it once, so the instance
 * (and its WebAssembly memory) survives switching between tabs.
 */
export function useEmulator({ active, notify }: Options) {
  const stageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const nRef = useRef<Nostalgist | null>(null);
  const tokenRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const savingRef = useRef(false);
  const lastSramRef = useRef<Uint8Array | null>(null);
  const pausedRef = useRef(false);
  const manualPauseRef = useRef(false);
  const heldRef = useRef(new Set<PadButton>());

  const [status, setStatus] = useState<EmuStatus>('idle');
  const [sync, setSync] = useState<SyncStatus>('none');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wantStart, setWantStart] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false);

  // undefined = still loading from IndexedDB, null = no ROM stored
  const rom = useLiveQuery(() => getRom(), []);
  const stateRow = useLiveQuery(() => (rom ? db.saves.get(saveId('state', rom.hash)) : undefined), [rom?.hash]);

  const romRef = useRef(rom);
  romRef.current = rom;
  const activeRef = useRef(active);
  activeRef.current = active;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /* ---------------- SRAM (.sav) persistence ---------------- */

  const syncSram = useCallback(async () => {
    const n = nRef.current;
    const r = romRef.current;
    if (!n || !r || savingRef.current) return;
    savingRef.current = true;
    setSync('saving');
    try {
      const blob = await withTimeout(n.saveSRAM(), SRAM_TIMEOUT_MS);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!sameBytes(lastSramRef.current, bytes)) {
        await putSave('sram', r.hash, blob);
        lastSramRef.current = bytes;
      }
      if (nRef.current !== n) return;
      setSync('synced');
      setLastSync(Date.now());
    } catch (e) {
      if (nRef.current !== n) return;
      // A timeout means the game hasn't created any battery save yet (e.g. still on the title screen).
      setSync(e instanceof TimeoutError ? 'none' : 'error');
    } finally {
      savingRef.current = false;
    }
  }, []);

  /* ---------------- Gamepad input ---------------- */

  const pressDown = useCallback((button: PadButton) => {
    const n = nRef.current;
    if (!n || pausedRef.current) return;
    heldRef.current.add(button);
    n.pressDown({ button });
  }, []);

  const pressUp = useCallback((button: PadButton) => {
    const n = nRef.current;
    heldRef.current.delete(button);
    if (n) n.pressUp({ button });
  }, []);

  const releaseAll = useCallback(() => {
    const n = nRef.current;
    if (n) for (const b of heldRef.current) n.pressUp({ button: b });
    heldRef.current.clear();
  }, []);

  /* ---------------- Pause / resume ---------------- */

  const pauseEmu = useCallback(
    async (manual: boolean) => {
      const n = nRef.current;
      if (!n) return;
      if (manual) manualPauseRef.current = true;
      releaseAll();
      if (pausedRef.current) return;
      // Flush the battery save while the core is still running, then freeze it.
      await syncSram();
      if (nRef.current !== n) return;
      if (!manual && activeRef.current && !document.hidden) return; // user came back meanwhile
      n.pause();
      pausedRef.current = true;
      setStatus('paused');
    },
    [releaseAll, syncSram]
  );

  const resumeEmu = useCallback(() => {
    const n = nRef.current;
    if (!n || !pausedRef.current) return;
    manualPauseRef.current = false;
    pausedRef.current = false;
    n.resume();
    setStatus('running');
  }, []);

  const togglePause = useCallback(() => {
    if (pausedRef.current) resumeEmu();
    else void pauseEmu(true);
  }, [pauseEmu, resumeEmu]);

  /* ---------------- Launch / teardown ---------------- */

  const teardown = useCallback(() => {
    tokenRef.current++; // cancels any in-flight launch
    window.clearInterval(timerRef.current);
    const n = nRef.current;
    nRef.current = null;
    pausedRef.current = false;
    manualPauseRef.current = false;
    heldRef.current.clear();
    lastSramRef.current = null;
    if (n) {
      try {
        n.exit({ removeCanvas: true });
      } catch (e) {
        console.warn('Emulator exit failed', e);
      }
    }
    stageRef.current?.replaceChildren();
    setStatus('idle');
    setSync('none');
    setError(null);
  }, []);

  const launch = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || nRef.current) return;
    const stored = await getRom();
    if (!stored) return;
    const token = ++tokenRef.current;
    setStatus('booting');
    setError(null);
    try {
      const [{ Nostalgist }, sramRow, local] = await Promise.all([
        import('nostalgist'),
        getSave('sram', stored.hash),
        hasLocalCore(),
      ]);
      if (token !== tokenRef.current) return;

      // A fresh canvas per launch: a WebGL canvas can't be safely reused after the core exits.
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 160;
      canvas.className = 'h-full w-full';
      canvas.style.imageRendering = 'pixelated';
      canvas.style.objectFit = 'contain';
      canvas.style.touchAction = 'none';
      stage.replaceChildren(canvas);

      const n = await Nostalgist.launch({
        element: canvas,
        core: 'mgba',
        rom: { fileName: stored.fileName, fileContent: stored.blob },
        sram: sramRow?.blob,
        sramType: 'srm', // RetroArch names battery saves .srm internally (same bytes as .sav; exports are still named .sav)
        retroarchConfig: { savestate_thumbnail_enable: false },
        ...(local
          ? {
              resolveCoreJs: () => '/cores/mgba_libretro.js',
              resolveCoreWasm: () => '/cores/mgba_libretro.wasm',
            }
          : {}),
      });

      if (token !== tokenRef.current) {
        n.exit({ removeCanvas: true });
        return;
      }
      nRef.current = n;
      pausedRef.current = false;
      manualPauseRef.current = false;
      lastSramRef.current = sramRow ? new Uint8Array(await sramRow.blob.arrayBuffer()) : null;
      setSync(sramRow ? 'synced' : 'none');
      setStatus('running');

      window.clearInterval(timerRef.current);
      timerRef.current = window.setInterval(() => {
        if (nRef.current && !pausedRef.current) void syncSram();
      }, SRAM_INTERVAL_MS);

      // If the user left the tab while it was booting, don't keep running in the background.
      if (!activeRef.current || document.hidden) void pauseEmu(false);
    } catch (e) {
      if (token !== tokenRef.current) return;
      console.error('Emulator launch failed', e);
      stage.replaceChildren();
      nRef.current = null;
      setStatus('error');
      setError(
        'Could not start the emulator core. Connect to the internet once so it can download, or run `npm run fetch-core` to bundle it for offline play.'
      );
    }
  }, [pauseEmu, syncSram]);

  // Start after a fresh ROM upload (needs the player UI to be visible first)
  useEffect(() => {
    if (wantStart && rom && active) {
      setWantStart(false);
      void launch();
    }
  }, [wantStart, rom, active, launch]);

  /* ---------------- ROM management ---------------- */

  const loadRomFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      const check = await validateGbaRom(file);
      if (!check.ok) {
        notifyRef.current(check.reason, 'warn');
        return;
      }
      try {
        // Copy bytes so the stored Blob doesn't depend on the original file handle.
        const blob = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
        const hash = await sha256(blob);
        teardown();
        await saveRom({
          id: 'current',
          fileName: normaliseRomName(file.name),
          title: check.info.title,
          gameCode: check.info.gameCode,
          size: check.info.size,
          hash,
          blob,
          updatedAt: Date.now(),
        });
        void navigator.storage?.persist?.().catch(() => undefined);
        notifyRef.current('ROM stored on this device.', 'success');
        setWantStart(true);
      } catch (e) {
        console.error(e);
        notifyRef.current('Could not store that ROM.', 'warn');
      }
    },
    [teardown]
  );

  const removeRom = useCallback(async () => {
    if (!window.confirm('Remove the ROM from this device? Your saves for this game are kept.')) return;
    await syncSram();
    teardown();
    await deleteRom();
  }, [syncSram, teardown]);

  /* ---------------- Save / state / export / import ---------------- */

  const saveStateSlot = useCallback(async () => {
    const n = nRef.current;
    const r = romRef.current;
    if (!n || !r || pausedRef.current) return;
    try {
      const { state } = await withTimeout(n.saveState(), 6000);
      await putSave('state', r.hash, state);
      notifyRef.current('State saved.', 'success');
    } catch (e) {
      console.error(e);
      notifyRef.current('Could not save state.', 'warn');
    }
  }, []);

  const loadStateSlot = useCallback(async () => {
    const n = nRef.current;
    const r = romRef.current;
    if (!n || !r || pausedRef.current) return;
    try {
      const row = await getSave('state', r.hash);
      if (!row) {
        notifyRef.current('No saved state yet.', 'warn');
        return;
      }
      await withTimeout(n.loadState(row.blob), 6000);
      notifyRef.current('State loaded.', 'success');
    } catch (e) {
      console.error(e);
      notifyRef.current('Could not load state.', 'warn');
    }
  }, []);

  const exportSave = useCallback(async () => {
    const r = romRef.current;
    if (!r) return;
    if (nRef.current && !pausedRef.current) await syncSram();
    const row = await getSave('sram', r.hash);
    if (!row) {
      notifyRef.current('No save data yet — save inside the game first.', 'warn');
      return;
    }
    downloadBlob(row.blob, r.fileName.replace(/\.gba$/i, '') + '.sav');
    notifyRef.current('Save exported.', 'success');
  }, [syncSram]);

  const importSave = useCallback(
    async (file: File | undefined) => {
      const r = romRef.current;
      if (!file || !r) return;
      if (file.size === 0 || file.size > MAX_SAV_BYTES) {
        notifyRef.current("That doesn't look like a GBA .sav file.", 'warn');
        return;
      }
      const running = !!nRef.current;
      if (
        running &&
        !window.confirm('Importing a save restarts the game. Progress since the last sync will be replaced. Continue?')
      ) {
        return;
      }
      const blob = new Blob([await file.arrayBuffer()], { type: 'application/octet-stream' });
      await putSave('sram', r.hash, blob);
      if (running) {
        teardown(); // no flush: it would overwrite the save we just imported
        await launch();
      }
      notifyRef.current(running ? 'Save imported — game restarted.' : 'Save imported. It loads when you start.', 'success');
    },
    [launch, teardown]
  );

  /* ---------------- Spend XP session (Part 3) ---------------- */

  /** Current wasm heap view. Re-read every time: the buffer is replaced whenever wasm memory grows. */
  const getHeap = useCallback((): Uint8Array | undefined => {
    const mod = nRef.current?.getEmscriptenModule() as unknown as { HEAPU8?: Uint8Array } | undefined;
    return mod?.HEAPU8;
  }, []);

  /**
   * Freezes the game for memory inspection. Flushes the .sav first (pauseEmu does that), then holds a
   * manual pause so tab switches can't auto-resume underneath the drawer.
   */
  const beginSpend = useCallback(async (): Promise<{ ok: boolean; wasPaused: boolean }> => {
    if (!nRef.current || (status !== 'running' && status !== 'paused')) return { ok: false, wasPaused: false };
    const wasPaused = pausedRef.current;
    await pauseEmu(true);
    return { ok: pausedRef.current, wasPaused };
  }, [pauseEmu, status]);

  /** Ends the session: optionally resumes the game, then forces an immediate .sav backup into IndexedDB. */
  const endSpend = useCallback(
    async (resume: boolean) => {
      if (resume) resumeEmu();
      else manualPauseRef.current = true;
      await syncSram();
    },
    [resumeEmu, syncSram]
  );

  /* ---------------- Fullscreen ---------------- */

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (pseudoFullscreen) {
      setPseudoFullscreen(false);
    } else if (el.requestFullscreen) {
      try {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        setPseudoFullscreen(true);
      }
    } else {
      setPseudoFullscreen(true); // iOS Safari: no element fullscreen, fall back to a CSS overlay
    }
  }, [pseudoFullscreen]);

  /* ---------------- Lifecycle: tab switches, backgrounding, unload ---------------- */

  useEffect(() => {
    if (!nRef.current) return;
    if (!active) void pauseEmu(false);
    else if (!manualPauseRef.current && !document.hidden) resumeEmu();
  }, [active, pauseEmu, resumeEmu]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) void pauseEmu(false);
      else if (activeRef.current && !manualPauseRef.current) resumeEmu();
    };
    const onLeave = () => void syncSram();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    window.addEventListener('beforeunload', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('beforeunload', onLeave);
    };
  }, [pauseEmu, resumeEmu, syncSram]);

  // Unmount: stop the timer, make one last save attempt, then shut the core down and drop references.
  useEffect(
    () => () => {
      window.clearInterval(timerRef.current);
      tokenRef.current++;
      const n = nRef.current;
      const r = romRef.current;
      nRef.current = null;
      if (!n) return;
      const finish = () => {
        try {
          n.exit({ removeCanvas: true });
        } catch {
          /* already gone */
        }
      };
      if (r) {
        withTimeout(n.saveSRAM(), 2000)
          .then((blob) => putSave('sram', r.hash, blob))
          .catch(() => undefined)
          .finally(finish);
      } else finish();
    },
    []
  );

  return {
    stageRef,
    containerRef,
    rom,
    status,
    sync,
    lastSync,
    error,
    hasState: !!stateRow,
    isFullscreen: isFullscreen || pseudoFullscreen,
    start: launch,
    togglePause,
    loadRomFile,
    removeRom,
    saveState: saveStateSlot,
    loadState: loadStateSlot,
    exportSave,
    importSave,
    toggleFullscreen,
    getHeap,
    beginSpend,
    endSpend,
    pressDown,
    pressUp,
    /** Stops the emulator without saving (used after restoring a backup). */
    reset: teardown,
  };
}

export type EmulatorController = ReturnType<typeof useEmulator>;

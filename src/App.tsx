import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DatabaseBackup, Dumbbell, Gamepad2, Upload } from 'lucide-react';
import { db, exportBackup, getXpBank, hasImage, importBackup, saveWorkout } from './db';
import { makeThumbnail, sha256 } from './imageUtils';
import { runOcr, type OcrMetrics } from './ocrService';
import { useEmulator } from './emulator/useEmulator';
import ConfirmModal, { type ConfirmData } from './components/ConfirmModal';
import SpendXpDrawer from './components/SpendXpDrawer';
import PlayTab from './components/PlayTab';
import Toasts, { type ToastItem } from './components/Toasts';
import VaultTab from './components/VaultTab';

interface Pending {
  file: Blob;
  hash: string;
}

interface Active extends Pending {
  url: string;
  scanning: boolean;
  progress: number;
  ocr: OcrMetrics | null;
  ocrFailed: boolean;
}

export default function App() {
  const [tab, setTab] = useState<'vault' | 'play'>('vault');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [queue, setQueue] = useState<Pending[]>([]);
  const [active, setActive] = useState<Active | null>(null);
  const [showSpend, setShowSpend] = useState(false);
  const restoreRef = useRef<HTMLInputElement>(null);
  const toastId = useRef(0);

  const xpBank = useLiveQuery(() => getXpBank(), [], 0) ?? 0;

  const toast = useCallback((text: string, kind: ToastItem['kind'] = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // The emulator lives at App level so it survives Vault <-> Play tab switches.
  const emu = useEmulator({ active: tab === 'play', notify: toast });

  /* ---- Ingest files (picker / drop / share target) ---- */
  const ingest = useCallback(
    async (files: Blob[]) => {
      const images = files.filter((f) => f.type.startsWith('image/'));
      if (files.length && !images.length) toast('Please choose an image file.', 'warn');
      const seen = new Set<string>();
      const fresh: Pending[] = [];
      for (const file of images) {
        const hash = await sha256(file);
        if ((await hasImage(hash)) || seen.has(hash)) {
          toast('Workout already logged!', 'warn');
          continue;
        }
        seen.add(hash);
        fresh.push({ file, hash });
      }
      if (fresh.length) setQueue((q) => [...q, ...fresh.filter((f) => !q.some((x) => x.hash === f.hash))]);
    },
    [toast]
  );

  /* ---- Pick up images delivered by the service worker's share target ---- */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('shared')) return;
    (async () => {
      try {
        const cache = await caches.open('pokestride-shared');
        const reqs = await cache.keys();
        const blobs: Blob[] = [];
        for (const r of reqs) {
          const res = await cache.match(r);
          if (res) blobs.push(await res.blob());
          await cache.delete(r);
        }
        window.history.replaceState({}, '', '/');
        if (blobs.length) {
          toast(`Received ${blobs.length} shared image${blobs.length > 1 ? 's' : ''}`, 'info');
          await ingest(blobs);
        }
      } catch (e) {
        console.error(e);
        toast('Could not read the shared image.', 'warn');
      }
    })();
  }, [ingest, toast]);

  /* ---- Process queue one at a time ---- */
  useEffect(() => {
    if (active || queue.length === 0) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    const url = URL.createObjectURL(next.file);
    setActive({ ...next, url, scanning: true, progress: 0, ocr: null, ocrFailed: false });
    runOcr(next.file, (p) => setActive((a) => (a && a.hash === next.hash ? { ...a, progress: p } : a)))
      .then((ocr) => setActive((a) => (a && a.hash === next.hash ? { ...a, scanning: false, ocr } : a)))
      .catch((e) => {
        console.error('OCR failed', e);
        toast("OCR failed — enter the details manually.", 'warn');
        setActive((a) => (a && a.hash === next.hash ? { ...a, scanning: false, ocrFailed: true } : a));
      });
  }, [queue, active, toast]);

  const closeActive = useCallback(() => {
    setActive((a) => {
      if (a) URL.revokeObjectURL(a.url);
      return null;
    });
  }, []);

  const confirm = async (d: ConfirmData) => {
    if (!active) return;
    try {
      const thumb = await makeThumbnail(active.file);
      await saveWorkout(
        {
          timestamp: Date.now(),
          distanceKm: d.distanceKm,
          elevationM: d.elevationM,
          durationSec: d.durationSec,
          activityType: d.activityType,
          xp: d.xp,
          imageHash: active.hash,
        },
        { hash: active.hash, blob: active.file, thumb }
      );
      toast(`+${d.xp.toLocaleString()} XP banked!`, 'success');
    } catch (e) {
      if (e instanceof Error && e.message === 'DUPLICATE') toast('Workout already logged!', 'warn');
      else {
        console.error(e);
        toast('Could not save workout.', 'warn');
      }
    }
    closeActive();
  };

  /* ---- Backup / Restore ---- */
  const backup = async () => {
    try {
      const blob = await exportBackup();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `pokestride-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast('Backup saved to your downloads.', 'success');
    } catch (e) {
      console.error(e);
      toast('Backup failed.', 'warn');
    }
  };

  const restore = async (file: File) => {
    if (!window.confirm('Restoring replaces ALL current PokéStride data with the backup. Continue?')) return;
    try {
      const r = await importBackup(file);
      emu.reset(); // saves may have changed on disk; restart the game from them next time
      toast(`Restored ${r.workouts} workouts, ${r.xpBank.toLocaleString()} XP.`, 'success');
    } catch (e) {
      console.error(e);
      toast(e instanceof Error ? e.message : 'Restore failed.', 'warn');
    }
  };

  // keep db referenced for devtools debugging
  (window as unknown as { pokestrideDb?: typeof db; pokestrideEmu?: typeof emu }).pokestrideDb = db;
  (window as unknown as { pokestrideEmu?: typeof emu }).pokestrideEmu = emu;

  return (
    <div className="mx-auto flex h-full max-w-md flex-col bg-ink-950">
      <Toasts items={toasts} />

      {/* App bar */}
      <header className="safe-top flex items-center justify-between border-b border-ink-800 bg-ink-900 px-4 py-3">
        <h1 className="text-lg font-extrabold tracking-tight">
          Poké<span className="text-volt-400">Stride</span>
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={backup}
            className="flex items-center gap-1.5 rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold active:bg-ink-600"
          >
            <DatabaseBackup className="h-4 w-4 text-electric-400" /> Backup
          </button>
          <button
            onClick={() => restoreRef.current?.click()}
            className="flex items-center gap-1.5 rounded-lg bg-ink-700 px-3 py-1.5 text-xs font-semibold active:bg-ink-600"
          >
            <Upload className="h-4 w-4 text-electric-400" /> Restore
          </button>
          <input
            ref={restoreRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) restore(f);
              e.target.value = '';
            }}
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto pt-4">
        {tab === 'vault' && <VaultTab xpBank={xpBank} onFiles={ingest} />}
        {/* Always mounted (only hidden) so the emulator canvas + WASM state are never destroyed. */}
        <div className={tab === 'play' ? '' : 'hidden'}>
          <PlayTab
            emu={emu}
            xpBank={xpBank}
            onOpenSpend={() => {
              // native fullscreen would hide the drawer (it lives outside the player), so leave it first
              if (document.fullscreenElement) void document.exitFullscreen();
              setShowSpend(true);
            }}
          />
        </div>
      </main>

      {/* Bottom nav */}
      <nav className="safe-bottom grid grid-cols-2 border-t border-ink-800 bg-ink-900">
        {(
          [
            ['vault', 'Vault & Bank', Dumbbell],
            ['play', 'Play Game', Gamepad2],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex flex-col items-center gap-1 py-3 text-xs font-semibold ${
              tab === id ? 'text-volt-400' : 'text-slate-500'
            }`}
          >
            <Icon className="h-6 w-6" />
            {label}
          </button>
        ))}
      </nav>

      {active && (
        <ConfirmModal
          key={active.hash}
          imageUrl={active.url}
          scanning={active.scanning}
          progress={active.progress}
          ocr={active.ocr}
          ocrFailed={active.ocrFailed}
          onConfirm={confirm}
          onCancel={closeActive}
        />
      )}
      <SpendXpDrawer open={showSpend} emu={emu} xpBank={xpBank} notify={toast} onClose={() => setShowSpend(false)} />
    </div>
  );
}

import { useRef, useState } from 'react';
import {
  Download,
  Gamepad2,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Save,
  FolderOpen,
  Upload,
  Zap,
} from 'lucide-react';
import TouchGamepad from '../emulator/TouchGamepad';
import type { EmulatorController } from '../emulator/useEmulator';

interface Props {
  emu: EmulatorController;
  xpBank: number;
  onOpenSpend: () => void;
}

const pill = 'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold';
const tool =
  'flex flex-col items-center justify-center gap-1 rounded-xl border border-ink-600 bg-ink-800 py-2 text-[11px] font-semibold text-slate-200 active:bg-ink-700 disabled:opacity-40';

function UploadCard({ onFile }: { onFile: (f: File | undefined) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        onFile(e.dataTransfer.files[0]);
      }}
      className={`mt-6 rounded-3xl border-2 border-dashed p-8 text-center transition ${
        dragging ? 'border-electric-400 bg-electric-500/10' : 'border-ink-600 bg-ink-800'
      }`}
    >
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl border border-ink-600 bg-ink-900">
        <Gamepad2 className="h-10 w-10 text-electric-400" />
      </div>
      <h2 className="mt-5 text-lg font-bold">Load your game</h2>
      <p className="mx-auto mt-2 max-w-xs text-sm text-slate-400">
        Drop your Pokémon Emerald or FireRed .gba ROM here to begin your fitness journey.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".gba,.agb,application/octet-stream"
        hidden
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="mt-6 inline-flex items-center gap-2 rounded-xl bg-electric-500 px-6 py-3 font-bold text-white active:bg-electric-600"
      >
        <Upload className="h-5 w-5" /> Upload Game ROM (.gba)
      </button>
      <p className="mt-4 text-xs text-slate-500">
        Stored only on this device. You'll never need to upload it again.
      </p>
    </div>
  );
}

export default function PlayTab({ emu, xpBank, onOpenSpend }: Props) {
  const { rom, status, sync, lastSync, error, isFullscreen } = emu;
  const savInput = useRef<HTMLInputElement>(null);
  const romInput = useRef<HTMLInputElement>(null);

  const hasRom = !!rom;
  const live = status === 'running' || status === 'paused';

  const gameLabel =
    status === 'booting' ? 'Booting…' : live ? 'Game Loaded' : status === 'error' ? 'Emulator Error' : 'Ready';
  const gameCls = live
    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
    : status === 'error'
      ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
      : 'border-ink-600 bg-ink-800 text-slate-300';

  const syncLabel =
    sync === 'synced' ? 'Save Synced' : sync === 'saving' ? 'Saving…' : sync === 'error' ? 'Save Error' : 'No Save Yet';
  const syncCls =
    sync === 'synced'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
      : sync === 'error'
        ? 'border-rose-500/40 bg-rose-500/10 text-rose-300'
        : 'border-ink-600 bg-ink-800 text-slate-300';

  return (
    <div className="px-3 pb-6">
      {rom === null && <UploadCard onFile={emu.loadRomFile} />}

      {/* The player stays mounted (just hidden without a ROM) so the emulator survives tab switches. */}
      <div
        ref={emu.containerRef}
        className={`${hasRom ? '' : 'hidden'} ${
          isFullscreen ? 'fixed inset-0 z-40 flex flex-col gap-3 overflow-y-auto bg-ink-950 p-3' : 'space-y-3'
        }`}
      >
        {/* Status bar */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={`${pill} ${gameCls}`}>
            <Gamepad2 className="h-3.5 w-3.5" /> {gameLabel}
          </span>
          <button onClick={onOpenSpend} className={`${pill} border-volt-500/40 bg-volt-500/10 text-volt-400`}>
            <Zap className="h-3.5 w-3.5 fill-volt-400" /> Bank: {xpBank.toLocaleString()} XP
          </button>
          <span
            className={`${pill} ${syncCls}`}
            title={lastSync ? `Last synced ${new Date(lastSync).toLocaleTimeString()}` : undefined}
          >
            <Save className="h-3.5 w-3.5" /> {syncLabel}
          </span>
        </div>

        {/* Screen */}
        <div
          className="relative mx-auto aspect-[3/2] w-full overflow-hidden rounded-xl border border-ink-700 bg-black"
          style={isFullscreen ? { maxHeight: '58vh' } : undefined}
        >
          <div ref={emu.stageRef} className="absolute inset-0" />
          {!live && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center">
              {status === 'booting' ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-electric-400" />
                  <p className="text-sm text-slate-300">Booting emulator…</p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-white">{rom?.title || rom?.fileName}</p>
                  {status === 'error' && error && <p className="max-w-xs text-xs text-rose-300">{error}</p>}
                  <button
                    onClick={() => void emu.start()}
                    className="flex items-center gap-2 rounded-xl bg-electric-500 px-6 py-3 font-bold text-white active:bg-electric-600"
                  >
                    {status === 'error' ? <RefreshCw className="h-5 w-5" /> : <Play className="h-5 w-5 fill-white" />}
                    {status === 'error' ? 'Retry' : 'Start Game'}
                  </button>
                </>
              )}
            </div>
          )}
          {status === 'paused' && (
            <button
              onClick={emu.togglePause}
              className="absolute inset-0 flex items-center justify-center bg-black/60 text-sm font-semibold text-white"
            >
              <Pause className="mr-2 h-5 w-5" /> Paused — tap to resume
            </button>
          )}
        </div>

        {/* Toolbar */}
        <div className="grid grid-cols-4 gap-2">
          <button onClick={emu.togglePause} disabled={!live} className={tool}>
            {status === 'paused' ? <Play className="h-5 w-5" /> : <Pause className="h-5 w-5" />}
            {status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button onClick={() => void emu.saveState()} disabled={status !== 'running'} className={tool}>
            <Save className="h-5 w-5" /> Save State
          </button>
          <button onClick={() => void emu.loadState()} disabled={status !== 'running' || !emu.hasState} className={tool}>
            <FolderOpen className="h-5 w-5" /> Load State
          </button>
          <button onClick={() => void emu.toggleFullscreen()} className={tool}>
            {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
            {isFullscreen ? 'Exit' : 'Fullscreen'}
          </button>
          <button onClick={() => void emu.exportSave()} className={tool}>
            <Download className="h-5 w-5" /> Export Save
          </button>
          <button onClick={() => savInput.current?.click()} className={tool}>
            <Upload className="h-5 w-5" /> Import Save
          </button>
          <button
            onClick={onOpenSpend}
            className="col-span-2 flex items-center justify-center gap-1.5 rounded-xl border border-volt-500/40 bg-volt-500/10 py-2 text-sm font-extrabold text-volt-400 active:bg-volt-500/20"
          >
            <Zap className="h-5 w-5 fill-volt-400" /> {xpBank.toLocaleString()} XP
          </button>
        </div>
        <input
          ref={savInput}
          type="file"
          accept=".sav,.srm,application/octet-stream"
          hidden
          onChange={(e) => {
            void emu.importSave(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        {/* Touch controls */}
        <TouchGamepad onDown={emu.pressDown} onUp={emu.pressUp} disabled={status !== 'running'} />

        {/* Spend XP FAB */}
        <button
          onClick={onOpenSpend}
          className="fixed bottom-[calc(env(safe-area-inset-bottom)+84px)] right-4 z-30 flex items-center gap-2 rounded-full border border-volt-400/60 bg-gradient-to-r from-volt-500 to-volt-400 px-5 py-3 text-sm font-extrabold text-ink-950 shadow-xl shadow-black/50 active:scale-95"
        >
          <Zap className="h-5 w-5 fill-ink-950" /> Spend Banked XP
        </button>

        {/* ROM info */}
        <div className="flex items-center justify-between px-1 text-xs text-slate-500">
          <span className="truncate">
            {rom?.title || rom?.fileName}
            {rom?.gameCode ? ` · ${rom.gameCode}` : ''}
          </span>
          <span className="flex shrink-0 gap-3">
            <button onClick={() => romInput.current?.click()} className="underline">
              Change ROM
            </button>
            <button onClick={() => void emu.removeRom()} className="underline">
              Remove
            </button>
          </span>
          <input
            ref={romInput}
            type="file"
            accept=".gba,.agb,application/octet-stream"
            hidden
            onChange={(e) => {
              void emu.loadRomFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronsRight, Loader2, Lock, Rocket, X, Zap } from 'lucide-react';
import { refundSpend, spendXp } from '../db';
import type { EmulatorController } from '../emulator/useEmulator';
import { BaseStatsTable } from '../emerald/baseStats';
import { expForLevel, levelForExp, type BaseStats, type PartyMon } from '../emerald/gen3';
import {
  BADGE_LABELS, autoProgress, capLevel, progressLabel, resolveProgress,
  type Progress, type ProgressChoice,
} from '../emerald/levelCaps';
import { EmeraldRam, RamError, type PartySnapshot, type ProgressRead } from '../emerald/ram';
import { buildUpdatedMon, maxAllocatable, planSpend } from '../emerald/spend';

type Phase = 'loading' | 'ready' | 'applying' | 'unavailable' | 'error';
type Unavailable = 'no-rom' | 'not-running' | 'wrong-game';

interface Loaded {
  ram: EmeraldRam;
  snap: PartySnapshot;
  table: BaseStatsTable;
  progress: ProgressRead;
}

interface Props {
  open: boolean;
  emu: EmulatorController;
  xpBank: number;
  notify: (text: string, kind?: 'success' | 'warn' | 'info') => void;
  onClose: () => void;
}

const CHOICE_KEY = 'ps-progress-choice';
const loadChoice = (): ProgressChoice => {
  try {
    const v = localStorage.getItem(CHOICE_KEY);
    if (v === 'auto' || v === 'elite4' || v === 'postgame' || /^b[0-8]$/.test(v ?? '')) return v as ProgressChoice;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
};

const fmt = (n: number) => n.toLocaleString();

function SpritePlaceholder({ mon }: { mon: PartyMon }) {
  const hue = (mon.species * 47) % 360;
  return (
    <div
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-lg font-extrabold text-white shadow-inner"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 65% 45%), hsl(${(hue + 40) % 360} 60% 30%))` }}
      aria-hidden
    >
      {mon.isEgg ? '🥚' : (mon.nickname[0] ?? '?').toUpperCase()}
    </div>
  );
}

export default function SpendXpDrawer({ open, emu, xpBank, notify, onClose }: Props) {
  const [mounted, setMounted] = useState(false);
  const [entered, setEntered] = useState(false);
  const [phase, setPhase] = useState<Phase>('loading');
  const [why, setWhy] = useState<Unavailable>('not-running');
  const [errorText, setErrorText] = useState('');
  const [data, setData] = useState<Loaded | null>(null);
  const [selected, setSelected] = useState(0);
  const [alloc, setAlloc] = useState(0);
  const [choice, setChoice] = useState<ProgressChoice>(loadChoice);

  const sessionRef = useRef<{ active: boolean; wasPaused: boolean }>({ active: false, wasPaused: false });
  const emuRef = useRef(emu);
  emuRef.current = emu;

  /* ---- slide animation ---- */
  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => requestAnimationFrame(() => setEntered(true)));
      return () => cancelAnimationFrame(id);
    }
    setEntered(false);
    const t = setTimeout(() => setMounted(false), 300);
    return () => clearTimeout(t);
  }, [open]);

  /* ---- open: pause the game and read RAM ---- */
  const load = useCallback(async () => {
    const e = emuRef.current;
    setPhase('loading');
    setErrorText('');
    const rom = e.rom;
    if (!rom) return fail('no-rom');
    if (rom.gameCode !== 'BPEE') return fail('wrong-game');

    if (!sessionRef.current.active) {
      const begin = await e.beginSpend();
      if (!begin.ok) return fail('not-running');
      sessionRef.current = { active: true, wasPaused: begin.wasPaused };
    }
    await new Promise((r) => setTimeout(r, 40)); // let the "reading memory" state paint before the heap scan
    try {
      const ram = EmeraldRam.attach(() => emuRef.current.getHeap());
      const romBytes = new Uint8Array(await rom.blob.arrayBuffer());
      const table = BaseStatsTable.fromRom(romBytes);
      if (!table) throw new Error("Couldn't read species data from your ROM. This works with an unmodified Pokémon Emerald ROM.");
      const snap = ram.readParty();
      const first = snap.mons.find((m) => m !== null) ?? null;
      const progress = ram.readProgress(first);
      setData({ ram, snap, table, progress });
      const firstIdx = snap.mons.findIndex((m) => m !== null && !m.isEgg);
      setSelected((s) => (snap.mons[s] && !snap.mons[s]!.isEgg ? s : Math.max(0, firstIdx)));
      setAlloc(0);
      setPhase('ready');
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : 'Could not read the game memory.');
      setPhase('error');
    }

    function fail(reason: Unavailable) {
      setWhy(reason);
      setPhase('unavailable');
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  /* ---- close: resume the game and force a .sav backup ---- */
  const close = useCallback(
    async (resume = true) => {
      const s = sessionRef.current;
      sessionRef.current = { active: false, wasPaused: false };
      onClose();
      // Stale `data` is harmless (the loading state hides it) and is replaced on the next open. Clearing it here
      // after the await would race with a quick reopen and blank the new view.
      if (s.active) await emuRef.current.endSpend(resume && !s.wasPaused);
    },
    [onClose]
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && phase !== 'applying' && void close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close, phase]);

  /* ---- derived values ---- */
  const detected = useMemo(
    () => autoProgress(data?.progress.badges ?? null, data?.progress.gameClear ?? null),
    [data]
  );
  const progress: Progress = resolveProgress(choice, detected);
  const cap = capLevel(progress);

  const mon = data?.snap.mons[selected] ?? null;
  const base: BaseStats | null = mon && data ? data.table.get(mon.species) : null;
  const max = mon && base ? maxAllocatable(mon, base, cap, xpBank) : 0;
  const amount = Math.min(alloc, max);
  const plan = mon && base && amount > 0 ? planSpend(mon, base, cap, xpBank, amount) : null;

  const pickChoice = (c: ProgressChoice) => {
    setChoice(c);
    try {
      localStorage.setItem(CHOICE_KEY, c);
    } catch {
      /* ignore */
    }
  };

  const nextLevelGap = mon && base ? expForLevel(base.growthRate, Math.min(100, levelForExp(base.growthRate, mon.exp) + 1)) - mon.exp : 0;

  /* ---- confirm ---- */
  const confirm = async () => {
    if (!data || !mon || !base || !plan || plan.xp <= 0) return;
    setPhase('applying');
    let spendId: number | null = null;
    try {
      // Re-read right before writing: never trust the picture on screen.
      const fresh = data.ram.readParty();
      const live = fresh.mons[mon.slot];
      if (!live || live.personality !== mon.personality || live.exp !== mon.exp) {
        throw new RamError('lost', 'Your party changed since you opened the drawer. Nothing was spent. Reloading…');
      }
      const finalPlan = planSpend(live, base, cap, xpBank, plan.xp);
      if (finalPlan.xp <= 0) throw new Error('Nothing to spend: this Pokémon is already at the cap.');
      const raw = fresh.raw.slice(mon.slot * 100, mon.slot * 100 + 100);
      const updated = buildUpdatedMon(raw, finalPlan); // throws if the source fails its checksum

      // 1) Charge the bank (atomic, refuses to go below zero)
      spendId = await spendXp(finalPlan.xp, {
        slot: mon.slot, nickname: live.nickname, personality: live.personality, xp: finalPlan.xp,
        oldLevel: live.level, newLevel: finalPlan.newLevel, oldExp: live.exp, newExp: finalPlan.newExp,
      });
      // 2) Write RAM (experience, level, recalculated stats, HP, checksum) and verify by reading it back
      data.ram.writeSlot(mon.slot, updated, live.personality);
      const check = data.ram.readParty().mons[mon.slot];
      if (!check || !check.checksumOk || check.exp !== finalPlan.newExp) throw new Error('Verification failed after writing.');

      notify(
        `${live.nickname}: +${fmt(finalPlan.xp)} XP${finalPlan.levelsGained ? ` → Lv ${finalPlan.newLevel}` : ''}. Save in-game to keep it!`,
        'success'
      );
      await close(true); // resume + forced .sav backup
    } catch (err) {
      if (spendId !== null) await refundSpend(spendId).catch(() => undefined); // never lose banked XP
      notify(err instanceof Error ? err.message : 'Could not apply the XP.', 'warn');
      await load(); // refresh the view from live memory
    }
  };

  if (!mounted) return null;

  /* ---------------- render ---------------- */
  const body = () => {
    if (phase === 'loading') {
      return (
        <div className="flex flex-col items-center gap-3 py-16 text-slate-400">
          <Loader2 className="h-8 w-8 animate-spin text-electric-400" />
          <p className="text-sm">Pausing the game and reading your party…</p>
        </div>
      );
    }
    if (phase === 'unavailable') {
      const text =
        why === 'wrong-game'
          ? `Spend XP currently supports Pokémon Emerald (game code BPEE). Your ROM reports "${emu.rom?.gameCode ?? 'unknown'}".`
          : 'Launch your Pokémon Emerald ROM in Tab 2 to inspect your party!';
      return (
        <div className="flex flex-col items-center gap-4 px-4 py-12 text-center">
          <Rocket className="h-10 w-10 text-electric-400" />
          <p className="max-w-xs text-slate-300">{text}</p>
          {why === 'not-running' && emu.rom && (
            <button
              onClick={() => {
                void close(false);
                void emu.start();
              }}
              className="rounded-xl bg-electric-500 px-5 py-2.5 font-bold text-white active:bg-electric-600"
            >
              Start Game
            </button>
          )}
        </div>
      );
    }
    if (phase === 'error' || !data) {
      return (
        <div className="flex flex-col items-center gap-4 px-4 py-12 text-center">
          <AlertTriangle className="h-10 w-10 text-volt-400" />
          <p className="max-w-xs text-sm text-slate-300">{errorText}</p>
          <button onClick={() => void load()} className="rounded-xl bg-ink-700 px-5 py-2.5 font-semibold active:bg-ink-600">
            Try again
          </button>
        </div>
      );
    }

    const busy = phase === 'applying';
    return (
      <div className="space-y-4">
        {/* Bank + cap */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-volt-500/30 bg-volt-500/10 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">XP Bank</div>
            <div className="mt-0.5 flex items-center gap-1 text-xl font-extrabold text-volt-400">
              <Zap className="h-5 w-5 fill-volt-400" /> {fmt(xpBank)}
            </div>
          </div>
          <div className="rounded-2xl border border-electric-500/30 bg-electric-500/10 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Level Cap</div>
            <div className="mt-0.5 flex items-center gap-1 text-xl font-extrabold text-electric-400">
              <Lock className="h-4 w-4" /> Lv {cap}
            </div>
            <div className="truncate text-[11px] text-slate-400">{progressLabel(progress)}</div>
          </div>
        </div>

        {data.progress.badges === null && choice === 'auto' && (
          <p className="rounded-xl border border-volt-500/30 bg-volt-500/10 p-3 text-xs text-volt-400">
            Couldn't read your badge flags, so the safest cap (Lv 15) is applied. Choose your progress below to change it.
          </p>
        )}

        <label className="block text-xs text-slate-400">
          Progress used for the cap
          <select
            value={choice}
            onChange={(e) => pickChoice(e.target.value as ProgressChoice)}
            className="mt-1 w-full rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-white outline-none focus:border-electric-400"
          >
            <option value="auto">Auto-detect ({progressLabel(detected)})</option>
            {BADGE_LABELS.map((l, i) => (
              <option key={l} value={`b${i}`}>
                {i} badge{i === 1 ? '' : 's'} — {l}
              </option>
            ))}
            <option value="elite4">Elite Four / Champion (Lv 58)</option>
            <option value="postgame">Post-Game (Lv 100)</option>
          </select>
        </label>

        {/* Party */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {data.snap.mons.map((m, i) => {
            if (!m) {
              return (
                <div key={i} className="rounded-2xl border border-dashed border-ink-700 p-3 text-xs text-slate-600">
                  Slot {i + 1} · empty
                </div>
              );
            }
            const b = data.table.get(m.species);
            const usable = !!b && !m.isEgg;
            const capXp = b ? expForLevel(b.growthRate, cap) : 0;
            const atCap = !!b && m.exp >= capXp;
            const isSel = i === selected;
            const pct = capXp > 0 ? Math.min(100, (m.exp / capXp) * 100) : 0;
            const addPct = isSel && plan && capXp > 0 ? Math.min(100 - pct, (plan.xp / capXp) * 100) : 0;
            return (
              <button
                key={i}
                disabled={!usable || busy}
                onClick={() => {
                  setSelected(i);
                  setAlloc(0);
                }}
                className={`rounded-2xl border p-3 text-left transition ${
                  isSel ? 'border-electric-400 bg-electric-500/10' : 'border-ink-700 bg-ink-800'
                } ${usable ? 'active:scale-[0.99]' : 'opacity-50'}`}
              >
                <div className="flex items-center gap-3">
                  <SpritePlaceholder mon={m} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-bold">{m.nickname || '???'}</span>
                      <span className="shrink-0 text-sm font-semibold text-slate-300">
                        Lv {m.level}
                        {isSel && plan && plan.levelsGained > 0 && <span className="text-volt-400"> → {plan.newLevel}</span>}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {m.isEgg ? 'Egg' : `HP ${m.hp}/${m.maxHp} · ${m.nature}`}
                    </div>
                  </div>
                </div>
                {usable ? (
                  <>
                    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-ink-900">
                      <div className="bg-electric-500" style={{ width: `${pct}%` }} />
                      <div className="bg-volt-400 transition-all" style={{ width: `${addPct}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[11px] text-slate-500">
                      <span>
                        {fmt(m.exp)} / {fmt(capXp)} XP
                      </span>
                      <span className={atCap ? 'font-semibold text-volt-400' : ''}>
                        {atCap ? 'At cap' : `Cap Lv ${cap}`}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="mt-2 text-[11px] text-slate-500">{m.isEgg ? 'Eggs can’t gain XP.' : 'Species data unavailable.'}</div>
                )}
              </button>
            );
          })}
        </div>

        {/* Allocation */}
        {mon && base && (
          <div className="rounded-2xl border border-ink-700 bg-ink-800 p-4">
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-sm font-semibold">Allocate to {mon.nickname}</span>
              <span className="flex items-center gap-1 text-lg font-extrabold text-volt-400">
                <Zap className="h-4 w-4 fill-volt-400" /> {fmt(amount)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.max(1, max)}
              step={1}
              value={amount}
              disabled={max === 0 || busy}
              onChange={(e) => setAlloc(Number(e.target.value))}
              className="h-8 w-full accent-amber-400 disabled:opacity-40"
              aria-label="XP to allocate"
            />
            <div className="flex justify-between text-[11px] text-slate-500">
              <span>0</span>
              <span>
                max {fmt(max)} {max < xpBank ? `(Lv ${cap} cap)` : '(your bank)'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-4 gap-2 text-xs font-semibold">
              {[
                ['+100', () => setAlloc(Math.min(max, amount + 100))],
                ['+1k', () => setAlloc(Math.min(max, amount + 1000))],
                ['Next Lv', () => setAlloc(Math.min(max, Math.max(1, nextLevelGap)))],
                ['Max', () => setAlloc(max)],
              ].map(([label, fn]) => (
                <button
                  key={label as string}
                  disabled={max === 0 || busy}
                  onClick={fn as () => void}
                  className="rounded-lg border border-ink-600 bg-ink-900 py-2 active:bg-ink-700 disabled:opacity-40"
                >
                  {label as string}
                </button>
              ))}
            </div>
            {max === 0 && (
              <p className="mt-3 text-xs text-volt-400">
                {xpBank === 0 ? 'Your bank is empty. Log a workout first.' : `${mon.nickname} is at the Lv ${cap} cap. Earn the next badge to unlock more.`}
              </p>
            )}
            {plan && (
              <div className="mt-3 rounded-xl bg-ink-900 p-3 text-xs text-slate-300">
                <div>
                  Level {mon.level} → <b className="text-white">{plan.newLevel}</b> · Max HP {mon.maxHp} → <b className="text-white">{plan.stats.hp}</b>
                </div>
                <div className="mt-1 text-slate-500">
                  Leftover in bank: <b className="text-volt-400">{fmt(xpBank - plan.xp)} XP</b>
                </div>
              </div>
            )}
          </div>
        )}

        <p className="flex gap-2 rounded-xl bg-ink-800 p-3 text-[11px] leading-relaxed text-slate-500">
          <ChevronsRight className="mt-0.5 h-4 w-4 shrink-0" />
          Do this in the overworld, not mid-battle or with a menu open. This sets experience, level and stats directly;
          it does not play level-up scenes or learn moves. Evolution happens at the Pokémon's next level-up in battle.
          Save in-game afterward so the change is written to your save.
        </p>

        <button
          disabled={!plan || busy}
          onClick={() => void confirm()}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-electric-500 py-3.5 font-bold text-white active:bg-electric-600 disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Zap className="h-5 w-5 fill-white" />}
          {busy ? 'Applying…' : 'Confirm Allocation'}
        </button>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Spend banked XP">
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-300 ${entered ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => phase !== 'applying' && void close()}
      />
      <div
        className={`safe-bottom absolute inset-x-0 bottom-0 mx-auto flex max-h-[92vh] w-full max-w-md flex-col rounded-t-3xl border border-ink-600 bg-ink-900 shadow-2xl transition-transform duration-300 ease-out ${
          entered ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <div>
            <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-ink-600" />
            <h2 className="flex items-center gap-2 text-lg font-bold">
              <Zap className="h-5 w-5 fill-volt-400 text-volt-400" /> Spend Banked XP
            </h2>
          </div>
          <button
            onClick={() => void close()}
            disabled={phase === 'applying'}
            aria-label="Close"
            className="rounded-full p-1.5 text-slate-400 hover:bg-ink-700 disabled:opacity-40"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 pb-5">{body()}</div>
      </div>
    </div>
  );
}

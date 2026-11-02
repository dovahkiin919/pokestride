import { describe, expect, it } from 'vitest';
import { BaseStatsTable } from '../baseStats';
import { buildMon, expForLevel, parseMon } from '../gen3';
import { BADGE_CAPS, autoProgress, capLevel, resolveProgress } from '../levelCaps';
import {
  EmeraldRam, FLAG_BADGE01_GET, FLAG_SYS_GAME_CLEAR, PARTY_EWRAM_OFFSET, RamError, SAVEBLOCK1_PTR_IWRAM_OFFSET, locateRam,
} from '../ram';
import { buildUpdatedMon, maxAllocatable, planSpend } from '../spend';

const HEAP = 2 * 1024 * 1024;
const EW = 0x80000; // live EWRAM in the fake heap
const IW = 0x40000; // live IWRAM
const STALE = 0x100000; // stale serialized copy

const mon = (p: number, n: string, exp = 2000, level = 14) =>
  buildMon({ personality: p, otId: 0x11223344, nickname: n, species: 1, exp, level, hp: 40, maxHp: 44,
    ivs: { hp: 15, atk: 15, def: 15, spe: 15, spa: 15, spd: 15 } });

function fakeHeap(opts: { stale?: boolean; pointers?: boolean; badges?: number; clear?: boolean } = {}) {
  const heap = new Uint8Array(HEAP);
  const dv = new DataView(heap.buffer);
  const putParty = (base: number) => {
    heap.set(mon(0x1000, 'BULBA'), base + PARTY_EWRAM_OFFSET);
    heap.set(mon(0x2001, 'IVY'), base + PARTY_EWRAM_OFFSET + 100);
    heap[base + 0x244e9] = 2;
  };
  putParty(EW);
  if (opts.stale) putParty(STALE);
  if (opts.pointers !== false) {
    dv.setUint32(0x2000, EW, true); // gba->memory.wram
    dv.setUint32(0x2004, IW, true); // gba->memory.iwram
  }
  // SaveBlock1 lives at 0x02025A24 (shifted), pointer stored in IWRAM
  const sb1 = 0x25a24;
  dv.setUint32(IW + SAVEBLOCK1_PTR_IWRAM_OFFSET, 0x02000000 + sb1, true);
  const flags = EW + sb1 + 0x1270;
  const setFlag = (id: number) => (heap[flags + (id >> 3)] |= 1 << (id & 7));
  for (let i = 0; i < (opts.badges ?? 0); i++) setFlag(FLAG_BADGE01_GET + i);
  if (opts.clear) setFlag(FLAG_SYS_GAME_CLEAR);
  return heap;
}

describe('RAM locator', () => {
  it('finds EWRAM and IWRAM through the core pointers', () => {
    const loc = locateRam(fakeHeap());
    expect(loc).toEqual({ ewram: EW, iwram: IW, confidence: 'pointer-confirmed' });
  });

  it('ignores a stale duplicate copy because the core does not point at it', () => {
    const loc = locateRam(fakeHeap({ stale: true }));
    expect(loc.ewram).toBe(EW);
  });

  it('accepts a sole match when no pointer is found, but refuses ambiguity', () => {
    expect(locateRam(fakeHeap({ pointers: false })).confidence).toBe('unique-match');
    expect(() => locateRam(fakeHeap({ pointers: false, stale: true }))).toThrow(RamError);
  });

  it('fails politely when there is no party (e.g. before New Game)', () => {
    try {
      locateRam(new Uint8Array(HEAP));
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as RamError).code).toBe('not-found');
    }
  });
});

describe('EmeraldRam', () => {
  it('reads the party and badge progress', () => {
    const heap = fakeHeap({ badges: 3 });
    const ram = EmeraldRam.attach(() => heap);
    const snap = ram.readParty();
    expect(snap.count).toBe(2);
    expect(snap.mons[0]!.nickname).toBe('BULBA');
    expect(snap.mons[1]!.nickname).toBe('IVY');
    expect(snap.mons[2]).toBeNull();
    expect(ram.readProgress(snap.mons[0])).toEqual({ badges: 3, gameClear: false, via: 'iwram-pointer' });
  });

  it('counts all 8 badges and the game-clear flag', () => {
    const heap = fakeHeap({ badges: 8, clear: true });
    const ram = EmeraldRam.attach(() => heap);
    const p = ram.readProgress(ram.readParty().mons[0]);
    expect(p.badges).toBe(8);
    expect(autoProgress(p.badges, p.gameClear)).toEqual({ kind: 'postgame' });
  });

  it('falls back to matching SaveBlock1 inside EWRAM when IWRAM is unknown', () => {
    const heap = fakeHeap({ badges: 2, pointers: false });
    const sb1 = 0x25a24;
    heap.set(heap.slice(EW + PARTY_EWRAM_OFFSET, EW + PARTY_EWRAM_OFFSET + 200), EW + sb1 + 0x238); // saved party copy
    const ram = EmeraldRam.attach(() => heap);
    expect(ram.readProgress(ram.readParty().mons[0])).toMatchObject({ badges: 2, via: 'ewram-scan' });
  });

  it('writes a mon, verifies the readback and refuses a changed slot', () => {
    const heap = fakeHeap();
    const ram = EmeraldRam.attach(() => heap);
    const snap = ram.readParty();
    const raw0 = snap.raw.slice(0, 100);
    const updated = buildUpdatedMon(raw0, {
      xp: 1, newExp: 2035, newLevel: 15, levelsGained: 1, capExp: 2035,
      stats: { hp: 50, atk: 20, def: 20, spe: 20, spa: 20, spd: 20 },
    });
    ram.writeSlot(0, updated, snap.mons[0]!.personality);
    const after = ram.readParty();
    expect(after.mons[0]!.exp).toBe(2035);
    expect(after.mons[0]!.level).toBe(15);
    expect(after.mons[0]!.checksumOk).toBe(true);
    expect(after.mons[1]!.nickname).toBe('IVY'); // neighbour untouched
    expect(() => ram.writeSlot(0, updated, 0xdead)).toThrow(/changed/);
  });

  it('reports "lost" once the party is gone', () => {
    const heap = fakeHeap();
    const ram = EmeraldRam.attach(() => heap);
    heap.fill(0, EW + PARTY_EWRAM_OFFSET, EW + PARTY_EWRAM_OFFSET + 600);
    expect(() => ram.readParty()).toThrow(RamError);
  });
});

describe('base stats from ROM', () => {
  function fakeRom() {
    const rom = new Uint8Array(0x10000);
    const base = 0x4000;
    const set = (i: number, bytes: number[]) => rom.set(bytes, base + i * 28);
    set(1, [45, 49, 49, 45, 65, 65, 12, 3, 45, 64, 0, 1, 0, 0, 0, 0, 31, 20, 70, 3, 1, 7, 65, 0, 0, 0, 0, 0]);
    set(2, [60, 62, 63, 60, 80, 80, 12, 3, 45, 141, 0, 2, 0, 0, 0, 0, 31, 20, 70, 3, 1, 7, 65, 0, 0, 0, 0, 0]);
    set(3, [80, 82, 83, 80, 100, 100, 12, 3, 45, 208, 0, 3, 0, 0, 0, 0, 31, 20, 70, 3, 1, 7, 65, 0, 0, 0, 0, 0]);
    return { rom, base };
  }
  it('finds the table by fingerprint and reads growth rate + stats', () => {
    const { rom, base } = fakeRom();
    const t = BaseStatsTable.fromRom(rom)!;
    expect(t.offset).toBe(base);
    expect(t.get(2)).toEqual({ hp: 60, atk: 62, def: 63, spe: 60, spa: 80, spd: 80, growthRate: 3 });
    expect(t.get(0)).toBeNull();
    expect(t.get(400)).toBeNull();
  });
  it('returns null for a ROM without the table', () => {
    expect(BaseStatsTable.fromRom(new Uint8Array(5000))).toBeNull();
  });
});

describe('level caps + spend planning', () => {
  it('matches the specified cap table', () => {
    expect(BADGE_CAPS).toEqual([15, 15, 19, 24, 29, 31, 33, 42, 46]);
    expect(capLevel({ kind: 'badges', count: 2 })).toBe(19);
    expect(capLevel({ kind: 'elite4' })).toBe(58);
    expect(capLevel({ kind: 'postgame' })).toBe(100);
    expect(resolveProgress('b5', { kind: 'badges', count: 0 })).toEqual({ kind: 'badges', count: 5 });
    expect(autoProgress(null, null)).toEqual({ kind: 'badges', count: 0 });
  });

  const base = { hp: 45, atk: 49, def: 49, spe: 45, spa: 65, spd: 65, growthRate: 3 as const };
  const m = () => parseMon(mon(0x1000, 'BULBA', 1500, 13), 0)!;

  it('clamps the slider maximum to the cap and to the bank', () => {
    const capXp = expForLevel(3, 15); // 2035
    expect(maxAllocatable(m(), base, 15, 999_999)).toBe(capXp - 1500);
    expect(maxAllocatable(m(), base, 15, 100)).toBe(100);
    expect(maxAllocatable(parseMon(mon(1, 'X', capXp, 15), 0)!, base, 15, 5000)).toBe(0); // already at cap
  });

  it('never lets a plan exceed the cap, whatever is requested', () => {
    const plan = planSpend(m(), base, 15, 1_000_000, 1_000_000);
    expect(plan.newExp).toBe(2035);
    expect(plan.newLevel).toBe(15);
    expect(plan.xp).toBe(535);
    expect(plan.stats.hp).toBe(40); // floor((2*45+15)*15/100)+15+10
  });
});

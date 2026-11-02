import { describe, expect, it } from 'vitest';
import {
  applyUpdate, buildMon, computeStats, decodeGen3Text, expForLevel, isMonPlausible, levelForExp, parseMon,
  type BaseStats, type GrowthRate,
} from '../gen3';

describe('experience tables', () => {
  it('matches the known level-100 totals for all six growth rates', () => {
    const expected: [GrowthRate, number][] = [
      [0, 1_000_000], [1, 600_000], [2, 1_640_000], [3, 1_059_860], [4, 800_000], [5, 1_250_000],
    ];
    for (const [rate, total] of expected) expect(expForLevel(rate, 100)).toBe(total);
  });
  it('matches known early-level values', () => {
    expect(expForLevel(3, 15)).toBe(2035);
    expect([2, 3].map((l) => expForLevel(3, l))).toEqual([9, 57]);
    expect(expForLevel(1, 2)).toBe(15);
    expect(expForLevel(2, 2)).toBe(4);
    expect(expForLevel(0, 1)).toBe(0);
  });
  it('is monotonic and round-trips through levelForExp', () => {
    for (const r of [0, 1, 2, 3, 4, 5] as GrowthRate[]) {
      for (let l = 2; l <= 100; l++) {
        expect(expForLevel(r, l)).toBeGreaterThanOrEqual(expForLevel(r, l - 1));
        expect(levelForExp(r, expForLevel(r, l))).toBeGreaterThanOrEqual(l);
        expect(levelForExp(r, expForLevel(r, l) - 1)).toBeLessThan(l + 0.0001 + 1);
      }
    }
    expect(levelForExp(3, 2035)).toBe(15);
    expect(levelForExp(3, 2034)).toBe(14);
  });
});

describe('stats', () => {
  const base: BaseStats = { hp: 45, atk: 49, def: 49, spe: 45, spa: 65, spd: 65, growthRate: 3 };
  const iv31 = { hp: 31, atk: 31, def: 31, spe: 31, spa: 31, spd: 31 };
  const ev0 = { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };
  it('computes a neutral-nature level 50 mon', () => {
    // personality % 25 == 0 -> Hardy (neutral)
    const s = computeStats(base, iv31, ev0, 50, 0);
    expect(s.hp).toBe(120);
    expect(s.atk).toBe(69);
  });
  it('applies nature modifiers (Adamant = +Atk -SpA)', () => {
    const s = computeStats(base, iv31, ev0, 50, 3);
    expect(s.atk).toBe(75);
    expect(s.spa).toBe(Math.floor((Math.floor(((130 + 31) * 50) / 100) + 5) * 90 / 100));
  });
  it('forces Shedinja-style 1 HP', () => {
    expect(computeStats({ ...base, hp: 1 }, iv31, ev0, 50, 0).hp).toBe(1);
  });
});

describe('gen 3 text', () => {
  it('decodes letters, digits and terminators', () => {
    // 0xBB = 'A', 0xD5 = 'a', 0xA1..0xAA = '0'..'9', 0xFF ends the string
    expect(decodeGen3Text([0xbb, 0xd5, 0xa1, 0xaa, 0xff, 0xbb])).toBe('Aa09');
    // "TREECKO" as stored in the game: T=0xCE R=0xCC E=0xBF E=0xBF C=0xBD K=0xC5 O=0xC9
    expect(decodeGen3Text([0xce, 0xcc, 0xbf, 0xbf, 0xbd, 0xc5, 0xc9, 0xff, 0xff, 0xff])).toBe('TREECKO');
  });
});

describe('party mon read / write', () => {
  const sample = (personality: number) =>
    buildMon({
      personality, otId: 0xdeadbeef, nickname: 'TREECKO', species: 277, exp: 1000, level: 10, hp: 30, maxHp: 35,
      ivs: { hp: 31, atk: 20, def: 10, spe: 5, spa: 0, spd: 17 }, evs: { hp: 4, atk: 8, def: 0, spe: 12, spa: 0, spd: 255 },
    });

  it('round-trips every one of the 24 substructure orderings', () => {
    for (let p = 0; p < 24; p++) {
      const mon = sample(0x12340000 + p);
      expect(isMonPlausible(mon)).toBe(true);
      const parsed = parseMon(mon, 0)!;
      expect(parsed.checksumOk).toBe(true);
      expect(parsed.species).toBe(277);
      expect(parsed.exp).toBe(1000);
      expect(parsed.nickname).toBe('TREECKO');
      expect(parsed.ivs).toEqual({ hp: 31, atk: 20, def: 10, spe: 5, spa: 0, spd: 17 });
      expect(parsed.evs.spd).toBe(255);
    }
  });

  it('applyUpdate changes exp/level/stats, keeps the checksum valid and leaves other data alone', () => {
    for (let p = 0; p < 24; p++) {
      const mon = sample(0x9000 + p);
      const next = applyUpdate(mon, { exp: 2035, level: 15, stats: { hp: 50, atk: 25, def: 22, spe: 28, spa: 30, spd: 24 } });
      expect(isMonPlausible(next)).toBe(true);
      const parsed = parseMon(next, 0)!;
      expect(parsed.checksumOk).toBe(true);
      expect(parsed.exp).toBe(2035);
      expect(parsed.level).toBe(15);
      expect(parsed.maxHp).toBe(50);
      expect(parsed.hp).toBe(30 + (50 - 35)); // current HP rises with max HP
      expect(parsed.species).toBe(277);
      expect(parsed.ivs.atk).toBe(20);
      expect(parsed.evs.spd).toBe(255);
      expect(parsed.nickname).toBe('TREECKO');
      // the original buffer is untouched
      expect(parseMon(mon, 0)!.exp).toBe(1000);
    }
  });

  it('keeps fainted mons fainted', () => {
    const fainted = buildMon({ personality: 77, otId: 1, nickname: 'X', species: 1, exp: 10, level: 5, hp: 0, maxHp: 20 });
    const next = applyUpdate(fainted, { exp: 100, level: 6, stats: { hp: 25, atk: 1, def: 1, spe: 1, spa: 1, spd: 1 } });
    expect(parseMon(next, 0)!.hp).toBe(0);
  });

  it('refuses to modify a mon whose checksum is already wrong', () => {
    const mon = sample(5);
    mon[0x30] ^= 0xff;
    expect(() => applyUpdate(mon, { exp: 1, level: 1, stats: { hp: 1, atk: 1, def: 1, spe: 1, spa: 1, spd: 1 } })).toThrow(/checksum/);
  });

  it('writing raw bytes at 0x1C (the naive approach) really does break the mon', () => {
    const mon = sample(5);
    new DataView(mon.buffer).setUint32(0x1c, 5000, true);
    expect(isMonPlausible(mon)).toBe(false);
  });
});

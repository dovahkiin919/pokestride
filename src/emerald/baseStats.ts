import type { BaseStats, GrowthRate } from './gen3';

/**
 * Reads species base stats (growth rate, HP, Atk, ...) straight from the user's own ROM, so nothing
 * copyrighted is bundled. The table's location is found by its fingerprint (Bulbasaur, internal species #1),
 * which works for any Emerald build instead of trusting one hard-coded ROM offset.
 *
 * BaseStats entry (28 bytes): hp atk def spe spa spd type1 type2 catch expYield evYield(2) item1(2) item2(2)
 *                             gender eggCycles friendship growthRate eggGroup1 eggGroup2 ability1 ability2 ...
 */

const ENTRY = 28;
const MAX_SPECIES = 412;

// Bulbasaur: 45/49/49/45/65/65, Grass/Poison, catch 45, exp 64 ... gender 31, cycles 20, friendship 70, Medium Slow
const BULBASAUR_HEAD = [0x2d, 0x31, 0x31, 0x2d, 0x41, 0x41, 0x0c, 0x03, 0x2d, 0x40];
const IVYSAUR_HEAD = [0x3c, 0x3e, 0x3f, 0x3c, 0x50, 0x50, 0x0c, 0x03];

export function findBaseStatsTable(rom: Uint8Array): number | null {
  const first = BULBASAUR_HEAD[0];
  for (let i = ENTRY; i + ENTRY * 3 <= rom.length; i++) {
    if (rom[i] !== first) continue;
    let ok = true;
    for (let k = 1; k < BULBASAUR_HEAD.length; k++) {
      if (rom[i + k] !== BULBASAUR_HEAD[k]) {
        ok = false;
        break;
      }
    }
    if (!ok || rom[i + 19] !== 3) continue;
    for (let k = 0; k < IVYSAUR_HEAD.length; k++) if (rom[i + ENTRY + k] !== IVYSAUR_HEAD[k]) ok = false;
    if (ok) return i - ENTRY; // entry #0 is the "??????" placeholder
  }
  return null;
}

export class BaseStatsTable {
  private constructor(private rom: Uint8Array, private base: number) {}

  static fromRom(rom: Uint8Array): BaseStatsTable | null {
    const base = findBaseStatsTable(rom);
    return base === null ? null : new BaseStatsTable(rom, base);
  }

  get offset(): number {
    return this.base;
  }

  get(species: number): BaseStats | null {
    if (species < 1 || species >= MAX_SPECIES) return null;
    const o = this.base + species * ENTRY;
    if (o + ENTRY > this.rom.length) return null;
    const r = this.rom;
    const growth = r[o + 19];
    if (growth > 5 || (r[o] === 0 && r[o + 1] === 0)) return null; // placeholder / garbage entry
    return { hp: r[o], atk: r[o + 1], def: r[o + 2], spe: r[o + 3], spa: r[o + 4], spd: r[o + 5], growthRate: growth as GrowthRate };
  }
}

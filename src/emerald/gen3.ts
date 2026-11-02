/**
 * Pure Gen 3 (Pokémon Emerald) party-data logic. No DOM, no emulator: just bytes in, bytes out.
 *
 * Party Pokémon struct (100 bytes), little-endian:
 *   0x00 personality (u32)        0x04 OT id (u32)
 *   0x08 nickname (10 bytes)      0x12 language   0x13 flags (bit0 badEgg, bit1 hasSpecies, bit2 isEgg)
 *   0x14 OT name (7)              0x1B markings   0x1C checksum (u16)   0x1E unused
 *   0x20..0x4F  48 bytes of ENCRYPTED, SHUFFLED data: 4 substructures x 12 bytes (Growth/Attacks/EVs/Misc)
 *   0x50 status (u32)  0x54 level  0x55 mail  0x56 HP  0x58 maxHP  0x5A atk 0x5C def 0x5E spe 0x60 spA 0x62 spD
 *
 * NOTE: experience is NOT at 0x1C (that is the checksum). It lives inside the Growth substructure
 * (offset +4), which is XOR-encrypted with (personality ^ otId) and placed according to personality % 24.
 * Writing raw bytes at 0x1C would break the checksum and the game would turn the Pokémon into a Bad Egg.
 */

export const MON_SIZE = 100;
export const PARTY_SIZE = 6;
export const PARTY_BYTES = MON_SIZE * PARTY_SIZE;

const OFF = {
  personality: 0x00,
  otId: 0x04,
  nickname: 0x08,
  flags: 0x13,
  checksum: 0x1c,
  data: 0x20,
  status: 0x50,
  level: 0x54,
  hp: 0x56,
  maxHp: 0x58,
  atk: 0x5a,
  def: 0x5c,
  spe: 0x5e,
  spa: 0x60,
  spd: 0x62,
} as const;

/** Substructure order per (personality % 24). G=Growth A=Attacks E=EVs M=Misc */
const ORDERS = [
  'GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA',
  'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG',
  'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG',
] as const;

type Sub = 'G' | 'A' | 'E' | 'M';

/* ---------- Western character table ---------- */

const EXTRA_CHARS: Record<number, string> = {
  0x00: ' ', 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-', 0xb0: '…', 0xb1: '“', 0xb2: '”',
  0xb3: '‘', 0xb4: '’', 0xb5: '♂', 0xb6: '♀', 0xb8: ',', 0xba: '/', 0x1b: 'é', 0xf0: ':',
};

export function decodeGen3Text(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0xff) break; // terminator
    if (b >= 0xa1 && b <= 0xaa) out += String.fromCharCode(0x30 + b - 0xa1);
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(0x41 + b - 0xbb);
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(0x61 + b - 0xd5);
    else if (EXTRA_CHARS[b] !== undefined) out += EXTRA_CHARS[b];
    else out += '?';
  }
  return out;
}

/* ---------- Low-level helpers ---------- */

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function put16(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
}
function put32(b: Uint8Array, o: number, v: number) {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}

export const readU32 = u32;
export const readU16 = u16;

/** XOR-(de|en)crypts the 48-byte data block in place (the operation is its own inverse). */
function xorBlock(block: Uint8Array, key: number) {
  for (let i = 0; i < 48; i += 4) put32(block, i, (u32(block, i) ^ key) >>> 0);
}

function checksumOf(plain: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < 48; i += 2) sum = (sum + u16(plain, i)) & 0xffff;
  return sum;
}

function subOffset(personality: number, which: Sub): number {
  return ORDERS[personality % 24].indexOf(which) * 12;
}

/** Decrypts a mon's 48-byte data block. Returns a fresh copy. */
function decryptData(mon: Uint8Array): Uint8Array {
  const block = mon.slice(OFF.data, OFF.data + 48);
  xorBlock(block, (u32(mon, OFF.personality) ^ u32(mon, OFF.otId)) >>> 0);
  return block;
}

/* ---------- Experience tables ---------- */

export type GrowthRate = 0 | 1 | 2 | 3 | 4 | 5; // MediumFast, Erratic, Fluctuating, MediumSlow, Fast, Slow
export const GROWTH_NAMES = ['Medium Fast', 'Erratic', 'Fluctuating', 'Medium Slow', 'Fast', 'Slow'] as const;

/** Total experience required to *be* level n (Gen 3 tables; level 1 and below = 0). */
export function expForLevel(rate: GrowthRate, n: number): number {
  if (n <= 1) return 0;
  if (n > 100) n = 100;
  const c = n * n * n;
  switch (rate) {
    case 0:
      return c;
    case 1:
      if (n <= 50) return Math.floor((c * (100 - n)) / 50);
      if (n <= 68) return Math.floor((c * (150 - n)) / 100);
      if (n <= 98) return Math.floor((c * Math.floor((1911 - 10 * n) / 3)) / 500);
      return Math.floor((c * (160 - n)) / 100);
    case 2:
      if (n <= 15) return Math.floor((c * (Math.floor((n + 1) / 3) + 24)) / 50);
      if (n <= 36) return Math.floor((c * (n + 14)) / 50);
      return Math.floor((c * (Math.floor(n / 2) + 32)) / 50);
    case 3:
      return Math.max(0, Math.floor((6 * c) / 5) - 15 * n * n + 100 * n - 140);
    case 4:
      return Math.floor((4 * c) / 5);
    case 5:
      return Math.floor((5 * c) / 4);
  }
}

/** Highest level whose threshold is <= exp (capped at 100). */
export function levelForExp(rate: GrowthRate, exp: number): number {
  let lvl = 1;
  for (let l = 2; l <= 100; l++) {
    if (expForLevel(rate, l) <= exp) lvl = l;
    else break;
  }
  return lvl;
}

/* ---------- Natures & stats ---------- */

export const NATURES = [
  'Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash',
  'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky',
] as const;

export interface BaseStats {
  hp: number; atk: number; def: number; spe: number; spa: number; spd: number;
  growthRate: GrowthRate;
}
export interface StatBlock { hp: number; atk: number; def: number; spe: number; spa: number; spd: number }

/** Mirrors pokeemerald CalculateMonStats. */
export function computeStats(base: BaseStats, ivs: StatBlock, evs: StatBlock, level: number, personality: number): StatBlock {
  const nat = personality % 25;
  const inc = Math.floor(nat / 5);
  const dec = nat % 5;
  const order = ['atk', 'def', 'spe', 'spa', 'spd'] as const;
  const other = (key: (typeof order)[number], idx: number) => {
    const raw = Math.floor(((2 * base[key] + ivs[key] + Math.floor(evs[key] / 4)) * level) / 100) + 5;
    if (inc === dec) return raw;
    if (idx === inc) return Math.floor((raw * 110) / 100);
    if (idx === dec) return Math.floor((raw * 90) / 100);
    return raw;
  };
  const hp =
    base.hp === 1
      ? 1 // Shedinja
      : Math.floor(((2 * base.hp + ivs.hp + Math.floor(evs.hp / 4)) * level) / 100) + level + 10;
  return {
    hp,
    atk: other('atk', 0),
    def: other('def', 1),
    spe: other('spe', 2),
    spa: other('spa', 3),
    spd: other('spd', 4),
  };
}

/* ---------- Parsed party member ---------- */

export interface PartyMon {
  slot: number;
  personality: number;
  otId: number;
  nickname: string;
  species: number; // internal Gen 3 species index
  exp: number;
  level: number;
  hp: number;
  maxHp: number;
  isEgg: boolean;
  ivs: StatBlock;
  evs: StatBlock;
  nature: string;
  checksumOk: boolean;
}

export function isMonPlausible(mon: Uint8Array): boolean {
  if (mon.length < MON_SIZE) return false;
  const flags = mon[OFF.flags];
  if (flags & 1) return false; // bad egg
  const level = mon[OFF.level];
  const maxHp = u16(mon, OFF.maxHp);
  const hp = u16(mon, OFF.hp);
  if (level < 1 || level > 100 || maxHp < 1 || maxHp > 714 || hp > maxHp) return false;
  return checksumOf(decryptData(mon)) === u16(mon, OFF.checksum);
}

export function parseMon(mon: Uint8Array, slot: number): PartyMon | null {
  if (mon.length < MON_SIZE) return null;
  const personality = u32(mon, OFF.personality);
  const plain = decryptData(mon);
  const checksumOk = checksumOf(plain) === u16(mon, OFF.checksum);
  const g = subOffset(personality, 'G');
  const e = subOffset(personality, 'E');
  const m = subOffset(personality, 'M');
  const species = u16(plain, g);
  if (species === 0) return null;
  const iv = u32(plain, m + 4);
  const ivBits = (shift: number) => (iv >>> shift) & 31;
  return {
    slot,
    personality,
    otId: u32(mon, OFF.otId),
    nickname: decodeGen3Text(mon.subarray(OFF.nickname, OFF.nickname + 10)),
    species,
    exp: u32(plain, g + 4),
    level: mon[OFF.level],
    hp: u16(mon, OFF.hp),
    maxHp: u16(mon, OFF.maxHp),
    isEgg: ((iv >>> 30) & 1) === 1 || (mon[OFF.flags] & 4) !== 0,
    ivs: { hp: ivBits(0), atk: ivBits(5), def: ivBits(10), spe: ivBits(15), spa: ivBits(20), spd: ivBits(25) },
    evs: { hp: plain[e], atk: plain[e + 1], def: plain[e + 2], spe: plain[e + 3], spa: plain[e + 4], spd: plain[e + 5] },
    nature: NATURES[personality % 25],
    checksumOk,
  };
}

/** Reads the 6 slots out of a 600-byte party buffer. Empty / invalid slots come back as null. */
export function parseParty(party: Uint8Array, count: number): (PartyMon | null)[] {
  const out: (PartyMon | null)[] = [];
  for (let i = 0; i < PARTY_SIZE; i++) {
    out.push(i < count ? parseMon(party.subarray(i * MON_SIZE, (i + 1) * MON_SIZE), i) : null);
  }
  return out;
}

/* ---------- Writing ---------- */

export interface MonUpdate {
  exp: number;
  level: number;
  /** New stats; HP is "maxHp". Current HP is adjusted by the max-HP change like the game does. */
  stats: StatBlock;
}

/**
 * Returns a NEW 100-byte buffer with experience, level, stats and HP updated and the checksum recomputed.
 * Throws if the source mon fails its checksum (we never rewrite data we can't validate).
 */
export function applyUpdate(mon: Uint8Array, upd: MonUpdate): Uint8Array {
  const out = mon.slice(0, MON_SIZE);
  const personality = u32(out, OFF.personality);
  const key = (personality ^ u32(out, OFF.otId)) >>> 0;
  const plain = decryptData(out);
  if (checksumOf(plain) !== u16(out, OFF.checksum)) throw new Error('Party data failed its checksum; refusing to modify it.');

  put32(plain, subOffset(personality, 'G') + 4, upd.exp >>> 0);
  put16(out, OFF.checksum, checksumOf(plain));
  xorBlock(plain, key); // re-encrypt
  out.set(plain, OFF.data);

  const oldMax = u16(out, OFF.maxHp);
  const oldHp = u16(out, OFF.hp);
  let hp = oldHp;
  if (oldHp !== 0) {
    hp = oldHp + (upd.stats.hp - oldMax); // same rule as CalculateMonStats
    hp = Math.max(1, Math.min(upd.stats.hp, hp));
  }
  out[OFF.level] = upd.level;
  put16(out, OFF.hp, hp);
  put16(out, OFF.maxHp, upd.stats.hp);
  put16(out, OFF.atk, upd.stats.atk);
  put16(out, OFF.def, upd.stats.def);
  put16(out, OFF.spe, upd.stats.spe);
  put16(out, OFF.spa, upd.stats.spa);
  put16(out, OFF.spd, upd.stats.spd);
  return out;
}

/* ---------- Test helper: build a valid mon (used by unit tests and the integration ROM) ---------- */

export function buildMon(opts: {
  personality: number; otId: number; nickname: string; species: number; exp: number; level: number;
  hp: number; maxHp: number; ivs?: StatBlock; evs?: StatBlock; stats?: Partial<StatBlock>;
}): Uint8Array {
  const mon = new Uint8Array(MON_SIZE);
  put32(mon, OFF.personality, opts.personality);
  put32(mon, OFF.otId, opts.otId);
  const rev: Record<string, number> = {};
  for (let b = 0; b < 256; b++) {
    const ch = decodeGen3Text([b]);
    if (ch !== '?' && !(ch in rev)) rev[ch] = b;
  }
  mon.fill(0xff, OFF.nickname, OFF.nickname + 10);
  [...opts.nickname.slice(0, 10)].forEach((c, i) => (mon[OFF.nickname + i] = rev[c] ?? 0xac));
  mon[OFF.flags] = 0x02; // hasSpecies

  const plain = new Uint8Array(48);
  const p = opts.personality;
  put16(plain, subOffset(p, 'G'), opts.species);
  put32(plain, subOffset(p, 'G') + 4, opts.exp);
  const ev = opts.evs ?? { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };
  const e = subOffset(p, 'E');
  [ev.hp, ev.atk, ev.def, ev.spe, ev.spa, ev.spd].forEach((v, i) => (plain[e + i] = v));
  const iv = opts.ivs ?? { hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 };
  const ivWord =
    (iv.hp | (iv.atk << 5) | (iv.def << 10) | (iv.spe << 15) | (iv.spa << 20) | (iv.spd << 25)) >>> 0;
  put32(plain, subOffset(p, 'M') + 4, ivWord);

  put16(mon, OFF.checksum, checksumOf(plain));
  xorBlock(plain, (p ^ opts.otId) >>> 0);
  mon.set(plain, OFF.data);

  mon[OFF.level] = opts.level;
  put16(mon, OFF.hp, opts.hp);
  put16(mon, OFF.maxHp, opts.maxHp);
  const s = { atk: 10, def: 10, spe: 10, spa: 10, spd: 10, ...opts.stats };
  put16(mon, OFF.atk, s.atk);
  put16(mon, OFF.def, s.def);
  put16(mon, OFF.spe, s.spe);
  put16(mon, OFF.spa, s.spa);
  put16(mon, OFF.spd, s.spd);
  return mon;
}

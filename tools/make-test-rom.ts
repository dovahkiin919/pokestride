/**
 * Generates a tiny, original GBA ROM that LOOKS like Pokémon Emerald to PokéStride's memory reader
 * (game code BPEE, valid encrypted party in EWRAM, badge flags, base-stat table) without containing any
 * Nintendo data. Used for automated tests of the Spend XP drawer against the real mGBA core.
 *
 *   npm run make-test-rom        -> test-fixtures/emerald-synthetic.gba
 *
 * At boot the ARM code copies fixtures into emulated RAM, then loops forever copying the first party
 * member's level byte to 0x02030000 so a test can prove the *running CPU* sees edits made through HEAPU8.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildMon } from '../src/emerald/gen3';

const out = process.argv[2] ?? 'test-fixtures/emerald-synthetic.gba';
const BADGES = Number(process.env.BADGES ?? 2);

const iv = { hp: 15, atk: 15, def: 15, spe: 15, spa: 15, spd: 15 };
const party = new Uint8Array(600);
party.set(buildMon({ personality: 0x00001234, otId: 0x11223344, nickname: 'BULBA', species: 1, exp: 1500, level: 13, hp: 38, maxHp: 38, ivs: iv }), 0);
party.set(buildMon({ personality: 0x0000a5a7, otId: 0x11223344, nickname: 'IVY', species: 2, exp: 3000, level: 14, hp: 50, maxHp: 50, ivs: iv }), 100);

const SB1 = 0x02025a24; // SaveBlock1 "shifted" like the real game does
const flags = new Uint8Array(300);
for (let i = 0; i < BADGES; i++) {
  const id = 0x867 + i;
  flags[id >> 3] |= 1 << (id & 7);
}

// Base-stat table (28-byte entries, entry 0 is the placeholder). Species 1..3 only.
const entry = (b: number[], growth = 3) => {
  const e = new Uint8Array(28);
  e.set(b);
  e[16] = 31; e[17] = 20; e[18] = 70; e[19] = growth;
  return e;
};
const table = new Uint8Array(28 * 4);
table.set(entry([45, 49, 49, 45, 65, 65, 12, 3, 45, 64]), 28);
table.set(entry([60, 62, 63, 60, 80, 80, 12, 3, 45, 141]), 56);
table.set(entry([80, 82, 83, 80, 100, 100, 12, 3, 45, 208]), 84);

const word = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);

interface Block { data: Uint8Array; dst: number }
const blocks: Block[] = [
  { data: party, dst: 0x020244ec },
  { data: word(0x00000200), dst: 0x020244e8 }, // gPlayerPartyCount @ ...E9 = 2
  { data: word(SB1), dst: 0x03005d8c }, // gSaveBlock1Ptr
  { data: flags, dst: SB1 + 0x1270 },
];

const ROM_SIZE = 0x4000;
const rom = new Uint8Array(ROM_SIZE);
const dv = new DataView(rom.buffer);
const DATA_AT = 0x800;
const TABLE_AT = 0x1000;
rom.set(table, TABLE_AT);
rom.set(new TextEncoder().encode('SRAM_V113'), 0x1800); // makes mGBA create a battery save

// ---- ARM code ----
const CODE_AT = 0xc0;
const code: number[] = [];
const pool: number[] = [];
const POOL_AT = 0x400;
const lit = (v: number) => {
  pool.push(v >>> 0);
  return POOL_AT + (pool.length - 1) * 4;
};
const ldrLit = (rd: number, value: number) => {
  const here = CODE_AT + code.length * 4;
  const off = lit(value) - (here + 8);
  code.push((0xe59f0000 | (rd << 12) | off) >>> 0);
};

let dataCursor = DATA_AT;
for (const b of blocks) {
  rom.set(b.data, dataCursor);
  ldrLit(0, 0x08000000 + dataCursor);
  ldrLit(1, b.dst);
  ldrLit(2, b.data.length / 4);
  code.push(0xe4903004); // ldr r3,[r0],#4
  code.push(0xe4813004); // str r3,[r1],#4
  code.push(0xe2522001); // subs r2,r2,#1
  code.push(0x1afffffb); // bne -> ldr r3
  dataCursor += b.data.length;
}
ldrLit(0, 0x0e000000); // touch battery SRAM once so mGBA creates a .sav
code.push(0xe3a01042); // mov r1,#0x42
code.push(0xe5c01000); // strb r1,[r0]
ldrLit(0, 0x020244ec + 0x54); // &party[0].level
ldrLit(1, 0x02030000); // mirror
code.push(0xe5d02000); // ldrb r2,[r0]
code.push(0xe5c12000); // strb r2,[r1]
code.push(0xeafffffc); // b loop

code.forEach((c, i) => dv.setUint32(CODE_AT + i * 4, c, true));
pool.forEach((v, i) => dv.setUint32(POOL_AT + i * 4, v, true));

// ---- header ----
dv.setUint32(0, 0xea00002e, true); // b 0xC0
new TextEncoder().encodeInto('POKEMON EMER', rom.subarray(0xa0, 0xac));
new TextEncoder().encodeInto('BPEE', rom.subarray(0xac, 0xb0));
new TextEncoder().encodeInto('01', rom.subarray(0xb0, 0xb2));
rom[0xb2] = 0x96;
let chk = 0;
for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 255;
rom[0xbd] = (chk - 0x19) & 255;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rom);
console.log(`wrote ${out} (${rom.length} bytes, ${BADGES} badges)`);

import { MON_SIZE, PARTY_BYTES, PARTY_SIZE, isMonPlausible, parseMon, readU32, type PartyMon } from './gen3';

/**
 * Bridge between GBA addresses and the WebAssembly heap.
 *
 * A GBA address such as 0x020244EC is NOT an index into HEAPU8: mGBA keeps the emulated EWRAM (256 KiB,
 * 0x02000000) and IWRAM (32 KiB, 0x03000000) in ordinary malloc'd buffers somewhere inside the heap. So we
 * find that buffer once, by recognising a real, checksum-valid party at offset 0x244EC, and then use
 * `base + (gbaAddress - 0x02000000)` from then on.
 *
 * Pokémon Emerald (US, BPEE) addresses used:
 *   gPlayerParty        0x020244EC  (6 x 100 bytes, EWRAM)
 *   gSaveBlock1Ptr      0x03005D8C  (IWRAM, 4-byte pointer to SaveBlock1 in EWRAM; the block MOVES at runtime)
 *   SaveBlock1.flags    +0x1270     (300 bytes, one bit per flag)
 *   FLAG_BADGE01..08    0x867..0x86E
 */

export const EWRAM_SIZE = 0x40000;
export const IWRAM_SIZE = 0x8000;
export const PARTY_EWRAM_OFFSET = 0x244ec; // 0x020244EC - 0x02000000
export const SAVEBLOCK1_PTR_IWRAM_OFFSET = 0x5d8c; // 0x03005D8C - 0x03000000
const SB1_FLAGS_OFFSET = 0x1270;
const SB1_PARTY_OFFSET = 0x238; // playerParty copy inside SaveBlock1
const FLAGS_COUNT = 300;

export const FLAG_BADGE01_GET = 0x867;
/** Best-effort: FLAG_SYS_GAME_CLEAR = SYSTEM_FLAGS(0x860) + 3. Only used to unlock the post-game cap. */
export const FLAG_SYS_GAME_CLEAR = 0x863;

export type RamErrorCode = 'no-heap' | 'not-found' | 'ambiguous' | 'lost';
export class RamError extends Error {
  constructor(public code: RamErrorCode, message: string) {
    super(message);
  }
}

/** Returns heap offsets of every plausible gPlayerParty[0] (4-byte aligned, checksum-valid). */
export function findPartyCandidates(heap: Uint8Array): number[] {
  const out: number[] = [];
  const last = heap.length - PARTY_EWRAM_OFFSET - (EWRAM_SIZE - PARTY_EWRAM_OFFSET); // base + EWRAM_SIZE must fit
  for (let base = 0; base <= last; base += 4) {
    const p = base + PARTY_EWRAM_OFFSET;
    const lvl = heap[p + 0x54];
    if (lvl === 0 || lvl > 100) continue;
    if (heap[p + 0x13] & 1) continue;
    const maxHp = heap[p + 0x58] | (heap[p + 0x59] << 8);
    if (maxHp === 0 || maxHp > 714) continue;
    const hp = heap[p + 0x56] | (heap[p + 0x57] << 8);
    if (hp > maxHp) continue;
    if (isMonPlausible(heap.subarray(p, p + MON_SIZE))) out.push(base);
  }
  return out;
}

/**
 * A real party produces extra "candidates" that are not the party itself:
 *  - slot 1..5 of the same party also look like the start of a valid party (base + 100*k);
 *  - SaveBlock1 keeps a saved copy of the party (SaveBlock1 + 0x238), which sits a fixed distance after
 *    gPlayerParty because SaveBlock1 hovers around 0x02025A00.
 * Keep only the head of each cluster.
 */
export function dropShadowCandidates(cands: number[]): number[] {
  const set = new Set(cands);
  const lo = 0x25000 + SB1_PARTY_OFFSET - PARTY_EWRAM_OFFSET; // SaveBlock1 range 0x25000..0x26800
  const hi = 0x26800 + SB1_PARTY_OFFSET - PARTY_EWRAM_OFFSET;
  const noSlots = cands.filter((c) => {
    for (let k = 1; k < PARTY_SIZE; k++) if (set.has(c - k * MON_SIZE)) return false;
    return true;
  });
  return noSlots.filter((c) => !noSlots.some((a) => c - a >= lo && c - a <= hi));
}

/** For each candidate base, returns word indices (into heap32) holding a pointer to it. */
function findPointerRefs(heap32: Uint32Array, bases: number[]): Map<number, number[]> {
  const refs = new Map<number, number[]>(bases.map((b) => [b, []]));
  const set = new Set(bases);
  for (let i = 0; i < heap32.length; i++) {
    const v = heap32[i];
    if (v === 0 || (v & 3) !== 0) continue;
    if (set.has(v)) refs.get(v)!.push(i);
  }
  return refs;
}

export interface Located {
  ewram: number; // heap offset of GBA 0x02000000
  iwram: number | null; // heap offset of GBA 0x03000000
  confidence: 'pointer-confirmed' | 'unique-match';
}

const looksLikeSb1Ptr = (v: number) => v >= 0x02000000 && v + 0x1400 <= 0x02000000 + EWRAM_SIZE && (v & 3) === 0;

function findIwramNear(heap: Uint8Array, heap32: Uint32Array, refIdx: number): number | null {
  for (const d of [1, -1, 2, -2, 3, -3]) {
    const v = heap32[refIdx + d];
    if (v === undefined || (v & 3) !== 0 || v === 0 || v + IWRAM_SIZE > heap.length) continue;
    const ptr = readU32(heap, v + SAVEBLOCK1_PTR_IWRAM_OFFSET);
    if (looksLikeSb1Ptr(ptr)) return v;
  }
  return null;
}

/**
 * Locates live emulated RAM inside `heap`.
 * Stale copies of the same data (old save-state buffers, freed memory) can also contain a valid party, so
 * when several candidates exist we keep the one the emulator core itself points at (`gba->memory.wram`).
 */
export function locateRam(heap: Uint8Array): Located {
  const candidates = dropShadowCandidates(findPartyCandidates(heap));
  if (candidates.length === 0) {
    throw new RamError(
      'not-found',
      "Couldn't find your party in memory yet. Load your save (past the title screen, with at least one Pokémon) and try again."
    );
  }
  const heap32 = new Uint32Array(heap.buffer, heap.byteOffset, heap.length >> 2);
  const refs = findPointerRefs(heap32, candidates);
  const referenced = candidates.filter((b) => refs.get(b)!.length > 0);

  if (referenced.length === 1) {
    const b = referenced[0];
    let iwram: number | null = null;
    for (const idx of refs.get(b)!) {
      iwram = findIwramNear(heap, heap32, idx);
      if (iwram !== null) break;
    }
    return { ewram: b, iwram, confidence: 'pointer-confirmed' };
  }
  if (referenced.length === 0 && candidates.length === 1) {
    return { ewram: candidates[0], iwram: null, confidence: 'unique-match' };
  }
  throw new RamError('ambiguous', 'Found more than one possible party in memory and could not tell which is live.');
}

/* ---------- Reader / writer ---------- */

export interface PartySnapshot {
  count: number;
  mons: (PartyMon | null)[];
  raw: Uint8Array; // 600 bytes copy
}

export interface ProgressRead {
  badges: number | null;
  gameClear: boolean | null;
  via: 'iwram-pointer' | 'ewram-scan' | 'unavailable';
}

export class EmeraldRam {
  private loc: Located;

  private constructor(private getHeap: () => Uint8Array, loc: Located) {
    this.loc = loc;
  }

  /** `getHeap` must return the CURRENT heap view (wasm memory can grow and replace the buffer). */
  static attach(getHeap: () => Uint8Array | undefined): EmeraldRam {
    const heap = getHeap();
    if (!heap || heap.length < EWRAM_SIZE) throw new RamError('no-heap', 'The emulator core does not expose its memory.');
    const loc = locateRam(heap);
    return new EmeraldRam(() => getHeap() ?? heap, loc);
  }

  get info(): Located {
    return this.loc;
  }

  private partyOffset(): number {
    return this.loc.ewram + PARTY_EWRAM_OFFSET;
  }

  /** Throws 'lost' if the cached location no longer holds a valid party (e.g. the core was restarted). */
  private assertStillThere() {
    const h = this.getHeap();
    const p = this.partyOffset();
    if (p + PARTY_BYTES > h.length || !isMonPlausible(h.subarray(p, p + MON_SIZE))) {
      throw new RamError('lost', 'The game state changed (party not found). Close the drawer and reopen it.');
    }
  }

  readParty(): PartySnapshot {
    this.assertStillThere();
    const h = this.getHeap();
    const raw = h.slice(this.partyOffset(), this.partyOffset() + PARTY_BYTES);
    let count = 0;
    while (count < PARTY_SIZE && isMonPlausible(raw.subarray(count * MON_SIZE, (count + 1) * MON_SIZE))) count++;
    const mons = Array.from({ length: PARTY_SIZE }, (_, i) =>
      i < count ? parseMon(raw.subarray(i * MON_SIZE, (i + 1) * MON_SIZE), i) : null
    );
    return { count, mons, raw };
  }

  /** Returns the SaveBlock1 EWRAM offset, or null. */
  private findSaveBlock1(party0: PartyMon | null): { off: number; via: 'iwram-pointer' | 'ewram-scan' } | null {
    const h = this.getHeap();
    if (this.loc.iwram !== null) {
      const ptr = readU32(h, this.loc.iwram + SAVEBLOCK1_PTR_IWRAM_OFFSET);
      if (looksLikeSb1Ptr(ptr)) return { off: ptr - 0x02000000, via: 'iwram-pointer' };
    }
    if (party0) {
      // SaveBlock1 sits near 0x02025A00 (it shifts by up to ~128 bytes). Match its party copy to slot 0.
      for (let off = 0x25000; off < 0x26800; off += 4) {
        const at = this.loc.ewram + off + SB1_PARTY_OFFSET;
        if (readU32(h, at) === party0.personality && readU32(h, at + 4) === party0.otId) return { off, via: 'ewram-scan' };
      }
    }
    return null;
  }

  readProgress(party0: PartyMon | null): ProgressRead {
    const sb1 = this.findSaveBlock1(party0);
    if (!sb1 || sb1.off + SB1_FLAGS_OFFSET + FLAGS_COUNT > EWRAM_SIZE) return { badges: null, gameClear: null, via: 'unavailable' };
    const h = this.getHeap();
    const flags = this.loc.ewram + sb1.off + SB1_FLAGS_OFFSET;
    const flag = (id: number) => (h[flags + (id >> 3)] >> (id & 7)) & 1;
    let badges = 0;
    for (let i = 0; i < 8; i++) badges += flag(FLAG_BADGE01_GET + i);
    return { badges, gameClear: flag(FLAG_SYS_GAME_CLEAR) === 1, via: sb1.via };
  }

  /** Writes one 100-byte mon into slot `slot` and reads it back to prove it landed. */
  writeSlot(slot: number, bytes: Uint8Array, expectPersonality: number): void {
    if (bytes.length !== MON_SIZE || slot < 0 || slot >= PARTY_SIZE) throw new RangeError('bad slot write');
    this.assertStillThere();
    const h = this.getHeap();
    const at = this.partyOffset() + slot * MON_SIZE;
    if (readU32(h, at) !== expectPersonality) {
      throw new RamError('lost', 'That slot changed since you opened the drawer. Nothing was written.');
    }
    h.set(bytes, at);
    const back = this.getHeap().subarray(at, at + MON_SIZE);
    for (let i = 0; i < MON_SIZE; i++) {
      if (back[i] !== bytes[i]) throw new RamError('lost', 'Memory write did not stick.');
    }
  }
}

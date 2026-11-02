import Dexie, { type Table } from 'dexie';

export type ActivityType = 'Running' | 'Cycling' | 'Walking' | 'Gym';

export interface StoredImage {
  hash: string; // SHA-256 hex (primary key)
  blob: Blob; // original screenshot
  thumb: Blob; // small preview for the gallery
  createdAt: number;
}

export interface Workout {
  id?: number;
  timestamp: number;
  distanceKm: number;
  elevationM: number;
  durationSec: number;
  activityType: ActivityType;
  xp: number;
  imageHash: string; // links to images table (the "image URI" key)
}

interface MetaRow {
  key: string;
  value: number;
}

/** The single ROM the user has loaded (kept as a real Blob copy, never a File handle). */
export interface StoredRom {
  id: 'current';
  fileName: string;
  title: string; // internal GBA header title
  gameCode: string; // e.g. BPEE
  size: number;
  hash: string; // SHA-256 of the ROM; saves are keyed by it
  blob: Blob;
  updatedAt: number;
}

export type SaveKind = 'sram' | 'state';

/** Battery save (.sav) or quick save state, tied to one specific ROM by hash. */
export interface SaveRow {
  id: string; // `${kind}:${romHash}`
  romHash: string;
  kind: SaveKind;
  blob: Blob;
  updatedAt: number;
}

/** Ledger of every XP spend (audit trail + lets a failed RAM write be refunded exactly). */
export interface SpendRecord {
  id?: number;
  timestamp: number;
  slot: number;
  nickname: string;
  personality: number;
  xp: number;
  oldLevel: number;
  newLevel: number;
  oldExp: number;
  newExp: number;
}

class PokeStrideDB extends Dexie {
  images!: Table<StoredImage, string>;
  workouts!: Table<Workout, number>;
  meta!: Table<MetaRow, string>;
  roms!: Table<StoredRom, string>;
  saves!: Table<SaveRow, string>;
  spends!: Table<SpendRecord, number>;

  constructor() {
    super('pokestride');
    this.version(1).stores({
      images: 'hash, createdAt',
      workouts: '++id, timestamp, imageHash, activityType',
      meta: 'key',
    });
    // v2 (Part 2): emulator ROM + SRAM/state storage. Existing tables carry over untouched.
    this.version(2).stores({
      roms: 'id',
      saves: 'id, romHash',
    });
    // v3 (Part 3): XP spend ledger.
    this.version(3).stores({
      spends: '++id, timestamp',
    });
  }
}

export const db = new PokeStrideDB();

const XP_KEY = 'xpBank';

export async function getXpBank(): Promise<number> {
  return (await db.meta.get(XP_KEY))?.value ?? 0;
}

export async function hasImage(hash: string): Promise<boolean> {
  return (await db.images.get(hash)) !== undefined;
}

/** Atomically stores image + workout and credits the XP bank. */
export async function saveWorkout(
  workout: Omit<Workout, 'id'>,
  image: Omit<StoredImage, 'createdAt'>
): Promise<void> {
  await db.transaction('rw', db.images, db.workouts, db.meta, async () => {
    if (await db.images.get(image.hash)) throw new Error('DUPLICATE');
    await db.images.add({ ...image, createdAt: Date.now() });
    await db.workouts.add(workout);
    const bank = await getXpBank();
    await db.meta.put({ key: XP_KEY, value: bank + workout.xp });
  });
}

/** Atomically deducts `amount` from the bank (never below 0) and records the spend. Returns the record id. */
export async function spendXp(amount: number, record: Omit<SpendRecord, 'id' | 'timestamp'>): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('INVALID_AMOUNT');
  return db.transaction('rw', db.meta, db.spends, async () => {
    const bank = await getXpBank();
    if (amount > bank) throw new Error('INSUFFICIENT_XP');
    await db.meta.put({ key: XP_KEY, value: bank - amount });
    return db.spends.add({ ...record, timestamp: Date.now() });
  });
}

/** Undoes a spend (used if writing to the game's RAM fails after the bank was charged). */
export async function refundSpend(spendId: number): Promise<void> {
  await db.transaction('rw', db.meta, db.spends, async () => {
    const row = await db.spends.get(spendId);
    if (!row) return;
    await db.meta.put({ key: XP_KEY, value: (await getXpBank()) + row.xp });
    await db.spends.delete(spendId);
  });
}

/* ---------- ROM + save storage (Part 2) ---------- */

export const saveId = (kind: SaveKind, romHash: string) => `${kind}:${romHash}`;

export async function getRom(): Promise<StoredRom | null> {
  return (await db.roms.get('current')) ?? null;
}

export async function saveRom(rom: StoredRom): Promise<void> {
  await db.roms.put(rom);
}

export async function deleteRom(): Promise<void> {
  await db.roms.delete('current');
}

export async function getSave(kind: SaveKind, romHash: string): Promise<SaveRow | undefined> {
  return db.saves.get(saveId(kind, romHash));
}

export async function putSave(kind: SaveKind, romHash: string, blob: Blob): Promise<void> {
  await db.saves.put({ id: saveId(kind, romHash), romHash, kind, blob, updatedAt: Date.now() });
}

/* ---------- Backup / Restore ---------- */

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  return (await fetch(url)).blob();
}

interface BackupFile {
  app: 'pokestride';
  version: 1 | 2 | 3;
  exportedAt: string;
  xpBank: number;
  workouts: Workout[];
  images: { hash: string; createdAt: number; blob: string; thumb: string }[];
  /** v2+: game saves / save states. ROMs are intentionally never included. */
  saves?: { id: string; romHash: string; kind: SaveKind; updatedAt: number; blob: string }[];
  /** v3+: XP spend ledger. */
  spends?: SpendRecord[];
}

export async function exportBackup(): Promise<Blob> {
  const [workouts, images, saves, spends, xpBank] = await Promise.all([
    db.workouts.toArray(),
    db.images.toArray(),
    db.saves.toArray(),
    db.spends.toArray(),
    getXpBank(),
  ]);
  const encodedImages = await Promise.all(
    images.map(async (i) => ({
      hash: i.hash,
      createdAt: i.createdAt,
      blob: await blobToDataUrl(i.blob),
      thumb: await blobToDataUrl(i.thumb),
    }))
  );
  const encodedSaves = await Promise.all(
    saves.map(async (s) => ({
      id: s.id,
      romHash: s.romHash,
      kind: s.kind,
      updatedAt: s.updatedAt,
      blob: await blobToDataUrl(s.blob),
    }))
  );
  const payload: BackupFile = {
    app: 'pokestride',
    version: 3,
    exportedAt: new Date().toISOString(),
    xpBank,
    workouts,
    images: encodedImages,
    saves: encodedSaves,
    spends,
  };
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

/** Replaces workouts/images/XP (and game saves, if the backup has them). The ROM is never touched. */
export async function importBackup(file: File): Promise<{ workouts: number; xpBank: number }> {
  const data = JSON.parse(await file.text()) as BackupFile;
  if (data.app !== 'pokestride' || !Array.isArray(data.workouts) || !Array.isArray(data.images)) {
    throw new Error('Not a PokéStride backup file');
  }
  const images: StoredImage[] = await Promise.all(
    data.images.map(async (i) => ({
      hash: i.hash,
      createdAt: i.createdAt,
      blob: await dataUrlToBlob(i.blob),
      thumb: await dataUrlToBlob(i.thumb),
    }))
  );
  const saves: SaveRow[] | null = Array.isArray(data.saves)
    ? await Promise.all(
        data.saves.map(async (s) => ({
          id: s.id,
          romHash: s.romHash,
          kind: s.kind,
          updatedAt: s.updatedAt,
          blob: await dataUrlToBlob(s.blob),
        }))
      )
    : null;
  await db.transaction('rw', [db.images, db.workouts, db.meta, db.saves, db.spends], async () => {
    await Promise.all([db.images.clear(), db.workouts.clear(), db.meta.clear()]);
    await db.images.bulkAdd(images);
    await db.workouts.bulkAdd(data.workouts);
    await db.meta.put({ key: XP_KEY, value: data.xpBank ?? 0 });
    if (saves) {
      await db.saves.clear();
      await db.saves.bulkAdd(saves);
    }
    if (Array.isArray(data.spends)) {
      await db.spends.clear();
      await db.spends.bulkAdd(data.spends);
    }
  });
  return { workouts: data.workouts.length, xpBank: data.xpBank ?? 0 };
}

export interface RomInfo {
  title: string;
  gameCode: string;
  size: number;
}

export type RomCheck = { ok: true; info: RomInfo } | { ok: false; reason: string };

const MAX_ROM_BYTES = 32 * 1024 * 1024;

/** Checks extension, size and the GBA cartridge header (fixed byte 0x96 at 0xB2). */
export async function validateGbaRom(file: File): Promise<RomCheck> {
  const ext = file.name.toLowerCase().split('.').pop();
  if (ext !== 'gba' && ext !== 'agb') return { ok: false, reason: 'Please choose a .gba ROM file.' };
  if (file.size < 0xc0 || file.size > MAX_ROM_BYTES) {
    return { ok: false, reason: 'That file has the wrong size for a GBA ROM (max 32 MB).' };
  }
  const head = new Uint8Array(await file.slice(0, 0xc0).arrayBuffer());
  if (head[0xb2] !== 0x96) return { ok: false, reason: "That file doesn't have a valid GBA ROM header." };
  const ascii = (from: number, to: number) =>
    Array.from(head.slice(from, to))
      .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : ''))
      .join('')
      .trim();
  return { ok: true, info: { title: ascii(0xa0, 0xac), gameCode: ascii(0xac, 0xb0), size: file.size } };
}

/** Core only recognises .gba reliably, so normalise the stored name. */
export function normaliseRomName(name: string): string {
  const base = name.replace(/\.[^.]+$/, '').replace(/[^\w.\- ]/g, '_') || 'game';
  return `${base}.gba`;
}

/**
 * Gym-badge level caps for Pokémon Emerald, exactly as specified for PokéStride.
 * Levels are the enforced rule. The experience needed to REACH a level depends on each species' growth rate,
 * so the XP value is computed per Pokémon (see spend.ts) rather than stored as one number here.
 */

export type Progress =
  | { kind: 'badges'; count: number } // 0..8
  | { kind: 'elite4' }
  | { kind: 'postgame' };

export const BADGE_CAPS = [15, 15, 19, 24, 29, 31, 33, 42, 46] as const; // index = badges earned (0..8)
export const BADGE_LABELS = [
  'Pre-Gym 1', 'Roxanne', 'Brawly', 'Wattson', 'Flannery', 'Norman', 'Winona', 'Tate & Liza', 'Juan',
] as const;
export const ELITE4_CAP = 58;
export const POSTGAME_CAP = 100;

export function capLevel(p: Progress): number {
  if (p.kind === 'postgame') return POSTGAME_CAP;
  if (p.kind === 'elite4') return ELITE4_CAP;
  return BADGE_CAPS[Math.max(0, Math.min(8, p.count))];
}

export function progressLabel(p: Progress): string {
  if (p.kind === 'postgame') return 'Post-Game';
  if (p.kind === 'elite4') return 'Elite Four / Champion';
  return `${p.count} Badge${p.count === 1 ? '' : 's'} (${BADGE_LABELS[Math.max(0, Math.min(8, p.count))]})`;
}

/** What the game memory says. Elite Four can't be detected, only chosen manually. */
export function autoProgress(badges: number | null, gameClear: boolean | null): Progress {
  if (badges === null) return { kind: 'badges', count: 0 }; // safest default: lowest cap
  if (badges >= 8 && gameClear) return { kind: 'postgame' };
  return { kind: 'badges', count: badges };
}

export type ProgressChoice = 'auto' | `b${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | 'elite4' | 'postgame';

export function resolveProgress(choice: ProgressChoice, auto: Progress): Progress {
  if (choice === 'auto') return auto;
  if (choice === 'elite4') return { kind: 'elite4' };
  if (choice === 'postgame') return { kind: 'postgame' };
  return { kind: 'badges', count: Number(choice.slice(1)) };
}

import {
  applyUpdate, computeStats, expForLevel, levelForExp,
  type BaseStats, type PartyMon, type StatBlock,
} from './gen3';

export interface SpendPlan {
  xp: number; // XP actually charged to the bank
  newExp: number;
  newLevel: number;
  levelsGained: number;
  stats: StatBlock;
  capExp: number;
}

/** Experience a mon needs to sit exactly at the cap level (its own growth rate). */
export const capExp = (base: BaseStats, cap: number) => expForLevel(base.growthRate, cap);

/** Largest XP that can be put into this mon: limited by the bank AND by the level cap. */
export function maxAllocatable(mon: PartyMon, base: BaseStats, cap: number, bank: number): number {
  return Math.max(0, Math.min(Math.floor(bank), capExp(base, cap) - mon.exp));
}

export function planSpend(mon: PartyMon, base: BaseStats, cap: number, bank: number, requested: number): SpendPlan {
  const xp = Math.max(0, Math.min(Math.floor(requested), maxAllocatable(mon, base, cap, bank)));
  const newExp = mon.exp + xp;
  const newLevel = Math.max(mon.level, levelForExp(base.growthRate, newExp));
  return {
    xp,
    newExp,
    newLevel,
    levelsGained: newLevel - mon.level,
    stats: computeStats(base, mon.ivs, mon.evs, newLevel, mon.personality),
    capExp: capExp(base, cap),
  };
}

/** Builds the new 100-byte mon for a plan. */
export function buildUpdatedMon(rawMon: Uint8Array, plan: SpendPlan): Uint8Array {
  return applyUpdate(rawMon, { exp: plan.newExp, level: plan.newLevel, stats: plan.stats });
}

import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getXpBank, refundSpend, spendXp } from '../db';

const rec = { slot: 0, nickname: 'BULBA', personality: 1, xp: 0, oldLevel: 13, newLevel: 19, oldExp: 1500, newExp: 4575 };

describe('XP bank spend ledger', () => {
  beforeEach(async () => {
    await db.meta.clear();
    await db.spends.clear();
    await db.meta.put({ key: 'xpBank', value: 5000 });
  });

  it('deducts exactly the amount and records it', async () => {
    const id = await spendXp(3075, { ...rec, xp: 3075 });
    expect(await getXpBank()).toBe(1925);
    expect((await db.spends.get(id))!.xp).toBe(3075);
  });

  it('refuses to overspend or spend nonsense, leaving the bank untouched', async () => {
    await expect(spendXp(5001, rec)).rejects.toThrow('INSUFFICIENT_XP');
    await expect(spendXp(0, rec)).rejects.toThrow('INVALID_AMOUNT');
    await expect(spendXp(-5, rec)).rejects.toThrow('INVALID_AMOUNT');
    await expect(spendXp(1.5, rec)).rejects.toThrow('INVALID_AMOUNT');
    expect(await getXpBank()).toBe(5000);
    expect(await db.spends.count()).toBe(0);
  });

  it('refund restores the bank exactly and removes the ledger row (RAM write failed)', async () => {
    const id = await spendXp(1200, { ...rec, xp: 1200 });
    expect(await getXpBank()).toBe(3800);
    await refundSpend(id);
    expect(await getXpBank()).toBe(5000);
    expect(await db.spends.count()).toBe(0);
    await refundSpend(id); // idempotent: a second refund must not mint XP
    expect(await getXpBank()).toBe(5000);
  });

  it('two racing spends can never overdraw the bank', async () => {
    const results = await Promise.allSettled([spendXp(3000, { ...rec, xp: 3000 }), spendXp(3000, { ...rec, xp: 3000 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await getXpBank()).toBe(2000);
  });
});

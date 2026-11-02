const { chromium } = require('playwright');
// Usage: npm run build && npm run make-test-rom && (npx vite preview --port 4173 &) && node tools/e2e-spend-xp.cjs [outDir]
// Needs `playwright` + Chromium, and the mGBA core self-hosted in public/cores (npm run fetch-core).
const S = process.argv[2] || 'test-fixtures';
const ROM = 'test-fixtures/emerald-synthetic.gba';
const log = (...a) => console.log(...a);
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('console.error:', m.text().slice(0, 200)); });

  await page.goto('http://127.0.0.1:4173/');
  await page.evaluate(() => window.pokestrideDb.meta.put({ key: 'xpBank', value: 5000 }));
  await page.getByRole('button', { name: /Play Game/ }).click();
  await page.locator('input[accept*=".gba"]').first().setInputFiles(ROM);
  await page.waitForFunction(() => window.pokestrideEmu && window.pokestrideEmu.status === 'running', null, { timeout: 60000 });
  log('emulator running');
  await page.waitForTimeout(1500); // let the ROM copy its fixtures into RAM

  // helper run in page: find live party copies in the heap and their CPU-side mirror
  const probe = () => page.evaluate(() => {
    const h = window.pokestrideEmu.getHeap();
    const pat = [0x34, 0x12, 0, 0, 0x44, 0x33, 0x22, 0x11];
    const res = [];
    for (let q = 0x244ec; q < h.length - 0x100; q += 4) {
      if (h[q] === 0x34 && h[q + 1] === 0x12 && h[q + 4] === 0x44 && h[q + 5] === 0x33 && h[q + 7] === 0x11) {
        const base = q - 0x244ec;
        res.push({ q, level: h[q + 0x54], mirror: h[base + 0x30000] });
      }
    }
    return { heapMB: h.length / 1048576, res };
  });

  let p = await probe();
  log('heap MB', p.heapMB, 'copies', JSON.stringify(p.res));
  ok(p.res.some((r) => r.level === 13 && r.mirror === 13), 'ROM booted, party in EWRAM, CPU mirror == 13 (ROM image copies in the heap also match the pattern)');

  // Create a stale serialized copy of RAM in the heap (Part 2 "Save State" button)
  await page.getByRole('button', { name: /Save State/ }).click();
  await page.waitForTimeout(800);
  p = await probe();
  log('after Save State, copies:', p.res.length);

  // ---- open the drawer ----
  await page.getByRole('button', { name: /Spend Banked XP/ }).first().click();
  await page.getByText('BULBA').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  ok(await page.getByText('IVY').first().isVisible(), 'party cards show BULBA and IVY from RAM');
  ok(await page.getByText('Lv 19').first().isVisible(), 'cap chip shows Lv 19 for 2 badges (read from SaveBlock1 flags)');
  const status = await page.evaluate(() => window.pokestrideEmu.status);
  ok(status === 'paused', 'emulator is paused while the drawer is open (status=' + status + ')');
  await page.screenshot({ path: `${S}/drawer.png` });

  // ---- allocate max to slot 0 and confirm ----
  await page.getByRole('button', { name: 'Max', exact: true }).click();
  const bankBefore = await page.evaluate(() => window.pokestrideDb.meta.get('xpBank').then((r) => r.value));
  await page.screenshot({ path: `${S}/drawer-max.png` });
  await page.getByRole('button', { name: /Confirm Allocation/ }).click();
  await page.waitForFunction(() => window.pokestrideEmu.status === 'running', null, { timeout: 15000 });
  await page.waitForTimeout(800);

  const bankAfter = await page.evaluate(() => window.pokestrideDb.meta.get('xpBank').then((r) => r.value));
  log('bank', bankBefore, '->', bankAfter);
  ok(bankBefore === 5000 && bankAfter === 5000 - 3075, 'bank deducted by exactly 3,075 (cap Lv19 exp 4575 - 1500)');
  const spends = await page.evaluate(() => window.pokestrideDb.spends.toArray());
  ok(spends.length === 1 && spends[0].xp === 3075 && spends[0].newLevel === 19, 'spend ledger row written');

  p = await probe();
  log('copies after spend', JSON.stringify(p.res));
  const live = p.res.find((r) => r.mirror === 19);
  ok(!!live && live.level === 19, 'RUNNING CPU sees level 19 (mirror byte updated) -> wrote to live EWRAM, not a stale copy');
  ok(p.res.filter((r) => r.level === 19).length === 1, 'exactly one copy changed (live EWRAM); ROM image + stale state buffers untouched');

  await page.waitForTimeout(3500);
  const sram = await page.evaluate(() => window.pokestrideDb.saves.toArray().then((a) => a.map((x) => x.id + ':' + x.blob.size)));
  log('saves rows', sram);
  ok(sram.some((x) => x.startsWith('sram:')), 'forced .sav backup landed in IndexedDB after the spend');

  // ---- reopen: slot 0 must now be at the cap, slot 1 still spendable ----
  await page.getByRole('button', { name: /Spend Banked XP/ }).first().click(); // quickly, while the old close is still syncing
  await page.getByText('At cap').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(4500); // outlast the previous close's 3s SRAM wait: view must NOT blank (race fix)
  ok(await page.getByText('At cap').first().isVisible() && await page.getByText('IVY').first().isVisible(), 'reopened drawer shows BULBA at cap + IVY and stays rendered');
  await page.screenshot({ path: `${S}/drawer-after.png` });
  // select IVY (slot 1) and spend a small amount
  await page.getByText('IVY').first().click();
  await page.getByRole('button', { name: '+100', exact: true }).click();
  await page.getByRole('button', { name: /Confirm Allocation/ }).click();
  await page.waitForFunction(() => window.pokestrideEmu.status === 'running', null, { timeout: 15000 });
  const bank2 = await page.evaluate(() => window.pokestrideDb.meta.get('xpBank').then((r) => r.value));
  ok(bank2 === 5000 - 3075 - 100, 'second spend on slot 1 charged 100 (bank ' + bank2 + ')');

  // ---- safety: drawer with emulator stopped shows the friendly prompt ----
  await page.evaluate(() => window.pokestrideEmu.reset());
  await page.getByRole('button', { name: /Spend Banked XP/ }).first().click();
  await page.getByText(/Launch your Pokémon Emerald ROM/).waitFor({ timeout: 5000 });
  ok(true, 'friendly prompt when the emulator is not running');
  await page.screenshot({ path: `${S}/drawer-notrunning.png` });

  await browser.close();
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });

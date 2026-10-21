// UI walkthrough on an EMPTY fresh-factory database, driven only through the admin and operator screens
// (setup incl. "scan required", workers, order, release + labels, dispatch, scan-locked Start work, Confirm tank (wrong / right),
// location scan, station scan, assign inspector, Scan & inspect, inspection, delete unused worker, passport scan history).
// Env: OUT (screenshot folder), ADMIN_LOGIN, ADMIN_PASSWORD, ADMIN_APP (default http://localhost:5174), OPERATOR_APP (default
// http://localhost:5173), CHROMIUM_PATH (optional). Run on a NEW disposable database right after `npm run factory:init`.
const { chromium } = require('playwright');
const OUT = process.env.OUT; let shot = 0; let SERIAL = null;
const A = process.env.ADMIN_APP || 'http://localhost:5174', O = process.env.OPERATOR_APP || 'http://localhost:5173';
(async () => {
  const b = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
  const errors = [];
  const mk = async (tag) => { const c = await b.newContext({ viewport: { width: 1360, height: 900 } }); const p = await c.newPage(); p.setDefaultTimeout(10000); p.on("pageerror", e => errors.push(`${tag}: ${e.message}`)); p.on('dialog', d => d.accept()); p.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400 && !r.url().endsWith('/auth/me')) errors.push(`${tag} HTTP ${r.status()} ${r.request().method()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`); }); return p; };
  const snap = async (p, name) => p.screenshot({ path: `${OUT}/w${String(++shot).padStart(2, '0')}-${name}.png`, fullPage: true });
  const fld = (scope, label) => scope.locator(".field", { has: (scope.page ? scope.page() : scope).locator(`label:text-is("${label}")`) }).locator("input, select").first();
  const step = async (name, fn) => { try { await fn(); console.log('OK  ', name); } catch (e) { console.log('FAIL', name, e.message.split('\n')[0]); errors.push(`${name}: ${e.message.split('\n')[0]}`); } };
  const toast = async p => { await p.waitForTimeout(900); return (await p.locator('.toast').allInnerTexts()).join(' | '); };
  const a = await mk('admin');
  await step('admin login', async () => { await a.goto(A); await a.fill('#lid', process.env.ADMIN_LOGIN); await a.fill('#pin', process.env.ADMIN_PASSWORD); await a.click('button[type=submit]'); await a.waitForSelector('text=First-run setup'); await snap(a, 'overview-empty'); });
  await step('1 factory', async () => { await a.goto(A + '/setup?tab=factory'); await a.waitForSelector('text=Factory, site and timezone');
    await fld(a, 'Factory name *').fill('UI Walk Plant'); await fld(a, 'Site ID *').fill('UIW-01'); await fld(a, 'Plant timezone *').fill('America/Bogota'); await fld(a, 'Tank serial prefix').fill('UW'); await a.locator('label.check', { hasText: 'before people start work' }).locator('input').check(); await a.locator('label.check', { hasText: 'before an inspection starts' }).locator('input').check();
    await a.click('button:has-text("Save factory settings")'); const t = await toast(a); if (!/saved/i.test(t)) throw new Error(t); });
  await step('2 work centres + stations', async () => { await a.goto(A + '/setup?tab=work-centres'); await a.waitForSelector('text=Add a work centre');
    for (const [id, name] of [['FAB', 'Fabrication']]) { await fld(a, 'ID *').fill(id); await fld(a, 'Name *').fill(name); await a.click('button:has-text("Save work centre")'); const t = await toast(a); if (!/saved/.test(t)) throw new Error(t); }
    await a.waitForSelector('text=Add a station'); const st = a.locator('.card.flat', { hasText: 'Add a station' });
    await fld(st, 'ID *').fill('FAB-01'); await fld(st, 'Name *').fill('Bay 1'); await fld(st, 'Work centre *').selectOption('FAB'); await st.locator('button:has-text("Save station")').click(); const t = await toast(a); if (!/saved/.test(t)) throw new Error(t); await snap(a, 'work-centres'); });
  await step('5 skills', async () => { await a.goto(A + '/setup?tab=skills'); await a.waitForSelector('text=Skills and crew requirements');
    for (const [id, name, cat] of [['SK-WELD', 'Welding', 'PRODUCTION'], ['SK-QC', 'Inspection', 'INSPECTION']]) { await fld(a, 'Skill ID *').fill(id); await fld(a, 'Name *').fill(name); await fld(a, 'Category').selectOption(cat); await a.click('button:has-text("Save skill")'); const t = await toast(a); if (!/saved/.test(t)) throw new Error(t); } });
  await step('6 shift', async () => { await a.goto(A + '/setup?tab=shifts'); await a.waitForSelector('text=Shifts and schedules');
    await fld(a, 'Shift code *').fill('D'); await fld(a, 'Name *').fill('All day'); await fld(a, 'Start (plant time)').fill('00:00'); await fld(a, 'End (plant time)').fill('23:59');
    for (const d of ['Sat', 'Sun']) await a.locator('label.check', { hasText: d }).locator('input').check();
    await a.click('button:has-text("Save shift")'); const t = await toast(a); if (!/saved/.test(t)) throw new Error(t); await snap(a, 'shifts'); });
  await step('7 material + stock', async () => { await a.goto(A + '/setup?tab=resources'); await a.waitForSelector('text=Materials, BOM and stock');
    const mc = a.locator('.card.flat', { hasText: 'Unit of measure' }); await fld(mc, 'Material ID *').fill('MAT-KIT'); await fld(mc, 'Name *').fill('Tank kit'); await fld(mc, 'Unit of measure *').fill('KIT');
    await mc.locator('button:has-text("Save material")').click(); let t = await toast(a); if (!/saved/.test(t)) throw new Error(t);
    await a.waitForTimeout(1500); await a.reload(); await a.waitForSelector('text=Receive stock');
    const rc = a.locator('.card.flat', { hasText: 'Receive stock' }); await fld(rc, 'Material').selectOption('MAT-KIT'); await fld(rc, 'Quantity *').fill('3'); await rc.locator('button:has-text("Record receipt")').click(); t = await toast(a); if (!/Received/.test(t)) throw new Error(t); await snap(a, 'resources'); });
  await step('3 product (draft)', async () => { await a.goto(A + '/setup?tab=products'); await a.click('button:has-text("New product")'); const m = a.locator('.sheet');
    await fld(m, 'Product ID *').fill('TANK-UI'); await fld(m, 'Name / model *').fill('UI tank'); await fld(m, 'Drawing / reference *').fill('DWG-UI');
    const row = i => m.locator('tbody tr').nth(i);
    await row(0).locator('[aria-label="Operation ID"]').fill('OP10'); await row(0).locator('[aria-label="Name"]').fill('Weld'); await row(0).locator('[aria-label="Work centre"]').selectOption('FAB'); await row(0).locator('[aria-label="Skill"]').selectOption('SK-WELD');
    await row(0).locator('[aria-label="Labour minutes"]').fill('20'); await row(0).locator('[aria-label="Elapsed minutes"]').fill('20'); await row(0).locator('[aria-label="Gate"]').fill('QG10');
    await m.locator('button:has-text("Add operation")').click();
    await row(1).locator('[aria-label="Operation ID"]').fill('QG10'); await row(1).locator('[aria-label="Name"]').fill('Gate'); await row(1).locator('[aria-label="Kind"]').selectOption('INSPECTION'); await row(1).locator('[aria-label="Work centre"]').selectOption('FAB'); await row(1).locator('[aria-label="Skill"]').selectOption('SK-QC'); await row(1).locator('[aria-label="Elapsed minutes"]').fill('5');
    await m.locator('[aria-label="Material"]').selectOption('MAT-KIT'); await m.locator('[aria-label="Consumed at operation"]').fill('OP10');
    await snap(a, 'product-form');
    await m.locator('button:has-text("Save")').last().click(); const t = await toast(a); if (!/DRAFT|RELEASED/.test(t)) throw new Error(t); });
  await step('4 checklist + release product', async () => { await a.goto(A + '/setup?tab=checklists'); await a.click('button:has-text("Create QG10")'); const m = a.locator('.sheet');
    await fld(m, 'Question text *').fill('Weld seams sound?'); await m.locator('button:has-text("Save version")').click(); let t = await toast(a); if (!/saved/.test(t)) throw new Error(t);
    await a.goto(A + '/setup?tab=products'); await a.click('button:has-text("Release")'); t = await toast(a); if (!/released/.test(t)) throw new Error(t); await snap(a, 'products'); });
  await step('8 workers', async () => {
    for (const [first, role, skill, login, pin] of [['Olga', 'PRODUCTION_OPERATOR', 'SK-WELD', 'olga', '314159'], ['Ivan', 'QUALITY_INSPECTOR', 'SK-QC', 'ivan', '271828']]) {
      await a.goto(A + '/admin?tab=workers'); await a.click('button:has-text("New worker")'); const m = a.locator('.sheet'); await m.waitFor();
      await fld(m, 'First name *').fill(first); await fld(m, 'Last name *').fill('Walk'); await fld(m, 'Role *').selectOption(role); await fld(m, 'Login ID (default = worker ID)').fill(login); await fld(m, 'Initial PIN * (6-8 digits)').fill(pin);
      await m.locator('label.check', { hasText: 'Require a PIN change' }).locator('input').uncheck();
      await m.locator('select').filter({ has: a.locator(`option[value="${skill}"]`) }).first().selectOption(skill);
      await m.locator('button:has-text("Create worker and login")').click(); await a.waitForSelector('text=Worker created'); await snap(a, `worker-${login}`); await a.click('button:has-text("Done")');
    } });
  await step('9 order wizard', async () => { await a.goto(A + '/orders'); await a.click('button:has-text("New work order")'); const m = a.locator('.sheet');
    await fld(m, 'Work-order / customer reference').fill('PO-UI-1'); await fld(m, 'Product *').selectOption('TANK-UI'); await fld(m, 'Required GOOD tanks *').fill('1'); await m.locator('.field', { hasText: 'Production batches' }).locator('input').fill('1');
    await m.locator('button:has-text("Create order")').click(); await a.waitForSelector('text=created'); await snap(a, 'order-created'); await a.click('button:has-text("Done")'); });
  await step('10 release batch -> identities', async () => { await a.goto(A + '/orders'); await a.click('button:has-text("Release batch")'); await a.waitForSelector('text=released'); await snap(a, 'released'); const txt = await a.locator('.sheet').innerText(); if (!/UW-\d\d-\d{5}/.test(txt)) throw new Error('no serial shown: ' + txt.slice(0, 200));
    SERIAL = txt.match(/UW-\d\d-\d{5}/)[0];
    const [pop] = await Promise.all([a.waitForEvent('popup'), a.click('button:has-text("Print tank labels")')]); await pop.waitForLoadState(); const html = await pop.content();
    if (!html.includes('<svg') || !html.includes(SERIAL)) throw new Error('label popup without barcode/serial'); await pop.screenshot({ path: `${OUT}/w${String(++shot).padStart(2, '0')}-tank-label.png` }); await pop.close();
    await a.click('button:has-text("Done")'); });
  await step('12 dispatch assign', async () => { await a.goto(A + '/dispatch'); await a.click('button:has-text("Assign crew")'); const m = a.locator('.sheet'); await m.locator('label.check', { hasText: 'Olga' }).locator('input').check(); await snap(a, 'assign'); await m.locator('button:has-text("Assign")').last().click(); const t = await toast(a); if (!/assigned/i.test(t)) throw new Error(t); });
  const o = await mk('operator');
  await step('13-15 operator: clock in, start, finish', async () => { await o.goto(O); await o.fill('#lid', 'olga'); await o.fill('#pin', '314159'); await o.click('button[type=submit]'); await o.waitForSelector('text=Clock in');
    await o.click('button:has-text("Clock in")'); await o.waitForTimeout(1500);
    await o.waitForSelector('text=Scan the tank first.'); if (!(await o.locator('button:has-text("Start work")').isDisabled())) throw new Error('Start work not locked before the scan');
    await snap(o, 'scan-required');
    await o.click('button:has-text("Confirm tank")'); await o.fill('#scan-code', 'WRONG-99'); await o.press('#scan-code', 'Enter'); await o.waitForSelector('text=No tank with the code');
    await o.fill('#scan-code', SERIAL.toLowerCase()); await o.press('#scan-code', 'Enter'); await o.waitForSelector('text=Tank confirmed'); await snap(o, 'tank-confirmed');
    await o.click('header button:has-text("Scan")'); await o.fill('#scan-code', SERIAL); await o.press('#scan-code', 'Enter'); await o.waitForSelector('text=Record where this tank is');
    await o.fill('#scan-station', 'FAB-01'); await o.press('#scan-station', 'Enter'); await o.waitForSelector('text=Location saved'); await snap(o, 'scan-location'); await o.keyboard.press('Escape');
    await o.click('header button:has-text("Scan")'); await o.fill('#scan-code', 'FAB-01'); await o.press('#scan-code', 'Enter'); await o.waitForSelector('text=Station FAB-01'); await snap(o, 'scan-station'); await o.keyboard.press('Escape');
    await o.waitForTimeout(500); if (await o.locator('button:has-text("Start work")').isDisabled()) throw new Error('Start work still locked after the scan');
    await o.click('button:has-text("Start work")'); await o.waitForTimeout(1500); await snap(o, 'op-working');
    await o.click('button:has-text("Finish work")'); await o.waitForTimeout(1500); await snap(o, 'op-finished'); });
  await step('15b dispatch: assign inspector', async () => { await a.goto(A + '/dispatch'); await a.click('button:has-text("Assign inspector")'); const m = a.locator('.sheet'); await m.locator('select').selectOption({ label: /Ivan/ }).catch(async () => { const opts = await m.locator('select option').allInnerTexts(); const ivan = opts.find(t => /Ivan/.test(t)); if (!ivan) throw new Error('Ivan not offered: ' + opts.join('|')); await m.locator('select').selectOption({ label: ivan }); });
    await snap(a, 'assign-inspector'); await m.locator('button:has-text("Assign inspector")').click(); const t = await toast(a); if (!/Inspector assigned/i.test(t)) throw new Error(t); });
  const i = await mk('inspector');
  await step('16 inspector: inspect + release', async () => { await i.goto(O); await i.fill('#lid', 'ivan'); await i.fill('#pin', '271828'); await i.click('button[type=submit]'); await i.waitForSelector('text=Clock in');
    await i.click('button:has-text("Clock in")'); await i.waitForTimeout(2000); await i.reload(); await i.waitForTimeout(1500); await i.click('button:has-text("Scan & inspect")'); await i.fill('#scan-code', SERIAL); await i.press('#scan-code', 'Enter'); await i.waitForURL(/inspection/); await i.waitForTimeout(1500);
    await i.locator('button:has-text("Yes")').first().click(); await snap(i, 'inspection'); await i.click('button:has-text("Submit inspection")'); await i.waitForTimeout(2000); await snap(i, 'inspection-submitted'); });
  await step('worker delete unused', async () => { await a.goto(A + '/admin?tab=workers'); await a.click('button:has-text("New worker")'); const m = a.locator('.sheet'); await m.waitFor();
      await fld(m, 'First name *').fill('Temp'); await fld(m, 'Last name *').fill('Mistake'); await fld(m, 'Role *').selectOption('PRODUCTION_OPERATOR'); await fld(m, 'Login ID (default = worker ID)').fill('temp.mistake'); await fld(m, 'Initial PIN * (6-8 digits)').fill('192837');
      await m.locator('button:has-text("Create worker and login")').click(); await a.waitForSelector('text=Worker created'); await a.click('button:has-text("Done")');
      const row = a.locator('tr', { hasText: 'Temp Mistake' }); const wid = (await row.locator('.mono').first().innerText()).split(' ')[0];
      await row.locator('button:has-text("Delete unused")').click(); await a.fill('#f-confirmWorkerId', wid); await a.locator('.sheet button:has-text("Save")').click(); const t = await toast(a); if (!/deleted/i.test(t)) throw new Error(t);
      await a.waitForTimeout(800); if (await a.locator('tr', { hasText: 'Temp Mistake' }).count()) throw new Error('row still listed'); });
  await step('passport scan history', async () => { await a.goto(A + '/orders'); await a.waitForTimeout(1500); await a.click(`text=${SERIAL}`).catch(() => null);
    const uid = 'TNK-FACTORY-00001'; await a.goto(A + '/units/' + uid); await a.waitForSelector('text=Label scans'); const txt = await a.locator('.card', { hasText: 'Label scans' }).innerText();
    if (!/Correct tank/.test(txt) || !/Last scanned location: station FAB-01/.test(txt)) throw new Error('scan history incomplete: ' + txt.slice(0, 300)); await snap(a, 'passport-scans'); });
  await step('order state', async () => { await a.goto(A + '/orders'); await a.waitForTimeout(2000); await snap(a, 'orders-after'); });
  console.log('ERRORS', JSON.stringify(errors, null, 1));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });

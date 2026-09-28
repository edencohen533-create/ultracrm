/** Local-only functional regression suite. Run against a seeded production build with mock providers. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.argv[2] ?? 'http://localhost:3109';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('This suite creates QA records and only runs locally.');
const out = process.env.QA_OUTPUT ?? '.qa-local/functional-core';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'he-IL' });
await ctx.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
const page = await ctx.newPage(); page.setDefaultTimeout(20000);
const errors = [], results = [];
page.on('pageerror', e => errors.push(e.message));
const stamp = Date.now(), name = `QA core ${stamp}`, phone = `050${String(stamp).slice(-7)}`;
let contactId, leadId;
const api = async (path, method = 'GET', data) => {
  const response = await page.request.fetch(base + path, { method, data });
  const body = await response.json();
  assert(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(body).slice(0, 180)}`);
  return body.data ?? body;
};
const poll = async (fn) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await page.waitForTimeout(200); } throw new Error('Expected server state not reached'); };
const step = async (title, fn) => {
  const before = errors.length;
  try { await fn(); assert.equal(errors.length, before, errors.slice(before).join('; ')); results.push({ title, pass: true }); }
  catch (e) { results.push({ title, pass: false, error: e.message }); await page.screenshot({ path: `${out}/failure-${results.length}.png` }).catch(() => {}); }
  console.log(JSON.stringify(results.at(-1)));
};
const dialog = () => page.getByRole('dialog');
const card = () => page.goto(`${base}/contacts/${contactId}`);
try {
  await step('Login through the form', async () => {
    await page.goto(base + '/login'); await page.locator('input[type=email]').fill('owner@demo.local');
    await page.locator('input[type=password]').fill('Demo1234!'); await page.locator('button[type=submit]').click();
    await page.waitForURL(u => u.pathname === '/leads');
  });
  await step('End any leftover mock call before independent UI tests', async () => {
    for (let i=0;i<6;i++) {
      const s=await api('/api/dialer/state');
      if (s.session && s.session.status !== 'ended') await api('/api/dialer/session','DELETE');
      if (s.activeCall) await api(`/api/dialer/call/${s.activeCall.id}/hangup`,'POST',{});
      if (s.wrapUpCall) await api(`/api/dialer/call/${s.wrapUpCall.id}/outcome`,'POST',{outcome:'no_answer'});
      if (!s.activeCall && !s.wrapUpCall && (!s.session || s.session.status === 'ended')) return;
      await page.waitForTimeout(1000);
    }
    throw new Error('Mock call cleanup did not finish');
  });
  await step('Create a contact through the UI and verify persisted fields', async () => {
    await page.goto(base + '/contacts'); await page.getByRole('button', { name: '+ איש קשר', exact: true }).click();
    await dialog().getByLabel('שם מלא', { exact: true }).fill(name);
    await dialog().getByLabel('טלפון', { exact: true }).fill(phone);
    await dialog().getByLabel('אימייל', { exact: true }).fill(`qa${stamp}@example.test`);
    const response = page.waitForResponse(r => r.url().endsWith('/api/contacts') && r.request().method() === 'POST');
    await dialog().getByRole('button', { name: 'צור', exact: true }).click();
    const r = await response; assert.equal(r.status(), 201); contactId = (await r.json()).data.id;
    const c = await api(`/api/contacts/${contactId}`); assert.equal(c.fullName, name); assert.equal(c.email, `qa${stamp}@example.test`);
  });
  await step('Edit contact details and custom fields, then reload', async () => {
    await card(); await page.getByRole('button', { name: 'עריכה', exact: true }).click();
    await page.getByLabel('חברה', { exact: true }).fill('QA Company');
    await page.getByRole('button', { name: '+ הוסף שדה', exact: true }).click();
    await page.getByPlaceholder('שם שדה', { exact: true }).last().fill('qa_reference');
    await page.getByPlaceholder('ערך', { exact: true }).last().fill('persisted');
    await page.getByRole('button', { name: 'שמור', exact: true }).first().click();
    await poll(async () => (await api(`/api/contacts/${contactId}`)).customFields?.qa_reference === 'persisted');
    await page.reload(); await page.getByText('persisted', { exact: true }).waitFor();
    assert.equal((await api(`/api/contacts/${contactId}`)).company, 'QA Company');
  });
  await step('Save a note and see it in the activity timeline', async () => {
    await card(); await page.getByPlaceholder('הערה פנימית לכרטיס (לא נשלחת ללקוח)').fill(`QA note ${stamp}`);
    await page.getByRole('button', { name: 'שמור', exact: true }).click();
    await poll(async () => (await api(`/api/contacts/${contactId}`)).noteItems.some(n => n.body === `QA note ${stamp}`));
    await page.reload(); await page.getByText(`QA note ${stamp}`, { exact: true }).first().waitFor();
  });
  await step('Create a task through the card and complete it', async () => {
    await card(); await page.getByRole('button', { name: '+ משימה', exact: true }).click();
    await dialog().getByLabel('כותרת', { exact: true }).fill(`QA task ${stamp}`);
    await dialog().getByRole('button', { name: 'צור', exact: true }).click();
    await dialog().waitFor({ state: 'hidden' });
    const row = page.locator('li').filter({ hasText: `QA task ${stamp}` }).filter({ has: page.getByRole('button', { name: 'בוצע', exact: true }) });
    await row.getByRole('button', { name: 'בוצע', exact: true }).click();
    await poll(async () => !(await api(`/api/contacts/${contactId}`)).tasks.some(t => t.title === `QA task ${stamp}`));
    const tasks = await api(`/api/tasks?contactId=${contactId}&status=done`); assert(tasks.items.some(t => t.title === `QA task ${stamp}`));
  });
  await step('Create an assigned lead from the card', async () => {
    await card(); await page.getByRole('button', { name: '+ ליד', exact: true }).click();
    await dialog().getByLabel('כותרת (אופציונלי)', { exact: true }).fill(name);
    const users = await api('/api/users'); const owner = users.items.find(u => u.email === 'owner@demo.local');
    await dialog().locator('select').selectOption(owner.id);
    const response = page.waitForResponse(r => r.url().endsWith('/api/leads') && r.request().method() === 'POST');
    await dialog().getByRole('button', { name: 'צור ליד', exact: true }).click();
    const r = await response; assert.equal(r.status(), 201); leadId = (await r.json()).data.id;
    assert.equal((await api(`/api/leads/${leadId}`)).ownerUserId, owner.id);
  });
  await step('Deal form survives an empty date and stores the correct end-of-month renewal', async () => {
    assert(leadId); await page.goto(base + '/leads'); await page.getByRole('textbox', { name: 'חיפוש לידים' }).fill(name);
    await page.getByTestId(`lead-row-${leadId}`).locator('select.lead-status').selectOption('converted');
    await page.getByTestId('deal-item-name-0').fill('Monthly service'); await page.getByTestId('deal-item-price-0').fill('150');
    await page.getByLabel('תאריך רכישה', { exact: true }).fill('');
    assert(await page.getByTestId('deal-close-save').isDisabled());
    await page.getByLabel('תאריך רכישה', { exact: true }).fill('2027-01-31');
    await page.getByTestId('deal-item-duration-0').selectOption('1');
    assert((await page.getByTestId('deal-close').innerText()).includes('28.02.2027'));
    const response = page.waitForResponse(r => r.url().endsWith('/api/deals/close') && r.request().method() === 'POST');
    await page.getByTestId('deal-close-save').click(); const r = await response; assert.equal(r.status(), 201);
    const result = (await r.json()).data; assert.equal(result.amount, 150); assert(result.renewalAt.startsWith('2027-02-28'));
    assert.equal((await api(`/api/leads/${leadId}`)).status, 'converted');
  });
  await step('CSV import preserves quoted commas in names and company fields', async () => {
    await page.goto(base + '/contacts'); await page.getByRole('button', { name: 'ייבוא CSV', exact: true }).click();
    const csvName = `QA, CSV ${stamp}`;
    await dialog().locator('textarea').fill(`name,phone,company\n"${csvName}",051${String(stamp).slice(-7)},"One, Two"`);
    const response = page.waitForResponse(r => r.url().endsWith('/api/contacts/import') && r.request().method() === 'POST');
    await dialog().getByRole('button', { name: 'ייבא', exact: true }).click(); const r = await response; assert(r.ok());
    const contacts = await api(`/api/contacts?q=${encodeURIComponent(csvName)}`);
    assert.equal(contacts.items[0].fullName, csvName); assert.equal(contacts.items[0].company, 'One, Two');
  });
  await step('WhatsApp inbox: inbound message, draft persistence, reply and timeline (mock provider)', async () => {
    const inbound = await api('/api/demo/simulate-inbound', 'POST', { contactId, body: `QA inbound ${stamp}` });
    const conversationId = inbound.conversationId;
    await page.goto(`${base}/inbox/${conversationId}`);
    await page.getByText(`QA inbound ${stamp}`, { exact: true }).first().waitFor();
    const composer = page.getByPlaceholder('הקלד הודעה...').filter({ visible: true });
    await composer.fill(`QA reply ${stamp}`);
    await poll(async () => (await api(`/api/conversations/${conversationId}/draft`)).body === `QA reply ${stamp}`);
    await page.reload(); await poll(async () => await composer.inputValue() === `QA reply ${stamp}`);
    const response = page.waitForResponse(r => r.url().endsWith(`/api/conversations/${conversationId}/messages`) && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'שלח', exact: true }).last().click(); assert((await response).ok());
    const messages = await api(`/api/conversations/${conversationId}/messages`);
    assert.equal(messages.messages.filter(m => m.direction === 'OUTBOUND' && m.body === `QA reply ${stamp}`).length, 1);
    await card(); await page.getByText(`QA reply ${stamp}`, { exact: true }).first().waitFor();
  });
  await step('Marketing suppression and documented re-consent persist', async () => {
    await card(); await page.getByRole('button', { name: 'הסר מדיוור שיווקי', exact: true }).click();
    await dialog().getByLabel('סיבה (אופציונלי)').fill('QA opt out'); await dialog().getByRole('button', { name: 'אישור', exact: true }).click();
    await poll(async () => (await api(`/api/contacts/${contactId}`)).suppression.marketingBlocked);
    await page.getByRole('button', { name: 'חזרה לדיוור (עם תיעוד הסכמה)', exact: true }).click();
    assert(await dialog().getByRole('button', { name: 'אישור', exact: true }).isDisabled());
    await dialog().getByLabel('אסמכתה להסכמה מחודשת (חובה)').fill('QA explicit renewed consent');
    await dialog().getByRole('button', { name: 'אישור', exact: true }).click();
    await poll(async () => !(await api(`/api/contacts/${contactId}`)).suppression.marketingBlocked);
  });
  await step('Missing contact shows an actionable error instead of an endless loader', async () => {
    await page.goto(base + '/contacts/qa-does-not-exist');
    await page.getByRole('alert').filter({ hasText: 'לא נמצא' }).waitFor();
    await page.getByRole('button', { name: 'נסה שוב', exact: true }).waitFor();
    await page.getByRole('link', { name: 'חזרה לאנשי קשר', exact: true }).click(); await page.waitForURL(u => u.pathname === '/contacts');
  });
  await step('Unsubscribe settings preserve a tag entered while another save is pending', async () => {
    const original = await api('/api/automations/unsubscribe-settings');
    await api('/api/automations/unsubscribe-settings', 'PATCH', { removeFromLists: false, tagName: null });
    try {
      await page.goto(base + '/automations'); await page.getByTestId('unsub-remove-lists').check();
      await page.getByTestId('unsub-tag').fill(`QA optout ${stamp}`); await page.getByRole('heading', { name: 'אוטומציות', exact: true }).click();
      await poll(async () => { const s = await api('/api/automations/unsubscribe-settings'); return s.removeFromLists && s.tagName === `QA optout ${stamp}`; });
      await page.reload(); assert.equal(await page.getByTestId('unsub-tag').inputValue(), `QA optout ${stamp}`);
    } finally { await api('/api/automations/unsubscribe-settings', 'PATCH', original); }
  });
  await step('Switching business isolates the created contact', async () => {
    await page.goto(base + '/leads'); const picker = page.getByLabel('בחירת עסק');
    const original = await picker.inputValue(); const other = await picker.locator('option').evaluateAll((xs, current) => xs.find(x => x.value !== current)?.value, original); assert(other);
    const changed=page.waitForResponse(r=>r.url().endsWith('/api/auth/switch')); await picker.selectOption(other); assert((await changed).ok()); await poll(async()=> await picker.inputValue()===other);
    const r = await page.request.get(`${base}/api/contacts/${contactId}`); assert.equal(r.status(), 404);
    const restored=page.waitForResponse(r=>r.url().endsWith('/api/auth/switch')); await picker.selectOption(original); assert((await restored).ok()); assert.equal((await api(`/api/contacts/${contactId}`)).id, contactId);
  });
  await step('CRM at desktop and mobile widths has no horizontal page overflow', async () => {
    for (const width of [1440, 390]) { await page.setViewportSize({ width, height: 900 }); await page.goto(base + '/leads'); await page.locator('main').getByTestId('leads-redesign').waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `overflow at ${width}`);
      await page.screenshot({ path: `${out}/crm-${width}.png` }); }
  });
} finally {
  fs.writeFileSync(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2)); await browser.close();
}
if (results.some(r => !r.pass) || errors.length) process.exitCode = 1;

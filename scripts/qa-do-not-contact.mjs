/** QA (local): the do-not-contact notice on the contact card and in the conversation, desktop + 390px phone (RTL).
 *  Owner blocks a contact through the real route; screenshots go to argv[3]. Local/demo data only. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL" }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', "owner-b@demo.local"); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
let contactId, convId;
await step("D1 create a contact + conversation, block it (manager, real route)", async () => {
  const c = await api("/api/contacts", "POST", { fullName: "בדיקת חסימה", phone: "050" + String(Date.now()).slice(-7), consentStatus: "OPTED_IN", consentEvidence: "QA" });
  if (c.status >= 300) throw new Error(`contact ${c.status} ${JSON.stringify(c.json).slice(0, 200)}`);
  contactId = (c.json.data ?? c.json).id;
  const conv = await page.request.fetch(`${BASE}/api/conversations`, { method: "POST", data: { contactId }, headers: { "Content-Type": "application/json" } });
  const cj = await conv.json(); convId = cj.data?.id ?? cj.id ?? cj.conversation?.id ?? cj.data?.conversation?.id;
  const s = await api(`/api/contacts/${contactId}/suppress`, "POST", { scope: "marketing", reason: "הלקוח ביקש בטלפון" });
  if (s.status !== 200 || !s.json.data.doNotContact) throw new Error(`suppress ${s.status} ${JSON.stringify(s.json).slice(0, 200)}`);
});
for (const [w, h, tag] of [[1280, 900, "desktop"], [390, 844, "mobile"]]) {
  await step(`D2 contact card notice (${tag})`, async () => {
    await page.setViewportSize({ width: w, height: h }); await page.goto(`${BASE}/contacts/${contactId}`);
    const n = page.getByTestId("contact-block-notice").first(); await n.waitFor();
    const txt = await n.innerText(); if (!txt.includes("לא ליצור קשר") || !txt.includes("נחסם ידנית")) throw new Error(txt);
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("horizontal overflow");
    await page.screenshot({ path: `${OUT}/dnc-contact-${tag}.png` });
  });
  if (convId) await step(`D3 conversation notice (${tag})`, async () => {
    await page.goto(`${BASE}/inbox/${convId}`);
    const n = page.getByTestId("contact-block-notice").first(); await n.waitFor();
    if (!(await n.innerText()).includes("לא ליצור קשר")) throw new Error(await n.innerText());
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("horizontal overflow");
    await page.screenshot({ path: `${OUT}/dnc-inbox-${tag}.png` });
  });
}
await step("D4 lifting without documented consent is refused; with it, the notice disappears", async () => {
  const bad = await api(`/api/contacts/${contactId}/suppress`, "DELETE", { evidence: "ok" }); if (bad.status !== 400) throw new Error(`short evidence → ${bad.status}`);
  const good = await api(`/api/contacts/${contactId}/suppress`, "DELETE", { evidence: "הלקוח אישר מחדש בשיחה מוקלטת – QA" }); if (good.status !== 200) throw new Error(`revoke ${good.status}`);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(`${BASE}/contacts/${contactId}`); await page.waitForLoadState("networkidle");
  if (await page.getByTestId("contact-block-notice").count()) throw new Error("notice still shown");
});
await b.close(); console.log(results.join("\n"));

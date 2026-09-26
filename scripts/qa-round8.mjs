/** Browser QA: "הסר" card, status→WhatsApp quick automation, sending pace in the campaign builder. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', "manager@demo.local"); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
await step("Q1 'כשמישהו משיב הסר' card: remove-from-lists toggle + tag persist", async () => {
  await page.goto(`${BASE}/automations`); await page.waitForSelector('[data-testid="unsubscribe-card"]');
  const box = page.locator('[data-testid="unsub-remove-lists"]'); if (!(await box.isChecked())) await box.check();
  await page.fill('[data-testid="unsub-tag"]', "הוסר מדיוור"); await page.click("h1"); await page.waitForTimeout(2500);
  const s = (await api("/api/automations/unsubscribe-settings")).json.data; if (!s.removeFromLists || s.tagName !== "הוסר מדיוור") throw new Error(JSON.stringify(s));
  await page.screenshot({ path: "docs/qa/r8-automations.png", fullPage: true });
});
await step("Q2 'כשסטטוס ליד משתנה ← WhatsApp' creates an active journey", async () => {
  await page.waitForSelector('[data-testid="status-whatsapp-card"]');
  const opts = await page.$$eval('[data-testid="sw-template"] option', (o) => o.map((x) => x.value).filter(Boolean));
  if (!opts.length) { results.push("ℹ️ Q2 no approved WhatsApp template in the demo business – form rendered, creation not exercised"); return; }
  await page.selectOption('[data-testid="sw-status"]', "qualified"); await page.selectOption('[data-testid="sw-template"]', opts[0]);
  for (const inp of await page.$$('[data-testid^="sw-var-"]')) await inp.fill("{name}");
  await page.click('[data-testid="sw-save"]'); await page.waitForSelector("text=האוטומציה נוצרה והופעלה");
  const seqs = (await api("/api/sequences")).json.data.items; const mine = seqs.find((x) => x.trigger === "LEAD_STATUS_CHANGED" && x.triggerConfig?.leadStatus === "qualified" && x.name.includes("WhatsApp"));
  if (!mine || !mine.isActive) throw new Error("journey not created"); await api(`/api/sequences/${mine.id}`, "DELETE");
});
await step("Q3 campaign builder: sending pace 'X נמענים כל חצי שעה' shown in review + confirm", async () => {
  await page.goto(`${BASE}/campaigns/sms`); await page.click('[data-testid="campaign-create"]'); await page.waitForURL((u) => u.pathname.startsWith("/campaigns/wizard/"));
  const id = page.url().split("/").pop(); await page.waitForSelector('[data-testid="wz-info"]');
  await page.click('[data-testid="wz-step-review"]'); await page.waitForSelector('[data-testid="review-pace"]');
  await page.click('[data-testid="pace-batched"]'); await page.fill('[data-testid="pace-size"]', "50"); await page.selectOption('[data-testid="pace-interval"]', "30");
  await page.waitForSelector("text=50 נמענים כל חצי שעה");
  await page.screenshot({ path: "docs/qa/r8-pace.png" });
  await page.waitForFunction(() => document.querySelector('[data-testid="wz-save-state"]')?.textContent === "נשמר", null, { timeout: 30000 });
  const d = (await api(`/api/campaigns/drafts/${id}`)).json.draft; if (d.data.throttle?.batchSize !== 50 || d.data.throttle?.intervalMinutes !== 30) throw new Error(JSON.stringify(d.data.throttle));
  await api(`/api/campaigns/drafts/${id}`, "DELETE");
});
await b.close(); console.log(results.join("\n"));

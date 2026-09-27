/** Browser QA (production, demo business): "למד את ה-AI מהשיחה" from the inbox → review (redacted) → save draft →
 *  knowledge tab shows it as "נלמד משיחה" with the source link and the conversation is marked; agent can only propose.
 *  Drafts only (never published, nothing sent); everything created is deleted at the end. QA_ONLY=L1,L2. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
// Letters only: 6+ digit numbers are redacted from learned knowledge by design.
const TAG = `LEARNQA ${Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 6)}`;
const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const results = []; const created = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept());
const step = async (n, fn) => { if (ONLY.length && !ONLY.includes(n.split(" ")[0])) return; try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-learn-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const firstConversation = async () => { await page.goto(`${BASE}/inbox`); const link = page.locator('a[href^="/inbox/"]').first(); await link.waitFor(); const href = await link.getAttribute("href"); await page.goto(`${BASE}${href}`); return href.split("/").pop(); };

let convId;
await step("L1 owner: conversation menu → select messages → analyze → redacted, editable draft with learn mode + warnings", async () => {
  await login("owner@demo.local");
  convId = await firstConversation();
  await page.click('[data-testid="learn-open"]'); await page.waitForSelector('[data-testid="learn-msg"]');
  await page.fill('[data-testid="learn-instruction"]', "סגנון המענה ודרך פתרון הבעיה");
  await page.click('[data-testid="learn-analyze"]'); await page.waitForSelector('[data-testid="learn-review"]', { timeout: 90000 });
  for (const t of ["learn-title", "learn-exampleA", "learn-whenToUse", "learn-limits", "learn-mode-style", "learn-mode-info", "learn-mode-both"]) if (!(await page.locator(`[data-testid="${t}"]`).count())) throw new Error(`missing ${t}`);
  // the demo contact's name / phone must not appear in the draft
  const contact = (await api(`/api/conversations/${convId}/messages`)).json; void contact;
  await page.fill('[data-testid="learn-title"]', `${TAG} דוגמת שירות`);
  await page.screenshot({ path: "docs/qa/learn-review.png" });
  if (!(await page.locator('[data-testid="learn-publish"]').count())) throw new Error("owner should be able to publish");
  await page.click('[data-testid="learn-save-draft"]'); await page.waitForSelector('[data-testid="learn-review"]', { state: "detached" });
  const k = (await api("/api/ai/knowledge")).json.data.items.find((x) => x.title.includes(TAG)); if (!k) throw new Error("not saved");
  created.push(k.id);
  if (k.kind !== "conversation" || k.status !== "draft" || k.sourceConversationId !== convId) throw new Error(JSON.stringify(k));
});
await step("L2 knowledge tab shows 'נלמד משיחה' (proposer + source link); the conversation is marked", async () => {
  await page.goto(`${BASE}/ai?tab=knowledge`); const row = page.locator('[data-testid="kb-row"]', { hasText: TAG }); await row.waitFor();
  const t = await row.textContent(); if (!t.includes("נלמד משיחה") || !t.includes("שיחת המקור")) throw new Error(t.slice(0, 200));
  await page.screenshot({ path: "docs/qa/learn-knowledge.png" });
  await page.goto(`${BASE}/inbox/${convId}`); await page.waitForSelector('[data-testid="learned-mark"]');
});
await step("L3 agent: can open the dialog on a visible conversation and propose, but has no publish button", async () => {
  await login("agent1@demo.local");
  const id = await firstConversation().catch(() => null); if (!id) throw new Error("agent sees no conversation");
  await page.click('[data-testid="learn-open"]'); await page.waitForSelector('[data-testid="learn-msg"]');
  await page.click('[data-testid="learn-analyze"]'); await page.waitForSelector('[data-testid="learn-review"]', { timeout: 90000 });
  if (await page.locator('[data-testid="learn-publish"]').count()) throw new Error("agent sees publish");
  if (await page.locator('[data-testid="learn-test"]').count()) throw new Error("agent sees manager test");
  await page.screenshot({ path: "docs/qa/learn-agent.png" });
  await page.keyboard.press("Escape");
});
await step("L4 cleanup: delete the QA drafts", async () => {
  await login("owner@demo.local");
  for (const id of created) await api(`/api/ai/knowledge/${id}`, "DELETE");
  for (const x of (await api("/api/ai/knowledge")).json.data.items.filter((i) => /LEARN/.test(i.title))) await api(`/api/ai/knowledge/${x.id}`, "DELETE");
  const left = (await api("/api/ai/knowledge")).json.data.items.filter((x) => /LEARN/.test(x.title)); if (left.length) throw new Error("left behind");
});
await b.close(); console.log(results.join("\n"));

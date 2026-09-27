/** Browser QA (production, demo business): attempt quota settings, campaign access, the dialer's "no leads available"
 *  panel with other campaigns, the manager alert. Uses an EMPTY test campaign – nothing is dialed. QA_ONLY=E1,E3. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const TAG = `QA-EXH ${Date.now().toString().slice(-6)}`;
const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept());
const step = async (n, fn) => { if (ONLY.length && !ONLY.includes(n.split(" ")[0])) return; try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-exh-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };

await login("owner@demo.local");
const users = (await api("/api/users")).json.data.items; const agent1 = users.find((u) => u.email === "agent1@demo.local"); const agent2 = users.find((u) => u.email === "agent2@demo.local");
const empty = (await api("/api/lists", "POST", { name: `${TAG} ריק`, agentIds: [agent1.id], dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } })).json.data;
const closed = (await api("/api/lists", "POST", { name: `${TAG} סגור`, agentIds: [agent2.id] })).json.data;

await step("E1 settings → חייגן: quota field + preview (no change without approval)", async () => {
  await page.goto(`${BASE}/settings?tab=general`); await page.waitForSelector("text=מספר ניסיונות חיוג ללא מענה לפני העברה ללא רלוונטי");
  await page.click('[data-testid="exhaustion-preview-open"]'); await page.waitForSelector('[data-testid="exhaustion-none"], [data-testid="exhaustion-count"]');
  await page.screenshot({ path: "docs/qa/exh-settings.png" }); await page.keyboard.press("Escape");
});
await step("E2 campaign: access 'all / selected' (empty selection blocked) + quota override", async () => {
  await page.goto(`${BASE}/lists/${empty.id}`); await page.click('[data-testid="campaign-access-open"]'); await page.waitForSelector('[data-testid="campaign-access"]');
  if (!(await page.isChecked('[data-testid="campaign-access-selected"]'))) throw new Error("selected mode not shown");
  await page.click(`[data-testid="campaign-agent-${agent1.id}"]`); // deselect → none selected
  if (!(await page.isDisabled('[data-testid="campaign-access-save"]'))) throw new Error("empty selection allowed");
  await page.click(`[data-testid="campaign-agent-${agent1.id}"]`);
  await page.screenshot({ path: "docs/qa/exh-access.png" }); await page.click('[data-testid="campaign-access-save"]');
  await page.click('[data-testid="campaign-limit-open"]'); await page.selectOption('[data-testid="campaign-limit"]', "4"); await page.click('[data-testid="campaign-limit-save"]');
  await page.waitForSelector('[data-testid="campaign-limit-open"]:has-text("4")');
  if ((await api(`/api/lists/${empty.id}`)).json.data.unansweredLimit !== 4) throw new Error("limit not saved");
});
await step("E3 agent: empty campaign → dialer stops with 'אין כרגע לידים זמינים' + other campaigns (permitted only)", async () => {
  await login("agent1@demo.local");
  if ((await api(`/api/lists/${closed.id}`)).status !== 404) throw new Error("agent opened a campaign that is closed to them");
  await page.goto(`${BASE}/dialer?listId=${empty.id}`); await page.waitForSelector('[data-testid="dialer-launcher"]');
  await page.getByRole("button", { name: "Preview", exact: false }).first().click().catch(() => {});
  await page.click('[data-testid="start-dialer"]');
  await page.waitForSelector('[data-testid="no-leads-panel"]', { timeout: 90000 }).catch(async () => { await page.getByRole("button", { name: /חייג|הבא/ }).first().click(); await page.waitForSelector('[data-testid="no-leads-panel"]'); });
  const txt = await page.textContent('[data-testid="no-leads-panel"]');
  if (!txt.includes("אין כרגע לידים זמינים בקמפיין הזה")) throw new Error(txt.slice(0, 200));
  if (txt.includes(`${TAG} סגור`)) throw new Error("closed campaign offered");
  if (!(await page.locator('[data-testid="other-campaigns"], [data-testid="no-other-campaigns"]').count())) throw new Error("no campaigns section");
  const calls = (await api("/api/dialer/state")).json?.data?.activeCall; if (calls) throw new Error("dialed");
  await page.screenshot({ path: "docs/qa/exh-no-leads.png" });
});
await step("E4 manager sees one alert for that agent + campaign (no duplicates after refreshes)", async () => {
  await page.reload(); await page.waitForSelector('[data-testid="no-leads-panel"]').catch(() => {});
  await login("owner@demo.local");
  const items = (await api("/api/dialer/queue-alerts")).json.data.items.filter((a) => a.listId === empty.id && !a.closedAt);
  if (items.length !== 1) throw new Error(`alerts=${items.length}`);
  await page.goto(`${BASE}/lists`); await page.waitForSelector('[data-testid="queue-alerts"]');
  if (!(await page.textContent('[data-testid="queue-alerts"]')).includes(`${TAG} ריק`)) throw new Error("alert not shown");
  await page.screenshot({ path: "docs/qa/exh-manager-alert.png" });
});
await step("E5 cleanup: end agent session, archive test campaigns", async () => {
  await login("agent1@demo.local");
  const st = (await api("/api/dialer/state")).json?.data; const bs = await page.evaluate(() => sessionStorage.getItem("dialer.browserSessionId"));
  if (st?.session?.id) await api("/api/dialer/session", "DELETE", { sessionId: st.session.id, browserSessionId: bs ?? "" });
  await login("owner@demo.local");
  for (const l of [empty, closed]) await api(`/api/lists/${l.id}`, "PATCH", { archived: true });
});
await b.close(); console.log(results.join("\n"));

/** QA (local, simulated telephony, SANDBOX payments – nothing is charged): no "waiting to be logged" bar; payment
 *  window inside the call screen; double click → one request; the call stays live when the window closes; approval
 *  only from the (sandbox) provider; decline shown as failed; the next call is not blocked by a missing result.
 *  Usage: node scripts/qa-dialer-payments.mjs [base] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner@demo.local";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 }, permissions: ["microphone"] }); const page = await ctx.newPage(); page.setDefaultTimeout(60000);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const stateOf = async () => (await api("/api/dialer/state")).json?.data;
// Poll from node: waitForFunction with an async predicate resolves at once (a Promise is truthy).
const until = async (ok, ms, what) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok(await stateOf())) return; await page.waitForTimeout(800); } throw new Error(`timeout: ${what}`); };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const before = (await api("/api/settings/payments")).json?.data;
const stamp = Date.now(); let leadId, name;

await step("P0 fixtures: sandbox provider, a product, a lead", async () => {
  const c = await api("/api/settings/payments", "POST", { provider: "sandbox", environment: "test" }); if (c.status !== 200) throw new Error(`connect ${c.status}`);
  const o = await api("/api/sales", "POST", { action: "offer", data: { name: `מנוי QA ${stamp}`, unitAmount: 50000, taxBps: 1800 } }); if (o.status >= 300) throw new Error(`offer ${o.status} ${JSON.stringify(o.json).slice(0, 160)}`);
  name = `QA Pay ${stamp}`;
  const k = await api("/api/contacts", "POST", { fullName: name, phone: `050${String(stamp).slice(-6)}7` });
  const users = (await api("/api/users")).json.data.items;
  const l = await api("/api/leads", "POST", { contactId: k.json.data.id, ownerUserId: users.find((u) => u.email === EMAIL).id }); leadId = l.json.data.id;
});

await step("P1 call from the lead list → answered (simulation)", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("חיפוש לידים").fill(name); await page.getByTestId(`lead-row-${leadId}`).waitFor();
  const res = page.waitForResponse((r) => r.url().includes("/api/dialer/call") && r.request().method() === "POST");
  await page.getByTestId(`lead-row-${leadId}`).locator(".lead-call").click();
  if ((await res).status() >= 300) throw new Error("dial refused");
  await until((st) => st?.activeCall?.status === "answered", 45000, "answered");
});

let reqId;
await step("P2 'תשלום' opens a window over the call; double click on create → one request; the provider page is embedded", async () => {
  await page.getByTestId("payment-open").first().click();
  await page.getByTestId("payment-modal").waitFor();
  const opt = await page.getByTestId("payment-item").locator("option", { hasText: `מנוי QA ${stamp}` }).getAttribute("value");
  await page.getByTestId("payment-item").selectOption(opt);
  if (!(await page.getByTestId("payment-amount").innerText()).includes("590")) throw new Error("amount with tax");
  const posts = []; page.on("request", (r) => { if (r.url().endsWith("/api/payments") && r.method() === "POST") posts.push(1); });
  await page.getByTestId("payment-create").dblclick();
  await page.getByTestId("payment-request").waitFor();
  const st = await stateOf(); const reqs = (await api(`/api/payments/options?contactId=${st.activeCall.contactId}&callId=${st.activeCall.id}`)).json.data.requests;
  if (reqs.filter((r) => r.status === "pending").length !== 1) throw new Error(`${reqs.length} requests after a double click (${posts.length} posts)`);
  reqId = reqs[0].id;
  await page.getByTestId("payment-frame").waitFor();
  await page.screenshot({ path: `${OUT}/pay-modal.png` });
});

await step("P3 closing the window keeps the call and the request; nothing is 'paid' by closing", async () => {
  await page.getByTestId("payment-close").click();
  const live = (await stateOf()).activeCall; if (!live || live.endedAt) throw new Error("the call ended");
  const r = (await api(`/api/payments/${reqId}`)).json.data; if (r.status !== "pending") throw new Error(`status ${r.status}`);
});

await step("P4 the customer approves on the provider page (sandbox) → 'שולם' from the provider's confirmation", async () => {
  await page.getByTestId("payment-open").first().click();
  const frame = page.frameLocator('[data-testid="payment-frame"]');
  await frame.getByTestId("sandbox-approve").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="payment-status"]')?.textContent?.includes("שולם"), null, { timeout: 20000 });
  await page.screenshot({ path: `${OUT}/pay-succeeded.png` });
});

await step("P5 a declined payment shows 'נכשל'", async () => {
  await page.getByTestId("payment-new").click();
  const opt = await page.getByTestId("payment-item").locator("option", { hasText: `מנוי QA ${stamp}` }).getAttribute("value");
  await page.getByTestId("payment-item").selectOption(opt);
  await page.getByTestId("payment-create").click();
  await page.frameLocator('[data-testid="payment-frame"]').getByTestId("sandbox-decline").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="payment-status"]')?.textContent?.includes("נכשל"), null, { timeout: 20000 });
  await page.getByTestId("payment-close").click();
});

await step("D1 hang up without choosing a result: no 'waiting to be logged' bar; the next call is not blocked", async () => {
  const st = await stateOf();
  await api(`/api/dialer/call/${st.activeCall.id}/hangup`, "POST", {});
  await until((st) => !st?.activeCall, 30000, "call ended");
  await page.goto(`${BASE}/contacts`); await page.waitForLoadState("networkidle");
  if (await page.getByText("ממתינה לתיעוד").count()) throw new Error("the bar is still shown");
  const s2 = await api("/api/dialer/session", "POST", { mode: "manual", browserSessionId: `qa-${stamp}` });
  if (s2.status >= 300) throw new Error(`session refused ${s2.status} ${JSON.stringify(s2.json).slice(0, 160)}`);
  const last = (await api(`/api/payments/options?contactId=${st.activeCall.contactId}`)).json; // still reachable
  if (!last) throw new Error("options");
  const sid = s2.json.data.id ?? s2.json.data.session?.id; if (sid) await api("/api/dialer/session", "DELETE", { sessionId: sid, browserSessionId: `qa-${stamp}` });
});

await step("Z restore the payment provider setting", async () => {
  if (!before?.connected) await api("/api/settings/payments", "DELETE");
});
await b.close(); console.log(results.join("\n"));

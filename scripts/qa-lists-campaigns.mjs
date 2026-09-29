/** QA (local / demo data only): lists administration + broadcast builder exits + sending pace.
 *  Usage: node scripts/qa-lists-campaigns.mjs [base] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner-b@demo.local";
const stamp = String(Date.now()).slice(-6);
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000);
page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
let A, B;

await step("L1 lists: active toggle on the card", async () => {
  for (let i = 0; i < 3; i++) await api("/api/contacts", "POST", { fullName: `QA list ${stamp}-${i}`, phone: `052${stamp}${i}`, source: `qa-${stamp}`, consentStatus: "UNKNOWN" });
  A = (await api("/api/lists", "POST", { name: `QA-A ${stamp}`, filter: { source: `qa-${stamp}` } })).json.data;
  B = (await api("/api/lists", "POST", { name: `QA-B ${stamp}` })).json.data;
  A = A.list ?? A; B = B.list ?? B;
  await page.goto(`${BASE}/lists`);
  const card = page.getByTestId(`list-card-${A.id}`); await card.waitFor();
  await card.getByTestId("list-active-toggle").click();
  await card.getByText("לא פעילה").first().waitFor();
  await card.getByTestId("list-active-toggle").click();
  await page.waitForTimeout(800);
});

await step("L2 move all leads A → B (A empty, B has them)", async () => {
  const card = page.getByTestId(`list-card-${A.id}`);
  await card.getByTestId("list-move-all").click();
  await page.getByTestId("move-target").selectOption(B.id);
  await page.getByTestId("move-confirm").click();
  await page.getByText(/הועברו \d+ לידים/).first().waitFor();
  const a = (await api(`/api/lists/${A.id}`)).json.data, bb = (await api(`/api/lists/${B.id}`)).json.data;
  if (a.stats.total !== 0 || bb.stats.total < 3) throw new Error(`A=${a.stats.total} B=${bb.stats.total}`);
});

await step("L3 delete list B: the dialog shows the number of leads and needs the name", async () => {
  await page.reload();
  const card = page.getByTestId(`list-card-${B.id}`); await card.getByTestId("list-delete").click();
  const info = await page.getByTestId("list-delete-info").innerText();
  if (!/\d+ לידים משויכים/.test(info)) throw new Error(info);
  if (await page.getByTestId("list-delete-confirm").isEnabled()) throw new Error("enabled without the name");
  await page.screenshot({ path: `${OUT}/lists-delete.png` });
  await page.getByTestId("list-delete-name").fill(`QA-B ${stamp}`);
  await page.getByTestId("list-delete-confirm").click();
  await page.getByText("הרשימה נמחקה").first().waitFor();
  if ((await api(`/api/lists/${B.id}`)).status !== 404) throw new Error("still exists");
  const c = (await api(`/api/contacts?q=QA list ${stamp}`)).json; if (!JSON.stringify(c).includes(`QA list ${stamp}`)) throw new Error("contacts gone");
  await api(`/api/lists/${A.id}`, "DELETE", { confirmName: `QA-A ${stamp}` });
});

await step("C1 broadcasts: channel create button; no audiences / templates shortcuts", async () => {
  for (const [ch, label] of [["whatsapp", "יצירת קמפיין וואטסאפ"], ["sms", "יצירת קמפיין SMS"], ["email", "יצירת קמפיין אימייל"]]) {
    await page.goto(`${BASE}/campaigns/${ch}`);
    const btn = page.getByTestId("campaign-create"); await btn.waitFor();
    if ((await btn.innerText()).trim() !== label) throw new Error(`${ch}: ${await btn.innerText()}`);
    if (await page.locator('[data-testid="campaigns-audiences"], [data-testid="campaigns-templates"]').count()) throw new Error("shortcut links shown");
  }
});

const draftsOf = async (ch) => (await (await page.request.fetch(`${BASE}/api/campaigns/drafts?channel=${ch}`)).json()).drafts ?? [];
await step("C2 new campaign, edit, 'יציאה' → dialog → 'צא בלי לשמור' deletes the auto-created draft", async () => {
  await page.goto(`${BASE}/campaigns/sms`); const before = (await draftsOf("sms")).length;
  await page.getByTestId("campaign-create").click(); await page.waitForURL(/wizard\/.+\?new=1/);
  const id = page.url().split("/wizard/")[1].split("?")[0];
  if (!/wizard/.test(page.url())) throw new Error("no wizard");
  await page.getByTestId("wz-name").fill(`QA exit ${stamp}`); await page.waitForTimeout(1200);
  await page.getByTestId("wz-leave").click();
  await page.getByTestId("wz-leave-dialog").waitFor();
  await page.screenshot({ path: `${OUT}/wizard-leave.png` });
  await page.getByTestId("wz-discard").click(); await page.waitForURL(/\/campaigns\/sms$/);
  if ((await draftsOf("sms")).some((d) => d.id === id)) throw new Error("draft kept");
  if ((await draftsOf("sms")).length !== before) throw new Error("draft count changed");
});

await step("C3 'המשך עריכה' keeps you in the builder; logo → dialog; untouched new draft + logo → home, no draft left", async () => {
  await page.getByTestId("campaign-create").click(); await page.waitForURL(/wizard\/.+\?new=1/);
  await page.getByTestId("wz-name").fill(`QA keep ${stamp}`); await page.waitForTimeout(1000);
  await page.getByTestId("wz-home").click(); await page.getByTestId("wz-leave-dialog").waitFor();
  await page.getByTestId("wz-keep-editing").click();
  if (!/wizard/.test(page.url()) || await page.getByTestId("wz-leave-dialog").count()) throw new Error("left the builder");
  await page.getByTestId("wz-leave").click(); await page.getByTestId("wz-discard").click(); await page.waitForURL(/\/campaigns\/sms$/);
  await page.getByTestId("campaign-create").click(); await page.waitForURL(/wizard\/.+\?new=1/);
  const id = page.url().split("/wizard/")[1].split("?")[0];
  await page.getByTestId("wz-home").click(); await page.waitForURL((u) => !u.pathname.includes("/campaigns/"));
  if ((await draftsOf("sms")).some((d) => d.id === id)) throw new Error("untouched draft kept");
});

await step("C4 existing draft: edit then 'צא בלי לשמור' restores the saved name", async () => {
  const { draft } = await (await page.request.fetch(`${BASE}/api/campaigns/drafts`, { method: "POST", data: { channel: "sms", name: `QA saved ${stamp}` }, headers: { "Content-Type": "application/json" } })).json();
  await page.goto(`${BASE}/campaigns/wizard/${draft.id}`); await page.getByTestId("wz-name").waitFor();
  await page.getByTestId("wz-name").fill(`QA changed ${stamp}`); await page.waitForTimeout(1500);
  await page.getByTestId("wz-leave").click(); await page.getByTestId("wz-discard").click(); await page.waitForURL(/\/campaigns\/sms$/);
  const d = (await draftsOf("sms")).find((x) => x.id === draft.id);
  if (d?.name !== `QA saved ${stamp}`) throw new Error(`name ${d?.name}`);
  await page.request.fetch(`${BASE}/api/campaigns/drafts/${draft.id}`, { method: "DELETE" });
});

await step("P1 pace: X recipients every Y minutes/hours with validation", async () => {
  const { draft } = await (await page.request.fetch(`${BASE}/api/campaigns/drafts`, { method: "POST", data: { channel: "whatsapp", name: `QA pace ${stamp}` }, headers: { "Content-Type": "application/json" } })).json();
  await page.goto(`${BASE}/campaigns/wizard/${draft.id}`); await page.getByTestId("wz-step-review").click();
  await page.getByTestId("pace-batched").check();
  await page.getByTestId("pace-size").fill("0");
  if (!(await page.getByTestId("pace-error").innerText()).includes("בין 1")) throw new Error("no batch error");
  await page.getByTestId("pace-size").fill("200"); await page.getByTestId("pace-unit").selectOption("minutes"); await page.getByTestId("pace-every").fill("2");
  if (!(await page.getByTestId("pace-error").innerText()).includes("5 דקות")) throw new Error("no interval error");
  await page.getByTestId("pace-every").fill("30");
  if (await page.getByTestId("pace-error").count()) throw new Error("error remains");
  await page.waitForTimeout(1200);
  const saved = (await (await page.request.fetch(`${BASE}/api/campaigns/drafts/${draft.id}`)).json()).draft.data.throttle;
  if (saved?.batchSize !== 200 || saved?.intervalMinutes !== 30) throw new Error(JSON.stringify(saved));
  await page.screenshot({ path: `${OUT}/wizard-pace.png` });
  await page.request.fetch(`${BASE}/api/campaigns/drafts/${draft.id}`, { method: "DELETE" });
});
await b.close(); console.log(results.join("\n"));

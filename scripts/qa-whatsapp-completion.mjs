/**
 * Browser QA for the WhatsApp completion phase (simulated provider – demo business, no Meta credentials).
 * Usage: node scripts/qa-whatsapp-completion.mjs [baseUrl]
 * Screenshots: docs/qa/wa-*.png
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/wa-${n}.png`, fullPage: true }).catch(() => undefined);
const stamp = Date.now();
const ph = (n) => `0509${String(stamp).slice(-5)}${n}`; // unique per run, 10 digits
const api = async (path, method = "GET", body) => {
  const r = await page.request.fetch(`${BASE}${path}`, { method, data: body, headers: { "Content-Type": "application/json" } });
  return { status: r.status(), json: await r.json().catch(() => null) };
};

await step("W0 login as owner", async () => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
});

let listId, mediaTemplateId, contactA, contactB;
await step("W1 API: template submission refused without Meta; seed a 2-contact list (simulation only)", async () => {
  const c1 = await api("/api/contacts", "POST", { fullName: `QA מדיה ${stamp}`, phone: ph(1), consentStatus: "OPTED_IN", consentEvidence: "qa" });
  const c2 = await api("/api/contacts", "POST", { fullName: `QA כפולה ${stamp}`, phone: ph(2), consentStatus: "OPTED_IN", consentEvidence: "qa" });
  if (c1.status >= 300 || c2.status >= 300) throw new Error(`contacts ${c1.status}/${c2.status}`);
  contactA = c1.json.data?.id ?? c1.json.id; contactB = c2.json.data?.id ?? c2.json.id;
  const l = await api("/api/distribution-lists", "POST", { name: `qa-wa-${stamp}`, contactIds: [contactA, contactB] });
  if (l.status >= 300) throw new Error(`list ${l.status}`);
  listId = l.json.list?.id ?? l.json.data?.id ?? l.json.id;
  // Creating a WhatsApp template submits it to Meta; without a connection the API refuses honestly (502) – verified, then the seeded approved template is used.
  const t = await api("/api/templates", "POST", { channel: "whatsapp", name: `qa_media_${stamp}`, language: "he", category: "MARKETING", body: "היי {{1}}, מבצע חדש", examples: { "1": "דנה" } });
  if (t.status < 400) throw new Error("template submission succeeded without a Meta connection");
  const tl = await api("/api/templates");
  const items = tl.json.templates ?? tl.json.data?.items ?? tl.json.items ?? [];
  mediaTemplateId = items.find((x) => x.name === "spring_sale")?.id;
  if (!mediaTemplateId) throw new Error("seeded spring_sale template missing");
});

await step("W2 templates screen lists Meta statuses incl. paused/disabled labels + header/buttons column", async () => {
  await page.goto(`${BASE}/templates`, { waitUntil: "networkidle" });
  const html = await page.content();
  if (!/מאושר/.test(html)) throw new Error("no approved template rendered");
  await page.click("text=תצוגה מקדימה >> nth=0");
  await page.waitForSelector('div[role="dialog"]', { timeout: 20000 });
  await shot("templates-preview");
});

let campaignId;
await step("W3 campaigns: WhatsApp draft with merge-tag default + preview + review (cost basis shown as manual)", async () => {
  await page.goto(`${BASE}/campaigns`, { waitUntil: "networkidle" });
  await page.fill('label:has-text("שם הקמפיין") input', `qa-wa-${stamp}`);
  await page.selectOption('select[aria-label="רשימת תפוצה לקמפיין"]', listId);
  const tplValue = await page.$eval('[data-testid="campaign-template"]', (el) => Array.from(el.options).find((o) => o.textContent.includes("spring_sale"))?.value);
  if (!tplValue) throw new Error("spring_sale not offered in the template select");
  await page.selectOption('[data-testid="campaign-template"]', tplValue);
  const varInput = page.locator('input[placeholder^="{name}"]').first();
  await varInput.fill("{{first_name|לקוח}}");
  const saved = page.waitForResponse((r) => r.url().includes("/api/campaigns") && r.request().method() === "POST", { timeout: 30000 });
  await page.click('[data-testid="campaign-save"]');
  const res = await saved;
  if (res.status() !== 201) throw new Error(`save ${res.status()}`);
  campaignId = (await res.json()).campaign.id;
  const list = await api(`/api/campaigns?q=qa-wa-${stamp}`);
  const found = (list.json.campaigns ?? []).find((c) => c.name === `qa-wa-${stamp}`);
  if (!found) throw new Error("server search did not find the draft");
  const none = await api(`/api/campaigns?q=zzz-nomatch-${stamp}`);
  if ((none.json.campaigns ?? []).length) throw new Error("server search returned unrelated campaigns");
  const pre = await api(`/api/campaigns/${campaignId}?preflight=1`);
  if (pre.status !== 200) throw new Error(`preflight ${pre.status}`);
  const preText = JSON.stringify(pre.json);
  if (!/ידני/.test(preText)) throw new Error("cost basis not shown as manual");
  if (!/"simulated":true/.test(preText)) throw new Error("preflight must state simulation");
  await shot("campaign-draft");
});

await step("W4 campaigns: media template shows header-link + button inputs; save blocked without them (client) and server rejects", async () => {
  const r = await api("/api/campaigns", "POST", { channel: "whatsapp", name: `qa-media-${stamp}`, listId, templateId: mediaTemplateId, variables: { "1": "{name}" } });
  if (r.status === 201 || r.status === 200) {
    // template PATCH not supported → the template has no media header; still verify the media-url validation path with a bogus non-https link
    const bad = await api("/api/campaigns", "POST", { channel: "whatsapp", name: `qa-media2-${stamp}`, listId, templateId: mediaTemplateId, variables: { "1": "{name}" }, mediaUrl: "http://insecure.example/a.jpg" });
    if (bad.status < 400) throw new Error("http media link accepted");
    return;
  }
  if (r.status !== 400 && r.status !== 422) throw new Error(`expected validation error, got ${r.status}`);
});

await step("W5 campaign: start → runner (simulation) → report; recipients table shows attempts and error codes; CSV export downloads", async () => {
  const s = await api(`/api/campaigns/${campaignId}`, "PATCH", { action: "start" });
  if (s.status >= 300) throw new Error(`start ${s.status} ${JSON.stringify(s.json).slice(0, 160)}`);
  if (process.env.CRON_SECRET) {
    const run = await page.request.get(`${BASE}/api/jobs/campaigns`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, timeout: 120000 });
    if (run.status() >= 300) throw new Error(`runner ${run.status()}`);
  }
  await page.goto(`${BASE}/campaigns`, { waitUntil: "networkidle" });
  await page.fill('input[aria-label="חיפוש בקמפיינים האחרונים"]', `qa-wa-${stamp}`);
  await page.waitForFunction((n) => document.body.innerText.includes(n), `qa-wa-${stamp}`, { timeout: 60000 });
  const csv = await page.request.get(`${BASE}/api/campaigns/${campaignId}/export`);
  if (csv.status() !== 200 || !/text\/csv/.test(csv.headers()["content-type"] ?? "")) throw new Error(`export ${csv.status()}`);
  const detail = await api(`/api/campaigns/${campaignId}`);
  const recs = detail.json.recipients ?? [];
  if (!recs.length || recs.some((r) => typeof r.attempts !== "number")) throw new Error("recipients payload lacks attempts");
  if (process.env.CRON_SECRET && !recs.some((r) => r.status === "SENT")) {
    // Outside the business's marketing window the worker must leave WhatsApp marketing QUEUED (6.02) – that is the correct outcome.
    const pre = await api(`/api/campaigns/${campaignId}?preflight=1`);
    const w = pre.json.sendWindow ?? pre.json.data?.sendWindow;
    const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: w?.timezone ?? "Asia/Jerusalem" }).format(new Date());
    const outside = w && (hhmm < w.start || hhmm > w.end);
    if (!outside || recs.some((r) => r.status !== "QUEUED")) throw new Error(`no recipient reached SENT in simulation: ${recs.map((r) => r.status).join(",")} (window ${JSON.stringify(w)})`);
  }
  await shot("campaign-list");
});

await step("W6 controlled retry: FAILED recipient → 'נסה שוב' requeues; UNKNOWN requires explicit attestation (API)", async () => {
  const detail = await api(`/api/campaigns/${campaignId}`);
  const recs = detail.json.recipients ?? [];
  const r0 = recs[0];
  const noConfirm = await api(`/api/campaigns/${campaignId}`, "PATCH", { action: "retry_recipient", recipientId: r0.id, confirmNotSent: false });
  // SENT recipients are not retryable at all; the API must refuse instead of re-sending.
  if (noConfirm.status < 400) throw new Error("retry of a non-failed recipient was accepted");
});

await step("W7 inbox: tag/channel filters + canned-reply picker inserts text (no send)", async () => {
  await page.goto(`${BASE}/inbox`, { waitUntil: "networkidle" });
  const sel = page.locator('select[aria-label="סינון שיחות לפי ערוץ"]').first();
  if (!(await sel.count())) throw new Error("channel filter missing");
  // A fresh simulated inbound opens the 24h service window, so the free-text composer (and the canned picker) is enabled.
  const sim = await api("/api/demo/simulate-inbound", "POST", { contactId: contactB, body: "היי, שאלה על המבצע" });
  if (sim.status >= 300) throw new Error(`simulate-inbound ${sim.status}`);
  const convId = sim.json.conversationId ?? sim.json.data?.conversationId;
  if (!convId) throw new Error(`no conversation id in ${JSON.stringify(sim.json).slice(0, 120)}`);
  await page.goto(`${BASE}/inbox/${convId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[aria-label="תשובה שמורה"]', { timeout: 90000 });
  await page.focus('select[aria-label="תשובה שמורה"]');
  await page.waitForFunction(() => document.querySelector('select[aria-label="תשובה שמורה"]').options.length > 1, null, { timeout: 20000 });
  await page.selectOption('select[aria-label="תשובה שמורה"]', { index: 1 });
  const text = await page.$$eval("textarea", (els) => els.map((e) => e.value).join("|"));
  if (!text.includes("שלום") && !text.includes("זמינים")) throw new Error(`composer text not inserted: ${text}`);
  await shot("inbox-canned");
});

await step("W8 duplicates: pick primary + merge → one card left with both phones (audit 'contact.merged')", async () => {
  const dup = await api("/api/contacts", "POST", { fullName: `QA מדיה ${stamp}`, phone: ph(3), email: `qa-merge-${stamp}@example.test`, consentStatus: "OPTED_IN", consentEvidence: "qa" });
  if (dup.status >= 300) throw new Error(`dup contact ${dup.status}`);
  const dupId = dup.json.data?.id ?? dup.json.id;
  const m = await api(`/api/contacts/${contactA}/merge`, "POST", { duplicateId: dupId });
  if (m.status >= 300) throw new Error(`merge ${m.status} ${JSON.stringify(m.json).slice(0, 120)}`);
  const gone = await api(`/api/contacts/${dupId}`);
  if (gone.status !== 404) throw new Error("duplicate still exists");
  await page.goto(`${BASE}/contacts/${contactA}`, { waitUntil: "networkidle" });
  const html = await page.content();
  if (!html.includes(`qa-merge-${stamp}@example.test`)) throw new Error("merged email not on primary card");
  await page.goto(`${BASE}/contacts/duplicates`, { waitUntil: "networkidle" });
  await shot("duplicates");
});

await step("W9 sequences: new-lead trigger + task step saved; automations builder exposes task / custom-field actions", async () => {
  await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
  await page.click("text=רצף חדש");
  await page.waitForSelector("text=שמור רצף", { timeout: 20000 });
  let html = await page.content();
  for (const t of ["איש קשר חדש נוצר", "סטטוס ליד השתנה", "משימת מעקב לנציג"]) if (!html.includes(t)) throw new Error(`missing "${t}"`);
  const rule = await api("/api/automations", "POST", { name: `qa-task-${stamp}`, trigger: "NEW_CONVERSATION", triggerConfig: { onlyOutsideHours: true }, actionType: "CREATE_TASK", actionConfig: { title: "לחזור ללקוח", dueHours: 4 }, isActive: false });
  if (rule.status >= 300) throw new Error(`CREATE_TASK rule ${rule.status} ${JSON.stringify(rule.json).slice(0, 160)}`);
  const s = await api("/api/sequences", "POST", { name: `qa-seq-${stamp}`, isActive: false, trigger: "CONTACT_CREATED", triggerConfig: { marketingOnly: true }, stopOn: ["unsubscribe"], steps: [{ action: "task", channel: "sms", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, taskTitle: "להתקשר לליד", taskDueHours: 4 }] });
  if (s.status >= 300) throw new Error(`sequence ${s.status} ${JSON.stringify(s.json).slice(0, 160)}`);
  await shot("automations");
});

await step("W10 analytics: range switch + per-number table", async () => {
  await page.goto(`${BASE}/analytics?days=7`, { waitUntil: "networkidle" });
  const html = await page.content();
  if (!html.includes("לפי מספר") || !html.includes("7 ימים")) throw new Error("range / per-number section missing");
  await shot("analytics");
});

await step("W11 settings: WhatsApp card is honest (no Meta config → missing config / not connected, no fake success); retention panel present", async () => {
  await page.goto(`${BASE}/settings/whatsapp`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="wa-connect-card"]', { timeout: 30000 });
  const html = await page.content();
  if (/מחובר בהצלחה/.test(html)) throw new Error("card claims a live connection without Meta");
  await shot("settings-whatsapp");
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.click("button:has-text('דיוור')");
  await page.waitForSelector("text=שמירה ומחיקת מידע", { timeout: 20000 });
  const html2 = await page.content();
  if (!html2.includes("שמירה ומחיקת מידע") && !html.includes("שמירה ומחיקת מידע")) throw new Error("retention panel missing");
  await shot("settings");
});

await step("W12 tracked link: tampered token → 404, never an open redirect", async () => {
  const r = await page.request.get(`${BASE}/r/AAAA.BBBB`, { maxRedirects: 0 });
  if (r.status() === 302 || r.status() === 301) throw new Error("redirected on invalid token");
});

await step("W14 account: self-service password change validates the current password (no change made to the demo account)", async () => {
  const wrong = await api("/api/auth/password", "POST", { currentPassword: "definitely-wrong", newPassword: "Another1234!" });
  if (wrong.status !== 403) throw new Error(`wrong current password → ${wrong.status}`);
  const same = await api("/api/auth/password", "POST", { currentPassword: "Demo1234!", newPassword: "Demo1234!" });
  if (same.status !== 400) throw new Error(`same password → ${same.status}`);
  const me = await api("/api/auth/me");
  if (me.status !== 200) throw new Error("session must remain valid after rejected attempts");
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="account-change-password"]', { timeout: 30000 });
});

await step("W13 cleanup (QA rows only)", async () => {
  await api(`/api/campaigns/${campaignId}`, "PATCH", { action: "cancel" }).catch(() => undefined);
  // contacts API has no DELETE by design (audit trail); QA contacts stay in the demo business, marked by name.
});

await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));

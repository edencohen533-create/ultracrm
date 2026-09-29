/** QA on a phone viewport (390×800, touch; local, simulated telephony, SANDBOX payments – nothing is charged):
 *  nav drawer; dialer during a call (controls visible, not covered, lead details reachable) and the payment modal
 *  fitting the screen; WhatsApp conversation (composer visible also when the keyboard shrinks the viewport,
 *  customer-file drawer, attaching a file without sending it); lead drawer. "Covered" = the element's centre point
 *  hits another element (overlap). The on-screen keyboard is emulated by shrinking the viewport – what
 *  interactive-widget=resizes-content does on Chrome/Android; iOS Safari needs a real device.
 *  Usage: node scripts/qa-mobile.mjs [base] [outDir] [email] [width] */
import fs from "node:fs";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner@demo.local";
const W = Number(process.argv[5] ?? 390), H = 800;
fs.mkdirSync(OUT, { recursive: true });
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const ctx = await b.newContext({ locale: "he-IL", viewport: { width: W, height: H }, isMobile: true, hasTouch: true, permissions: ["microphone"] });
const page = await ctx.newPage(); page.setDefaultTimeout(45000);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const stateOf = async () => (await api("/api/dialer/state")).json?.data;
const shot = (n) => page.screenshot({ path: `${OUT}/mobile-${n}.png` });
/** Visible interactive elements inside `root` that are off-screen horizontally, covered by something else, or tiny. */
const audit = (root) => page.evaluate((sel) => {
  const r = sel ? document.querySelector(sel) : document.body; if (!r) return { missing: true };
  const bad = [];
  for (const el of r.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea")) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || el.disabled) continue;
    const rc = el.getBoundingClientRect(); if (!rc.width || !rc.height || rc.bottom < 0 || rc.top > innerHeight) continue;
    const name = `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 18)}"`;
    if (rc.left < -1 || rc.right > innerWidth + 1) { bad.push(`offscreen ${name}`); continue; }
    const cx = Math.min(Math.max(rc.left + rc.width / 2, 0), innerWidth - 1), cy = Math.min(Math.max(rc.top + rc.height / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !(el.labels && [...el.labels].some((l) => l.contains(hit)))) bad.push(`covered ${name} by ${hit.tagName.toLowerCase()}.${[...hit.classList].slice(0, 2).join(".")}`);
  }
  return { bad, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
}, root);

await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', process.env.PERF_PASSWORD ?? "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"), { waitUntil: "commit", timeout: 120000 });
const before = (await api("/api/settings/payments")).json?.data;
const stamp = Date.now(); let leadId, name, contactId;

await step("M1 nav: menu button opens the drawer with labels; a link navigates and closes it", async () => {
  await page.goto(`${BASE}/leads`); await page.getByTestId("mobile-menu").click();
  const nav = page.getByTestId("side-nav"); await nav.getByText("שיחות וואטסאפ").waitFor();
  await page.waitForTimeout(350);
  const box = await nav.boundingBox(); if (!box || box.x < -1 || box.x + box.width > W + 1) throw new Error(`drawer outside the screen ${JSON.stringify(box)}`);
  await shot("nav-open");
  await page.waitForTimeout(350); // slide-in transition
  await nav.getByTestId("nav-inbox").click(); await page.waitForURL("**/inbox**");
  await page.waitForTimeout(400); if (await page.getByTestId("mobile-nav-backdrop").count()) throw new Error("drawer stayed open");
});

await step("M2 fixtures: sandbox payment provider (test), a product, a lead", async () => {
  const c = await api("/api/settings/payments", "POST", { provider: "sandbox", environment: "test" }); if (c.status !== 200) throw new Error(`connect ${c.status}`);
  const o = await api("/api/sales", "POST", { action: "offer", data: { name: `מנוי מובייל ${stamp}`, unitAmount: 50000, taxBps: 1800 } }); if (o.status >= 300) throw new Error(`offer ${o.status}`);
  name = `QA Mobile ${stamp}`;
  const k = await api("/api/contacts", "POST", { fullName: name, phone: `052${String(stamp).slice(-6)}3` });
  const users = (await api("/api/users")).json.data.items;
  contactId = k.json.data.id;
  leadId = (await api("/api/leads", "POST", { contactId: k.json.data.id, ownerUserId: users.find((u) => u.email === EMAIL).id })).json.data.id;
});

await step("M3 call from the lead list on a phone → answered; call controls visible and not covered", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("חיפוש לידים").fill(name); await page.getByTestId(`lead-row-${leadId}`).waitFor();
  await page.getByTestId(`lead-row-${leadId}`).locator(".lead-call").click();
  // Poll from node: waitForFunction with an async predicate resolves at once (a Promise is truthy).
  const until = async (ok, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (ok(await stateOf())) return; await page.waitForTimeout(800); } throw new Error("timeout waiting for the call state"); };
  await until((s) => s?.activeCall?.status === "answered", 45000);
  await page.waitForTimeout(1200); await shot("call-active");
  const a = await audit(null); if (a.overflow > 0) throw new Error(`horizontal overflow ${a.overflow}px`);
  if (a.bad.length) throw new Error(a.bad.slice(0, 4).join(" | "));
  const hang = page.getByRole("button", { name: /ניתוק|נתק|סיום/ }).first(); if (!(await hang.isVisible())) throw new Error("no hang-up button visible");
});

await step("M4 lead details reachable during the call (scroll, no overlap)", async () => {
  await page.getByText(name).first().waitFor({ timeout: 20000 }); // lead card loaded (name shown)
  await page.getByTestId("payment-open").first().scrollIntoViewIfNeeded(); await page.mouse.wheel(0, 500); await page.waitForTimeout(400); await shot("call-lead");
  const a = await audit(null); if (a.bad.length) throw new Error(a.bad.slice(0, 4).join(" | "));
});

await step("M5 payment modal fits the phone screen; its controls are not covered; closing keeps the call", async () => {
  await page.getByTestId("payment-open").first().scrollIntoViewIfNeeded(); await page.getByTestId("payment-open").first().click();
  const m = page.getByTestId("payment-modal"); await m.waitFor();
  const opt = await page.getByTestId("payment-item").locator("option", { hasText: `מנוי מובייל ${stamp}` }).getAttribute("value");
  await page.getByTestId("payment-item").selectOption(opt); await page.waitForTimeout(300);
  const box = await m.locator(":scope > div").boundingBox(); if (!box || box.x < 0 || box.x + box.width > W + 1 || box.y < 0 || box.y + box.height > H + 1) throw new Error(`modal outside the screen ${JSON.stringify(box)}`);
  await shot("payment-modal");
  const a = await audit('[data-testid="payment-modal"]'); if (a.bad.length) throw new Error(a.bad.slice(0, 4).join(" | "));
  await page.getByTestId("payment-close").click();
  const st = (await stateOf()).activeCall; if (st?.status !== "answered") throw new Error(`the call did not stay live: ${st?.status ?? "none"} ${st?.endedAt ?? ""}`);
});

await step("M6 hang up (simulation)", async () => {
  const st = await stateOf(); await api(`/api/dialer/call/${st.activeCall.id}/hangup`, "POST", {});
  for (let i = 0; i < 40 && (await stateOf())?.activeCall; i++) await page.waitForTimeout(800);
  if ((await stateOf())?.activeCall) throw new Error("the call did not end");
});

let conv;
await step("M7 WhatsApp conversation: composer on screen; still on screen with the keyboard open (viewport −320px)", async () => {
  // An inbound message (local mock provider – nothing leaves the machine) opens the 24h reply window.
  // When the business has a real WhatsApp connection the simulation is refused (409) → use an open conversation.
  const sim = await api("/api/demo/simulate-inbound", "POST", { contactId, body: "שלום, בדיקת מובייל" });
  if (sim.status === 200) { conv = `/inbox/${sim.json.conversationId}`; await page.goto(`${BASE}/inbox`); await page.locator(`a[href="${conv}"]:visible`).first().click(); await page.waitForURL(`**${conv}`); }
  else {
    await page.goto(`${BASE}/inbox`); await page.locator('a[href^="/inbox/"]:visible').first().waitFor();
    const hrefs = (await page.locator('a[href^="/inbox/"]:visible').evaluateAll((as) => as.map((a) => a.getAttribute("href")))).filter((h) => h && !h.includes("?")).slice(0, 8);
    for (const h of hrefs) { await page.locator(`a[href="${h}"]:visible`).first().click(); await page.waitForURL(`**${h}`); await page.waitForTimeout(1200); if (await page.locator("textarea:visible").count()) { conv = h; break; } await page.goBack(); }
    if (!conv) throw new Error(`simulate-inbound ${sim.status} and no open conversation among the first 8`);
  }
  const box = page.locator("textarea:visible").last(); await box.waitFor();
  const inView = async (h) => { const r = await box.boundingBox(); return r && r.y >= 0 && r.y + r.height <= h + 1; };
  if (!(await inView(H))) throw new Error("composer not visible");
  await shot("chat");
  await box.tap(); await page.setViewportSize({ width: W, height: H - 320 }); await page.waitForTimeout(500);
  if (!(await inView(H - 320))) throw new Error(`composer hidden behind the keyboard ${JSON.stringify(await box.boundingBox())}`);
  await shot("chat-keyboard");
  const a = await audit(null); if (a.overflow > 0) throw new Error(`horizontal overflow ${a.overflow}px`);
  await page.setViewportSize({ width: W, height: H });
});

await step("M8 customer file reachable on a phone (drawer)", async () => {
  await page.getByTestId("customer-file-open").first().click();
  const d = page.getByTestId("customer-file-drawer"); await d.waitFor(); await shot("customer-file");
  const box = await d.boundingBox(); if (!box || box.x < -1 || box.x + box.width > W + 1) throw new Error("drawer outside the screen");
  await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  if (await d.isVisible()) { await d.getByRole("button", { name: /סגור|סגירה/ }).first().click(); }
});

await step("M9 attach a file (chosen, previewed, NOT sent)", async () => {
  const input = page.locator('input[type="file"][aria-label="צירוף קובץ"]').last();
  await input.setInputFiles({ name: "qa-mobile.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
  await page.waitForTimeout(500); await shot("attach");
  const shown = await page.getByText("qa-mobile.png").count(); if (!shown) throw new Error("the chosen file is not shown before sending");
});

await step("M10 lead drawer on a phone fits the screen", async () => {
  await page.goto(`${BASE}/leads`); await page.getByLabel("חיפוש לידים").fill(name); await page.getByTestId(`lead-row-${leadId}`).waitFor();
  await page.getByTestId(`lead-row-${leadId}`).locator("td").nth(1).click(); await page.waitForTimeout(1200);
  await shot("lead-drawer");
  const a = await audit(null); if (a.overflow > 0) throw new Error(`horizontal overflow ${a.overflow}px`);
});

await step("Z restore the payment provider setting", async () => { if (!before?.connected) await api("/api/settings/payments", "DELETE"); });
await b.close(); console.log(results.join("\n"));

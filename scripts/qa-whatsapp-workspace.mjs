/** QA (local / demo data only): WhatsApp workspace.
 *  W1 assistant: link + verify a demo phone, "תוסיף ליד: …" → lead saved with a link; a missing phone → question.
 *  W2 nav says "שיחות וואטסאפ"; no "כל הערוצים".
 *  W3 contacts → "WhatsApp" opens the contact's thread in the system; blocked contact shows the reason.
 *  W4 customer file beside the thread (desktop), follows the conversation when switching (no mixing); notes bar white.
 *  W5 phone 390px: file opens as a drawer; no horizontal page overflow.
 *  Usage: node scripts/qa-whatsapp-workspace.mjs [base] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner-b@demo.local";
const PHONE = "0549992" + String(Date.now()).slice(-3);
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const noOverflow = async () => { if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("horizontal overflow"); };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const stamp = String(Date.now()).slice(-6);
let linkId, initial, c1, c2, blocked;

await step("W1 WhatsApp assistant: 'תוסיף ליד' saves a lead and answers with a link; a missing phone gets one question", async () => {
  const s = (await api("/api/assistant")).json.data; initial = s.settings;
  if (s.connection?.provider && s.connection.provider !== "mock") throw new Error("live WhatsApp – aborting");
  await api("/api/assistant", "PATCH", { enabled: true, paused: false });
  const r = await api("/api/assistant/links", "POST", { phone: PHONE, scope: "business" }); if (r.status !== 201) throw new Error(`link ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  linkId = r.json.data.link.id;
  const say = async (text) => { const x = await api("/api/assistant/simulate", "POST", { linkId, text }); if (x.status !== 200) throw new Error(`simulate ${x.status}`); return x.json.data.replies.map((y) => y.text).join("\n"); };
  if (!(await say(r.json.data.code)).includes("אומת")) throw new Error("verify failed");
  const leadPhone = "0527" + stamp;
  const a = await say(`תוסיף ליד: דנה QA ${stamp}, ${leadPhone}, מגנזיום, מקור פייסבוק`);
  if (!a.includes("✅ הליד נשמר") || !a.includes("/leads/")) throw new Error(a.slice(0, 300));
  const q = await say(`תוסיף ליד: רון QA ${stamp}`); if (!q.includes("מה מספר הטלפון")) throw new Error(q);
  const q2 = await say("בטל"); if (!q2.includes("לא נוצר ליד")) throw new Error(q2);
});

await step("W2 nav 'שיחות וואטסאפ'; no 'כל הערוצים' in the WhatsApp area", async () => {
  await page.goto(`${BASE}/inbox`);
  const nav = await page.getByTestId("nav-inbox").innerText(); if (!nav.includes("שיחות וואטסאפ")) throw new Error(nav);
  if (await page.getByText("כל הערוצים").count()) throw new Error("'כל הערוצים' still shown");
});

await step("W3 contacts → WhatsApp opens the contact's own thread; a blocked contact shows why", async () => {
  const mk = async (name, phone) => { const r = await api("/api/contacts", "POST", { fullName: name, phone, consentStatus: "UNKNOWN" }); if (r.status >= 300) throw new Error(`contact ${r.status}`); return (r.json.data ?? r.json).id; };
  c1 = await mk(`תיק א ${stamp}`, "0531" + stamp); c2 = await mk(`תיק ב ${stamp}`, "0532" + stamp); blocked = await mk(`חסום ${stamp}`, "0533" + stamp);
  await api("/api/leads", "POST", { contactId: c1, source: "פייסבוק" });
  await api(`/api/contacts/${blocked}/suppress`, "POST", { scope: "all", reason: "QA" });
  await page.goto(`${BASE}/contacts?search=${stamp}`); await page.waitForLoadState("networkidle");
  const row = page.locator("tr", { hasText: `חסום ${stamp}` }); await row.waitFor();
  if (!(await row.getByTestId("contact-whatsapp").isDisabled())) throw new Error("blocked contact: WhatsApp enabled");
  if (!(await row.getByTestId("contact-whatsapp-reason").innerText()).includes("חסום")) throw new Error("no reason shown");
  await page.locator("tr", { hasText: `תיק א ${stamp}` }).getByTestId("contact-whatsapp").click();
  await page.waitForURL(/\/inbox\/[^/]+$/);
  await page.screenshot({ path: `${OUT}/wa-contacts-open.png` });
});

await step("W4 customer file beside the thread follows the conversation (no mixing); notes bar is white", async () => {
  const file = page.getByTestId("customer-file"); await file.waitFor();
  if (!(await file.innerText()).includes(`תיק א ${stamp}`)) throw new Error("file shows another customer");
  const url1 = page.url();
  const r = await api(`/api/contacts/${c2}/whatsapp`, "POST"); const id2 = r.json.data.conversationId;
  await page.goto(`${BASE}/inbox/${id2}`); await page.getByTestId("customer-file").waitFor();
  const t2 = await page.getByTestId("customer-file").innerText();
  if (!t2.includes(`תיק ב ${stamp}`) || t2.includes(`תיק א ${stamp}`)) throw new Error("mixed data after switching");
  await page.goto(url1); const t1 = await page.getByTestId("customer-file").innerText();
  if (!t1.includes(`תיק א ${stamp}`) || t1.includes(`תיק ב ${stamp}`)) throw new Error("mixed data after switching back");
  if (!t1.includes("פייסבוק")) throw new Error("lead source missing");
  const bg = await page.locator("details", { hasText: "הערות פנימיות" }).first().evaluate((el) => getComputedStyle(el).backgroundColor);
  if (bg !== "rgb(255, 255, 255)") throw new Error(`notes background ${bg}`);
  await page.screenshot({ path: `${OUT}/wa-customer-file.png` });
});

await step("W5 phone 390px: the file opens as a drawer; no horizontal overflow", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.waitForLoadState("networkidle");
  if (await page.getByTestId("customer-file").isVisible()) throw new Error("fixed panel shown on phone");
  await noOverflow();
  await page.getByTestId("customer-file-open").click();
  const d = page.getByTestId("customer-file-drawer"); await d.waitFor();
  if (!(await d.innerText()).includes(`תיק א ${stamp}`)) throw new Error("drawer content");
  await page.screenshot({ path: `${OUT}/wa-customer-file-mobile.png` });
  await page.keyboard.press("Escape"); if (await d.count()) throw new Error("drawer did not close");
});

await step("W6 cleanup: remove the demo link, restore assistant settings", async () => {
  if (linkId) await api(`/api/assistant/links/${linkId}`, "DELETE");
  if (initial) await api("/api/assistant", "PATCH", { enabled: initial.enabled, paused: initial.paused });
});
await b.close(); console.log(results.join("\n"));

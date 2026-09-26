/** Browser QA for: statuses/distribution buttons, per-agent limits, segments, menu, journey builder, dial-lead in power mode. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = []; const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const step = async (name, fn) => { if (ONLY.length && !ONLY.includes(name.split(" ")[0])) return; try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch(); const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/r7-${n}.png` }).catch(() => undefined);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const cleanup = async () => { for (let i = 0; i < 5; i++) { const s = (await api("/api/dialer/state")).json?.data ?? {}; if (!s.activeCall && !s.wrapUpCall && (!s.session || s.session.status === "ended")) return; if (s.session && s.session.status !== "ended") await api("/api/dialer/session", "DELETE"); if (s.activeCall) await api(`/api/dialer/call/${s.activeCall.id}/hangup`, "POST", {}); if (s.wrapUpCall) await api(`/api/dialer/call/${s.wrapUpCall.id}/outcome`, "POST", { outcome: "no_answer" }); await page.waitForTimeout(2000); } };

await step("R0 manager login; side menu has contacts + WhatsApp templates", async () => {
  await login("manager@demo.local"); await cleanup(); await page.goto(`${BASE}/leads`);
  const labels = await page.$$eval('[data-testid="side-nav"] nav a', (e) => e.map((x) => x.textContent.trim()));
  if (labels.join("|") !== "לידים|וואטסאפ|קהלים ואנשי קשר|תבניות WhatsApp|קמפיינים|אוטומציות|דוחות") throw new Error(labels.join(","));
  await page.click('[data-testid="nav-templates"]'); await page.waitForURL((u) => u.pathname === "/templates");
});
await step("R1 'עריכת סטטוסים' button on leads opens the statuses editor directly", async () => {
  await page.goto(`${BASE}/leads`); await page.click('[data-testid="open-statuses"]'); await page.waitForSelector('[data-testid="statuses-editor"]'); await shot("statuses"); await page.keyboard.press("Escape");
});
await step("R2 'חלוקת לידים': round robin + per-agent limits saved", async () => {
  await page.click('[data-testid="open-assignment"]'); await page.waitForSelector('[data-testid="assignment-agents"]');
  await page.selectOption('[data-testid="assignment-mode"]', "round_robin");
  const first = page.locator('[data-testid^="assignment-agent-cap-"]').first(); const id = (await first.getAttribute("data-testid")).replace("assignment-agent-cap-", "");
  await first.fill("7"); await shot("assignment"); await page.click('[data-testid="assignment-save"]'); await page.waitForSelector("text=חלוקת הלידים נשמרה");
  const la = (await api("/api/lead-statuses")).json.data.leadAssignment; if (la.mode !== "round_robin" || la.perAgentMax[id] !== 7) throw new Error(JSON.stringify(la));
  await api("/api/lead-statuses", "PATCH", { leadAssignment: { mode: "least_loaded", maxOpenLeadsPerAgent: 0, agentIds: [], perAgentMax: {} } });
  await page.keyboard.press("Escape");
});
await step("R3 contacts: segments panel, create a segment with conditions, it filters the table; delete it", async () => {
  await page.click('[data-testid="nav-contacts"]'); await page.waitForURL((u) => u.pathname === "/contacts"); await page.waitForSelector('[data-testid="segments-panel"]');
  const allTotal = await page.textContent("h1 + span");
  await page.click('[data-testid="segment-new"]'); await page.fill('[data-testid="segment-name"]', `QA סגמנט ${Date.now()}`);
  await page.waitForFunction(() => /אנשי קשר עומדים/.test(document.querySelector('[data-testid="segment-preview"]')?.textContent ?? ""), null, { timeout: 60000 });
  const preview = Number((await page.textContent('[data-testid="segment-preview"]')).replace(/[^\d]/g, ""));
  await shot("segment-builder"); await page.click('[data-testid="segment-save"]');
  await page.waitForFunction((n) => { const t = document.querySelector("h1 + span")?.textContent ?? ""; return Number(t.replace(/[^\d]/g, "")) === n; }, preview, { timeout: 60000 });
  await shot("segment-filtered");
  const active = page.locator(".seg-item.active"); await active.hover(); await active.locator(".seg-del").click();
  await page.waitForSelector('[data-testid="segment-all"].active'); void allTotal;
});
await step("R4 journey builder: new journey, trigger, add wait + tag + WhatsApp/notification via the action gallery, save, reopen", async () => {
  await page.goto(`${BASE}/automations`); await page.click('[data-testid="journey-new"]'); await page.waitForSelector('[data-testid="journey-builder"]');
  await page.fill('[data-testid="journey-name"]', `QA מסע ${Date.now()}`);
  await page.selectOption('[data-testid="journey-trigger-select"]', "TAG_ADDED"); await page.fill('[data-testid="journey-panel"] input[list="jr-tags"]', "qa-journey");
  await page.click('[data-testid="journey-add-0"]'); await page.waitForSelector('[data-testid="journey-palette-wait"]'); await shot("journey-palette");
  const cards = await page.$$eval(".jr-palette-grid button span", (e) => e.map((x) => x.textContent)); if (cards.length < 11) throw new Error(`palette ${cards.join(",")}`);
  await page.click('[data-testid="journey-palette-wait"]');
  await page.click('[data-testid="journey-add-1"]'); await page.click('[data-testid="journey-palette-add_tag"]'); await page.fill('[data-testid="journey-tag"]', "עבר-מסע");
  await page.click('[data-testid="journey-add-2"]'); await page.click('[data-testid="journey-palette-task"]');
  await page.click('[data-testid="journey-exit"]'); await shot("journey");
  await page.click('[data-testid="journey-save"]'); await page.waitForURL((u) => /\/automations\/journeys\/(?!new)/.test(u.pathname), { timeout: 60000 });
  await page.reload(); await page.waitForSelector('[data-testid="journey-step-2"]');
  const id = page.url().split("/").pop(); const del = await api(`/api/sequences/${id}`, "DELETE"); if (del.status !== 200) throw new Error(`cleanup ${del.status}`);
});
await step("R5 dialer: in power mode 'חייג לליד' works during the countdown (dials the next lead)", async () => {
  await login("agent1@demo.local"); await cleanup();
  await page.goto(`${BASE}/dialer`); await page.waitForSelector("text=זמינים לחיוג עכשיו"); await page.waitForSelector('[data-testid="start-dialer"]:not([disabled])');
  await page.click('[data-testid="start-dialer"]'); await page.waitForSelector('[data-testid="call-strip"]');
  const net = []; page.on("response", async (r) => { if (/dialer\/(call|next-lead|session)/.test(r.url())) net.push(`${r.request().method()} ${r.url().split("/api/")[1].slice(0, 30)} ${r.status()} ${(await r.text().catch(() => "")).slice(0, 90)}`); });
  const b = page.locator('[data-testid="strip-dial-lead"]');
  await page.waitForTimeout(800);
  if (await b.isDisabled()) throw new Error(`disabled: ${await page.textContent('[data-testid="call-strip"]')}`);
  await b.click();
  await page.waitForFunction(() => /מצלצל|נענתה|בשיחה|מחייג|נקשר/.test(document.querySelector('[data-testid="call-strip"]')?.textContent ?? ""), null, { timeout: 30000 }).catch(async () => { throw new Error(`strip: ${await page.textContent('[data-testid="call-strip"]')} | toasts: ${(await page.locator("[data-sonner-toast]").allTextContents()).join(" / ")} | net: ${net.join(" || ")}`); });
  await shot("dial-lead"); await cleanup();
});
await browser.close(); console.log(results.join("\n")); process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0);

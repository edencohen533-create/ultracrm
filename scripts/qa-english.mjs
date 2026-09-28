/** QA (production): with lang=en, visit every screen as the demo owner and list Hebrew text still visible in the UI
 *  chrome (buttons, labels, headers) – excluding user data (names, messages) by only scanning interactive/structural
 *  elements. Also checks dir=ltr and the public pages. Screenshots of the key screens go to docs/qa/en-*.png. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "en-GB", viewport: { width: 1440, height: 950 } });
await ctx.addCookies([{ name: "lang", value: "en", url: BASE }]);
const page = await ctx.newPage(); page.setDefaultTimeout(120000);
const HE = /[֐-׿]/;
const scan = async () => page.evaluate(() => {
  const out = new Set();
  const sel = "button, a, label, th, h1, h2, h3, h4, [role=tab], option, legend, dt, summary, input[placeholder], textarea[placeholder], [aria-label], .nav-label, p, span, small, dd, td";
  for (const el of document.querySelectorAll(sel)) {
    if (el.closest("[data-user-content], .whitespace-pre-wrap")) continue;
    const texts = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("title"), el.children.length === 0 ? el.textContent : null].filter(Boolean);
    for (const t of texts) if (/[֐-׿]/.test(t) && t.length < 120) out.add(t.trim());
  }
  return { dir: document.documentElement.dir, hebrew: [...out].slice(0, 40) };
});
const report = [];
const visit = async (path, shot) => {
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" }).catch(() => page.goto(`${BASE}${path}`));
    await page.waitForTimeout(1500);
    const r = await scan();
    report.push({ path, dir: r.dir, hebrew: r.hebrew });
    if (shot) await page.screenshot({ path: `docs/qa/en-${shot}.png` });
  } catch (e) { report.push({ path, error: e.message.slice(0, 120) }); }
};
for (const p of ["/", "/privacy", "/terms", "/data-deletion", "/support", "/login"]) await visit(p, p === "/" ? "landing" : p === "/login" ? "login" : null);
await page.fill('input[type="email"]', "owner@demo.local"); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const routes = [["/leads", "crm"], ["/lists", null], ["/dialer", "dialer"], ["/inbox", "inbox"], ["/contacts", null], ["/templates", "templates"], ["/campaigns/whatsapp", "campaigns"], ["/automations", null], ["/automations/journeys", null], ["/automations/carts", null], ["/automations/integrations", null], ["/ai", null], ["/ai?tab=ops", null], ["/ai?tab=knowledge", null], ["/ai?tab=settings", null], ["/reports", "reports"], ["/settings", "settings"], ["/settings?tab=connections", null], ["/settings/whatsapp", "whatsapp"], ["/settings?tab=users", null], ["/settings?tab=access", null], ["/settings?tab=plan", null], ["/settings?tab=assistant", null], ["/settings?tab=account", "account"], ["/settings?tab=general", null]];
for (const [p, s] of routes) await visit(p, s);
// a conversation and the template builder (screencast screens)
await page.goto(`${BASE}/inbox`); const conv = page.locator('a[href^="/inbox/"]').first(); if (await conv.count()) { await conv.click(); await page.waitForTimeout(2000); const r = await scan(); report.push({ path: "/inbox/<conversation>", dir: r.dir, hebrew: r.hebrew }); await page.screenshot({ path: "docs/qa/en-conversation.png" }); }
await page.goto(`${BASE}/templates`); if (await page.locator('[data-testid="tb-open"]').count()) { await page.click('[data-testid="tb-open"]'); await page.waitForTimeout(1500); const r = await scan(); report.push({ path: "/templates (builder)", dir: r.dir, hebrew: r.hebrew }); await page.screenshot({ path: "docs/qa/en-template-builder.png" }); }
await b.close();
for (const r of report) console.log(`${r.error ? "ERR" : r.dir}\t${r.path}\t${r.error ?? (r.hebrew.length ? r.hebrew.join(" | ") : "✓ no Hebrew UI text")}`);

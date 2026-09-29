/** Mobile audit: every app screen at phone / tablet / desktop widths. Per screen+width: horizontal page overflow
 *  (and the elements sticking out), small tap targets (< 32px on a side, visible, interactive), and a screenshot.
 *  Usage: node scripts/mobile-audit.mjs [base] [outDir] [email] [widths]  (password: PERF_PASSWORD or Demo1234!) */
import fs from "node:fs";
import { chromium, devices } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "mobile-audit";
const EMAIL = process.argv[4] ?? "owner@demo.local";
const WIDTHS = (process.argv[5] ?? "360,390,414,768,1280").split(",").map(Number);
const ONLY = process.env.ROUTES?.split(",");
fs.mkdirSync(OUT, { recursive: true });
const STATIC = ["/dashboard", "/leads", "/inbox", "/dialer", "/contacts", "/contacts/duplicates", "/deals", "/lists", "/tasks", "/calls", "/campaigns/whatsapp", "/campaigns/sms", "/campaigns/email", "/audiences", "/templates", "/automations", "/automations/carts", "/automations/history", "/automations/integrations", "/carts", "/reports", "/analytics", "/manager", "/manager/calls", "/ai", "/sales", "/numbers", "/crm-settings", "/settings", "/settings/whatsapp", "/settings/sms", "/settings/email", "/support"];
const b = await chromium.launch();
const login = async (ctx) => { const p = await ctx.newPage(); await p.goto(`${BASE}/login`); await p.fill('input[type="email"]', EMAIL); await p.fill('input[type="password"]', process.env.PERF_PASSWORD ?? "Demo1234!"); await p.click('button[type="submit"]'); await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }); return p; };
// Resolve a few detail routes from list pages.
const c0 = await b.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } }); const p0 = await login(c0);
const firstHref = async (path, prefix) => { await p0.goto(`${BASE}${path}`); await p0.waitForTimeout(2500); return p0.locator(`a[href^="${prefix}"]:visible`).evaluateAll((as, pre) => as.map((a) => a.getAttribute("href")).find((h) => h && h !== pre && !h.includes("?") && h.split("/").length > pre.split("/").length - 1), prefix).catch(() => null); };
const dyn = [await firstHref("/inbox", "/inbox/"), await firstHref("/lists", "/lists/"), await firstHref("/contacts", "/contacts/"), await firstHref("/deals", "/deals/")].filter((h) => h && !/duplicates/.test(h));
await c0.close();
const routes = ONLY ?? [...STATIC, ...dyn];
const report = [];
for (const w of WIDTHS) {
  const mobile = w < 768;
  const ctx = await b.newContext({ locale: "he-IL", viewport: { width: w, height: mobile ? 800 : w < 1024 ? 1024 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  const p = await login(ctx); p.setDefaultTimeout(30000);
  for (const r of routes) {
    try { await p.goto(`${BASE}${r}`, { waitUntil: "domcontentloaded" }); await p.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => undefined); await p.waitForTimeout(800); } catch (e) { report.push({ w, r, error: String(e).slice(0, 120) }); continue; }
    const res = await p.evaluate(() => {
      const vw = document.documentElement.clientWidth; const sw = document.documentElement.scrollWidth;
      const visible = (el) => { if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; const rc = el.getBoundingClientRect(); return rc.width > 0 && rc.height > 0 && !el.closest("[hidden],[aria-hidden=true],[inert]"); };
      const inScroller = (el) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const ox = getComputedStyle(e).overflowX; if ((ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") && e.getBoundingClientRect().right <= vw + 1) return true; } return false; };
      const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.getAttribute("data-testid") ? `[${el.getAttribute("data-testid")}]` : ""}.${[...el.classList].slice(0, 3).join(".")}`;
      const over = [];
      for (const el of document.querySelectorAll("body *")) { if (!visible(el)) continue; const rc = el.getBoundingClientRect(); if ((rc.right > vw + 2 || rc.left < -2) && !inScroller(el) && getComputedStyle(el).position !== "fixed") over.push(`${desc(el)} [${Math.round(rc.left)}..${Math.round(rc.right)}]`); }
      const small = [];
      for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], [role=tab], summary')) { if (!visible(el)) continue; const rc = el.getBoundingClientRect(); if (rc.bottom < 0 || rc.top > innerHeight * 3) continue; if (el.matches("input[type=checkbox],input[type=radio]")) { if (rc.width < 16) small.push(`${desc(el)} ${Math.round(rc.width)}x${Math.round(rc.height)}`); continue; }
        if (rc.height < 32 || rc.width < 32) small.push(`${desc(el)} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 20)}" ${Math.round(rc.width)}x${Math.round(rc.height)}`); }
      const leaves = over.filter((x, i) => !over.slice(i + 1).some((y) => y !== x)); void leaves;
      return { overflowPx: sw - vw, over: over.slice(-8), overCount: over.length, small: small.slice(0, 10), smallCount: small.length, dir: document.documentElement.dir };
    });
    const name = `${w}-${r.replaceAll("/", "_") || "root"}.png`;
    if (w <= 390 || w === 768) await p.screenshot({ path: `${OUT}/${name}`, fullPage: false }).catch(() => undefined);
    report.push({ w, r, ...res });
  }
  await ctx.close();
}
fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
for (const x of report) if (x.error || x.overflowPx > 0 || x.overCount > 0) console.log(`${x.w} ${x.r} ${x.error ?? `overflow ${x.overflowPx}px, ${x.overCount} elems: ${x.over.slice(0, 3).join(" | ")}`}`);
const small = report.filter((x) => x.w === 390 && x.smallCount).map((x) => `${x.r}: ${x.smallCount}`); console.log("small tap targets @390:", small.join(", "));
await b.close();

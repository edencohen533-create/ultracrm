/** Performance measurement of the main flows against a production build (same data / machine for before & after).
 *  Per flow (median of N runs): time until the flow's content is ready, API requests (and exact duplicates),
 *  summed server time of those API calls, JS bytes loaded on that navigation. Output: JSON + a table.
 *  Usage: node scripts/perf-measure.mjs [base] [out.json] [runs] [email] */
import fs from "node:fs";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3220";
const OUT = process.argv[3] ?? "perf.json";
const RUNS = Number(process.argv[4] ?? 3);
const EMAIL = process.argv[5] ?? "owner@demo.local";
const b = await chromium.launch();
const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } });
const page = await ctx.newPage(); page.setDefaultTimeout(60000);
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', process.env.PERF_PASSWORD ?? "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));

let log = [];
page.on("requestfinished", async (r) => {
  const u = new URL(r.url()); const t = r.timing();
  const res = await r.response().catch(() => null);
  const size = res ? Number((await res.headerValue("content-length").catch(() => null)) ?? 0) : 0;
  log.push({ path: u.pathname + u.search, type: r.resourceType(), ms: t.responseEnd > 0 ? t.responseEnd - t.requestStart : null, size, method: r.method() });
});
await page.goto(`${BASE}/inbox`);
await page.locator('a[href^="/inbox/"]').first().waitFor();
const ids = [...new Set(await page.locator('a[href^="/inbox/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href").split("/")[2]).filter((x) => x && !x.includes("?"))))].slice(0, 2);
if (ids.length < 2) throw new Error("need two conversations in the list");

const FLOWS = {
  leads: async () => { await page.goto(`${BASE}/leads`); await page.locator('[data-testid^="lead-row-"]').first().waitFor(); },
  inbox_open: async () => { await page.goto(`${BASE}/inbox/${ids[0]}`); await page.locator("[data-testid=customer-file]:visible").first().waitFor(); },
  inbox_switch: async () => { await page.goto(`${BASE}/inbox/${ids[0]}`); await page.locator("[data-testid=customer-file]:visible").first().waitFor(); log = []; const t0 = Date.now();
    await page.locator(`a[href="/inbox/${ids[1]}"]`).first().click(); await page.waitForURL(`**/inbox/${ids[1]}`); await page.locator("[data-testid=customer-file]:visible").first().waitFor(); return Date.now() - t0; },
  dialer: async () => { await page.goto(`${BASE}/dialer`); await page.locator('[data-testid="dialer-launcher"], [data-testid="dialer-embedded"]').first().waitFor(); },
  campaigns: async () => { await page.goto(`${BASE}/campaigns/whatsapp`); await page.locator("[data-testid=campaign-create]:visible").first().waitFor(); await page.locator(".cmp-row, [data-testid='campaigns-empty']").first().waitFor(); },
  reports: async () => { await page.goto(`${BASE}/reports`); await page.locator("[data-testid=rep-kpis]:visible").first().waitFor(); await page.locator("[data-testid=agent-performance]:visible").first().waitFor(); },
};
const median = (xs) => { const s = [...xs].sort((a, c) => a - c); return s[Math.floor(s.length / 2)]; };
const result = {};
for (const [name, fn] of Object.entries(FLOWS)) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    await page.goto(`${BASE}/settings`); await page.waitForLoadState("networkidle"); // neutral start
    log = []; const t0 = Date.now();
    const custom = await fn(); const ready = typeof custom === "number" ? custom : Date.now() - t0;
    await page.waitForTimeout(1500); // late requests after "ready" (duplicates / polling) still count
    const api = log.filter((l) => l.path.startsWith("/api/"));
    const counts = api.reduce((m, l) => m.set(`${l.method} ${l.path}`, (m.get(`${l.method} ${l.path}`) ?? 0) + 1), new Map());
    const dups = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
    runs.push({ ready, api: api.length, dups, serverMs: Math.round(api.reduce((s, l) => s + (l.ms ?? 0), 0)), slowest: api.filter((l) => l.ms).sort((a, c) => c.ms - a.ms).slice(0, 3).map((l) => `${l.path.split("?")[0]} ${Math.round(l.ms)}ms`), js: log.filter((l) => l.type === "script").reduce((s, l) => s + l.size, 0) });
  }
  result[name] = { readyMs: median(runs.map((r) => r.ready)), apiRequests: median(runs.map((r) => r.api)), serverMs: median(runs.map((r) => r.serverMs)), jsKB: Math.round(median(runs.map((r) => r.js)) / 1024), duplicates: runs[runs.length - 1].dups, slowest: runs[runs.length - 1].slowest, runs: runs.map((r) => r.ready) };
}
// Cold JS per screen: a fresh browser context (empty cache), JS bytes transferred / decoded for that page load.
const cookies = await ctx.cookies();
const PAGES = { leads: "/leads", inbox_open: `/inbox/${ids[0]}`, dialer: "/dialer", campaigns: "/campaigns/whatsapp", reports: "/reports" };
for (const [name, path] of Object.entries(PAGES)) {
  const c2 = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } }); await c2.addCookies(cookies);
  const p2 = await c2.newPage(); await p2.goto(`${BASE}${path}`, { waitUntil: "networkidle" }).catch(() => undefined);
  const js = await p2.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.initiatorType === "script" || e.name.endsWith(".js")).reduce((a, e) => ({ transfer: a.transfer + (e.transferSize || 0), decoded: a.decoded + (e.decodedBodySize || 0) }), { transfer: 0, decoded: 0 }));
  result[name].jsColdKB = Math.round(js.transfer / 1024); result[name].jsDecodedKB = Math.round(js.decoded / 1024);
  await c2.close();
}
fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(Object.entries(result).map(([k, v]) => `${k.padEnd(13)} ready ${String(v.readyMs).padStart(5)}ms  api ${String(v.apiRequests).padStart(3)}  server ${String(v.serverMs).padStart(5)}ms  js(cold) ${String(v.jsColdKB ?? '-').padStart(4)}KB/${String(v.jsDecodedKB ?? '-').padStart(5)}KB  dups: ${v.duplicates.join(", ") || "-"}  slowest: ${v.slowest.join(" | ")}`).join("\n"));
await b.close();

/** QA (local / demo data only): template header image upload + WhatsApp connection screen.
 *  T1 wrong type and a file over 5MB are refused before upload, with a clear reason.
 *  T2 a 2.7MB PNG uploads in chunks (progress), is checked, shows a preview (builder + WhatsApp preview).
 *  T3 replace with another image; remove → back to "choose image".
 *  T4 phone 390px: the builder with an image – no horizontal overflow.
 *  T5 connection screen (owner): the connect card renders with its real state – nothing shown as connected untested.
 *  Nothing is submitted to Meta. Usage: node scripts/qa-template-images.mjs [base] [imagesDir] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const IMG = process.argv[3];
const OUT = process.argv[4] ?? "docs/qa";
const EMAIL = process.argv[5] ?? "owner-b@demo.local";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(120000);
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const file = page.getByTestId("tb-image-file");
const uploads = [];
page.on("request", (r) => { if (r.url().includes("/api/media/uploads/") && r.method() === "PUT") uploads.push(r.url()); });

await step("T1 open the builder, image header; GIF and a >5MB file are refused with a reason", async () => {
  await page.goto(`${BASE}/templates`); await page.getByTestId("tb-open").first().click();
  await page.getByTestId("tb-header-IMAGE").click();
  await page.getByTestId("tb-image-pick").waitFor();
  await file.setInputFiles(`${IMG}/anim.gif`);
  if (!(await page.getByTestId("tb-image-error").innerText()).includes("JPG או PNG")) throw new Error("gif not refused");
  await file.setInputFiles(`${IMG}/big.png`);
  if (!(await page.getByTestId("tb-image-error").innerText()).includes("5MB")) throw new Error("big not refused");
  if (uploads.length) throw new Error("uploaded a refused file");
});

await step("T2 a 2.7MB PNG uploads in chunks, is checked, and shows in both previews", async () => {
  await file.setInputFiles(`${IMG}/mid.png`);
  await page.getByTestId("tb-image-ready").waitFor();
  if (uploads.length < 3) throw new Error(`expected ≥3 chunks, got ${uploads.length}`);
  const src = await page.getByTestId("tb-image-preview").getAttribute("src");
  if (!src?.startsWith("/api/media/")) throw new Error(`preview src ${src}`);
  const ok = await page.evaluate(async (s) => (await fetch(s)).status, src); if (ok !== 200) throw new Error(`preview ${ok}`);
  await page.getByTestId("wa-preview-image").waitFor();
  await page.screenshot({ path: `${OUT}/tpl-image-uploaded.png` });
});

await step("T3 replace, then remove", async () => {
  const before = await page.getByTestId("tb-image-preview").getAttribute("src");
  await file.setInputFiles(`${IMG}/hero2.png`);
  await page.waitForFunction((s) => { const el = document.querySelector('[data-testid="tb-image-preview"]'); return el && el.getAttribute("src") !== s && el.getAttribute("src").startsWith("/api/media/"); }, before);
  await page.getByTestId("tb-image-ready").waitFor();
  // The replaced image is deleted in the background – poll the server (no browser cache).
  let oldStatus = 0; for (let i = 0; i < 20 && oldStatus !== 404; i++) { oldStatus = await page.evaluate(async (s) => (await fetch(s, { cache: "no-store" })).status, before); if (oldStatus !== 404) await page.waitForTimeout(500); }
  if (oldStatus !== 404) throw new Error(`replaced image still served (${oldStatus})`);
  await page.getByTestId("tb-image-remove").click();
  await page.getByTestId("tb-image-pick").waitFor();
});

await step("T4 phone 390px with an image – no horizontal overflow", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await file.setInputFiles(`${IMG}/hero.png`);
  await page.getByTestId("tb-image-ready").waitFor();
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1); if (over) throw new Error("horizontal overflow");
  await page.screenshot({ path: `${OUT}/tpl-image-mobile.png` });
  await page.getByTestId("tb-image-remove").click();
  await page.setViewportSize({ width: 1400, height: 950 });
});

await step("T5 connection screen: real state, nothing shown as connected untested", async () => {
  await page.goto(`${BASE}/settings/whatsapp`);
  const body = await page.locator("main, body").first().innerText();
  if (!/חיבור וואטסאפ/.test(body)) throw new Error("no connection screen");
  if (/מחובר ופעיל/.test(body) && !/meta_whatsapp/.test(body)) throw new Error("shows connected without a Meta connection");
  await page.screenshot({ path: `${OUT}/wa-connection.png`, fullPage: true });
});
await b.close(); console.log(results.join("\n"));

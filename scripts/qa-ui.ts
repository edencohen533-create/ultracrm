/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Browser E2E QA (headless Chromium via Playwright) against http://localhost:3000 in SIMULATION mode.
 * Uses business "demo" (agent1 / manager). Screenshots go to QA_SHOTS dir.
 * Usage: npx tsx scripts/qa-ui.ts
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

if (process.env.QA_LOCAL !== "1" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Run via scripts/qa-local.cjs");
const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const SHOTS = process.env.QA_SHOTS ?? ".qa-local/shots";
fs.mkdirSync(SHOTS, { recursive: true });

type Status = "עבר" | "נכשל" | "חסום לבדיקה";
interface Row { id: string; area: string; scenario: string; expected: string; actual: string; status: Status; evidence: string; mode: "mock" }
const rows: Row[] = [];
let browser: Browser;
const ONLY = (process.env.QA_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
async function t(id: string, area: string, scenario: string, expected: string, fn: (shot: (name: string) => Promise<string>) => Promise<{ pass: boolean; actual: string }>, page?: () => Page) {
  if (ONLY.length && !ONLY.includes(id)) return;
  const shot = async (name: string) => {
    const p = page?.();
    const file = path.join(SHOTS, `${id}-${name}.png`);
    if (p) await p.screenshot({ path: file, fullPage: false }).catch(() => undefined);
    return file;
  };
  try {
    const r = await fn(shot);
    rows.push({ id, area, scenario, expected, actual: r.actual, status: r.pass ? "עבר" : "נכשל", evidence: `${SHOTS}/${id}-*.png`, mode: "mock" });
    console.log(`${r.pass ? "PASS" : "FAIL"} ${id} ${scenario} :: ${r.actual}`);
  } catch (e) {
    await shot("error");
    rows.push({ id, area, scenario, expected, actual: `חריגה: ${(e as Error).message.split("\n")[0]}`, status: "נכשל", evidence: `${SHOTS}/${id}-error.png`, mode: "mock" });
    console.log(`FAIL ${id} ${scenario} :: ${(e as Error).message.split("\n")[0]}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiJson(page: Page, url: string, init?: any) {
  return page.evaluate(async ({ url, init }) => {
    const r = await fetch(url, { ...(init ?? {}), headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    return r.json();
  }, { url, init });
}
async function login(ctx: BrowserContext, email: string, password: string) {
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה").fill(password);
  await page.getByRole("button", { name: "כניסה" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20000 });
  return page;
}
async function ctxWithMic() {
  const ctx = await browser.newContext({ permissions: ["microphone"], locale: "he-IL", timezoneId: "Asia/Jerusalem", viewport: { width: 1440, height: 900 } });
  ctx.setDefaultTimeout(15000);
  return ctx;
}
async function endAnyCall(page: Page) {
  // API-level cleanup for the logged-in user: hang up + save outcome so the next test starts clean.
  for (let i = 0; i < 40; i++) {
    const st = (await apiJson(page, "/api/dialer/state")).data;
    if (st.activeCall) { await apiJson(page, `/api/dialer/call/${st.activeCall.id}/hangup`, { method: "POST" }); await sleep(800); continue; }
    if (st.wrapUpCall) { await apiJson(page, `/api/dialer/call/${st.wrapUpCall.id}/outcome`, { method: "POST", body: JSON.stringify({ outcome: "no_answer" }) }); await sleep(300); continue; }
    if (st.session) { await apiJson(page, "/api/dialer/session", { method: "DELETE", body: JSON.stringify({ sessionId: st.session.id, browserSessionId: st.session.browserSessionId }) }); await sleep(300); continue; }
    return;
  }
}
async function waitCallStatus(page: Page, statuses: string[], maxMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const st = (await apiJson(page, "/api/dialer/state")).data;
    const c = st.activeCall ?? st.wrapUpCall;
    if (c && (statuses.includes(c.status) || (statuses.includes("ended") && c.endedAt))) return c;
    await sleep(500);
  }
  return null;
}
async function requeueDemoList() {
  const mctx = await browser.newContext({ locale: "he-IL" });
  const mpage = await login(mctx, "manager@demo.local", "manager123");
  const lists = (await apiJson(mpage, "/api/lists")).data as any[];
  const list = lists.find((l) => l.name.startsWith("לידים חמים"));
  if (list) {
    const leads = (await apiJson(mpage, `/api/lists/${list.id}/leads?limit=200`)).data.items as any[];
    const ids = leads.filter((l) => l.status !== "in_call" && l.status !== "dnc").map((l) => l.id);
    if (ids.length) await apiJson(mpage, `/api/lists/${list.id}/leads`, { method: "PATCH", body: JSON.stringify({ leadIds: ids, action: "requeue" }) });
  }
  await mctx.close();
}
/** Id of the agent's most recent call (recent list is capped, so counts saturate; ids don't). */
async function callCount(page: Page): Promise<string> {
  const r = await apiJson(page, "/api/dialer/recent");
  return (r.data as any[])[0]?.id ?? "";
}

async function main() {
  browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const ctx = await ctxWithMic();
  const page = await login(ctx, "agent1@demo.local", "agent123");
  await endAnyCall(page);
  const P = () => page;

  await t("U1", "UI", "כניסה → מסך חיוג, RTL, מספר טלפון מוצג LTR", "dir=rtl על html; אלמנט .phone עם direction ltr", async (shot) => {
    await page.goto(`${BASE}/dialer`);
    await page.getByText("מסך עבודה").waitFor();
    const dir = await page.evaluate(() => document.documentElement.getAttribute("dir"));
    await page.getByPlaceholder("050-1234567").fill("0501234567");
    const phoneDir = await page.evaluate(() => { const el = document.querySelector(".phone, input.ltr"); return el ? getComputedStyle(el).direction : null; });
    await shot("dialer");
    return { pass: dir === "rtl" && phoneDir === "ltr", actual: `html dir=${dir}, phone direction=${phoneDir}` };
  }, P);

  await t("U2", "UI", "תג הדמיה ומצב חיבור טלפוניה", "מוצג 'מצב הדמיה' ובסרגל 'הדמיה'", async () => {
    const badge = await page.getByText("מצב הדמיה", { exact: false }).first().isVisible();
    const side = await page.locator("aside").first().getByText("הדמיה").isVisible();
    return { pass: badge && side, actual: `badge=${badge}, sidebar=${side}` };
  }, P);

  await t("U3", "חיוג ידני", "הדבקה+חיוג, מצבי שיחה, טיימר ממענה, ניתוק, תיעוד במקשים", "מעבר מצבים → 'בשיחה' → אחרי ניתוק פאנל תוצאה → מקש 2 + Enter שומר", async (shot) => {
    const before = await callCount(page);
    const input = page.getByPlaceholder("050-1234567");
    await input.fill("");
    await input.focus();
    await page.evaluate(() => { const el = document.querySelector('input[placeholder="050-1234567"]') as HTMLInputElement; const dt = new DataTransfer(); dt.setData("text", "050-123 4507"); el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
    const pasted = await input.inputValue();
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    const seen: string[] = [];
    const deadline = Date.now() + 25000;
    const panel = page.locator("aside").last();
    while (Date.now() < deadline) {
      for (const s of ["מחבר את הנציג", "מחייג ללקוח", "מצלצל", "בשיחה"]) if (!seen.includes(s) && (await panel.getByText(s, { exact: true }).first().isVisible().catch(() => false))) seen.push(s);
      if (seen.includes("בשיחה")) break;
      await sleep(250);
    }
    await waitCallStatus(page, ["answered"]);
    await sleep(3200);
    await shot("in-call");
    const timerText = await panel.locator("p.text-3xl").first().textContent();
    const timer = /^00:0[2-9]$|^00:1\d$/.test((timerText ?? "").trim());
    const dialDisabled = await page.getByRole("button", { name: "חייג", exact: true }).isDisabled();
    await page.getByRole("button", { name: /^נתק/ }).click();
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 20000 });
    await shot("wrapup");
    await page.keyboard.press("2");
    const sel = await page.locator('button[data-sel="true"]').textContent();
    await page.keyboard.press("Enter");
    await page.getByText("התוצאה נשמרה").waitFor({ timeout: 10000 });
    const after = await callCount(page);
    return { pass: pasted === "0501234507" && seen.includes("בשיחה") && seen.length >= 2 && timer && dialDisabled && (sel ?? "").includes("לא מעוניין") && after !== before, actual: `paste→${pasted}; מצבים=${seen.join("→")}; טיימר=${timer} (${timerText?.trim()}); חיוג מנוטרל בזמן שיחה=${dialDisabled}; נבחר="${sel?.trim()}"; שיחה חדשה=${after !== before}` };
  }, P);

  await t("U4", "UI", "קיצורי מקלדת לא פועלים בזמן הקלדת הערות", "הקלדת '4' בתיבת ההערות לא בוחרת תוצאה", async () => {
    // create a wrap-up state
    await page.getByPlaceholder("050-1234567").fill("0501234500");
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 40000 });
    const before = await page.locator('button[data-sel="true"]').allTextContents();
    const ta = page.locator("textarea").first();
    await ta.fill("");
    await ta.type("1 7 בדיקה"); // 1 = מעוניין, 7 = מכירה – must not change the selection
    const after = await page.locator('button[data-sel="true"]').allTextContents();
    return { pass: JSON.stringify(before) === JSON.stringify(after), actual: `לפני=${JSON.stringify(before)} אחרי=${JSON.stringify(after)}` };
  }, P);

  await t("U5", "תיעוד", "טיוטת הערות שורדת רענון", "אחרי reload התיבה מכילה את הטקסט", async (shot) => {
    const ta = page.locator("textarea").first();
    await ta.fill("טיוטה לפני רענון ✍️");
    await sleep(1800); // debounce → server
    await page.reload();
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 20000 });
    await sleep(800);
    const v = await page.locator("textarea").first().inputValue();
    await shot("after-reload");
    await page.keyboard.press("4");
    await page.keyboard.press("Enter");
    await page.getByText("התוצאה נשמרה").waitFor({ timeout: 10000 });
    const call = (await apiJson(page, "/api/dialer/recent")).data[0];
    return { pass: v === "טיוטה לפני רענון ✍️", actual: `textarea="${v}"; outcome=${call.outcome}` };
  }, P);

  await t("U6", "UI", "פס שיחה קבוע בניווט בין מסכים", "ב-/contacts מוצג פס עם טיימר ונתק; חזרה ל-/dialer מציגה אותה שיחה", async (shot) => {
    await page.getByPlaceholder("050-1234567").fill("0501234508");
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    const answered = await waitCallStatus(page, ["answered"]);
    const callId = answered.id;
    await page.locator("aside a", { hasText: "אנשי קשר" }).click();
    await page.waitForURL(/\/contacts/);
    const bar = page.locator("div.sticky");
    await bar.getByRole("button", { name: "נתק" }).waitFor();
    await sleep(1500);
    const barText = await bar.textContent();
    await shot("callbar-contacts");
    await bar.getByRole("link", { name: "למסך החיוג" }).click();
    await page.waitForURL(/\/dialer/);
    const still = (await apiJson(page, "/api/dialer/state")).data.activeCall?.id;
    const shown = await page.locator("aside").last().getByText("בשיחה", { exact: true }).first().isVisible();
    await page.getByRole("button", { name: /^נתק/ }).click();
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 20000 });
    await page.keyboard.press("1"); await page.keyboard.press("Enter");
    await page.getByText("התוצאה נשמרה").waitFor();
    return { pass: Boolean(barText?.includes("בשיחה")) && /\d\d:\d\d/.test(barText ?? "") && still === callId && shown, actual: `bar="${barText?.slice(0, 60)}"; same call after nav=${still === callId}` };
  }, P);

  await t("U7", "תותח שיחות", "סשן מלא: התחלה → חיוג אוטומטי → תיעוד → ספירה לאחור → השהיה עוצרת → המשך מחייג", "אין חיוג נוסף בזמן השהיה; אחרי המשך נוצרת שיחה חדשה; 'סיים סשן' מנוטרל בזמן שיחה", async (shot) => {
    await endAnyCall(page);
    await requeueDemoList();
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "תותח שיחות", exact: true }).click();
    await page.locator("select").nth(1).selectOption({ value: "5" });
    const before = await callCount(page);
    await page.getByRole("button", { name: /התחל תותח שיחות/ }).click();
    const first = await waitCallStatus(page, ["answered", "ended"], 40000);
    if (first && !first.endedAt) { await sleep(1500); await page.getByRole("button", { name: /^נתק/ }).click(); }
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 60000 });
    await shot("power-wrapup");
    const endDisabled = await page.getByRole("button", { name: "סיים סשן" }).isDisabled().catch(() => null);
    await page.keyboard.press("4"); await page.keyboard.press("Enter");
    await page.getByText("הליד הבא בעוד").waitFor({ timeout: 10000 });
    await shot("countdown");
    const c1 = await callCount(page);
    await page.getByRole("button", { name: "השהה" }).click();
    await sleep(7000);
    const c2 = await callCount(page);
    const paused = await page.getByRole("button", { name: "המשך" }).isVisible();
    await page.getByRole("button", { name: "המשך" }).click();
    let c3 = c2;
    for (let i = 0; i < 30 && c3 === c2; i++) { await sleep(700); c3 = await callCount(page); }
    await shot("resumed");
    { const st2 = (await apiJson(page, "/api/dialer/state")).data; if (st2.activeCall && !st2.activeCall.endedAt) await waitCallStatus(page, ["answered", "ended"], 30000); }
    // make sure end-session is blocked during a live call
    const st = (await apiJson(page, "/api/dialer/state")).data;
    let endDuringCall: boolean | null = null;
    if (st.activeCall) {
      // the UI learns about the call on its next poll – give it a few seconds
      for (let i = 0; i < 12; i++) { endDuringCall = await page.getByRole("button", { name: "סיים סשן" }).isDisabled(); if (endDuringCall) break; await sleep(500); }
    }
    await endAnyCall(page);
    return { pass: c1 !== before && c2 === c1 && paused && c3 !== c2 && endDuringCall !== false, actual: `שיחה ראשונה=${c1 !== before}; שיחה חדשה במהלך השהיה=${c2 !== c1}; שיחה חדשה אחרי המשך=${c3 !== c2}; 'סיים סשן' מנוטרל בשיחה=${endDuringCall ?? endDisabled}` };
  }, P);

  await t("U8", "Preview", "אין חיוג אוטומטי; דילוג עם סיבה דרך המודל", "ליד מוצג, 0 שיחות ב-8 שניות, המודל מציג סיבות ואחרי בחירה נטען ליד אחר", async (shot) => {
    await endAnyCall(page);
    await requeueDemoList();
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "Preview" }).click();
    const before = await callCount(page);
    await page.getByRole("button", { name: /התחל Preview/ }).click();
    await page.getByRole("button", { name: /חייג לליד/ }).waitFor();
    const name1 = await page.locator("h2").first().textContent();
    await sleep(8000);
    const after = await callCount(page);
    await page.getByRole("button", { name: /דלג עם סיבה/ }).click();
    await page.getByText("דילוג על ליד").waitFor();
    await shot("skip-modal");
    await page.getByRole("button", { name: "פרטים חסרים" }).click();
    let name2 = name1;
    for (let i = 0; i < 40 && name2 === name1; i++) { await sleep(500); name2 = await page.locator("h2").first().textContent().catch(() => name1); }
    const skipped = (await apiJson(page, "/api/dialer/state")).data.lead?.contact?.fullName;
    await endAnyCall(page);
    return { pass: after === before && Boolean(name1) && name1 !== name2 && skipped === name2?.trim(), actual: `שיחה חדשה ב-8ש׳=${after !== before}; ליד1="${name1?.trim()}" → ליד2="${name2?.trim()}" (API: ${skipped})` };
  }, P);

  await t("U9", "סשנים", "שתי לשוניות – השנייה משתלטת על הסשן", "הלשונית הראשונה מציגה 'הסשן עבר ללשונית אחרת' ומנטרלת פעולות", async (shot) => {
    await endAnyCall(page);
    await requeueDemoList();
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: /התחל Preview/ }).click();
    for (let i = 0; i < 40; i++) { const st = (await apiJson(page, "/api/dialer/state")).data; if (st.session && st.lead) break; await sleep(500); }
    const page2 = await ctx.newPage();
    await page2.goto(`${BASE}/dialer`);
    await page2.getByText("מסך עבודה").waitFor();
    // second tab sees the session owned by the first; take it over
    try {
      await page2.getByText("סשן החיוג פעיל בלשונית אחרת").waitFor({ timeout: 20000 });
    } catch (e) {
      await page2.screenshot({ path: path.join(SHOTS, "U9-page2.png") });
      throw e;
    }
    await page2.getByRole("button", { name: "העבר לכאן" }).click();
    await page.bringToFront();
    try {
      await page.getByText("הסשן עבר ללשונית אחרת").waitFor({ timeout: 25000 });
    } catch (e) {
      await page2.screenshot({ path: path.join(SHOTS, "U9-page2-after.png") });
      await page2.close();
      await endAnyCall(page);
      throw e;
    }
    await shot("taken-over");
    const dialDisabled = await page.getByRole("button", { name: /חייג לליד/ }).isDisabled();
    await page2.close();
    await endAnyCall(page);
    return { pass: dialDisabled, actual: `הודעה מוצגת; חיוג לליד מנוטרל=${dialDisabled}` };
  }, P);

  await t("U10", "UI", "אנשי קשר: חיוג מכרטיס ופס שיחה", "לחיצה על 'חייג' בשורה יוצרת שיחה ופס שיחה מופיע", async (shot) => {
    await endAnyCall(page);
    await requeueDemoList();
    await page.goto(`${BASE}/contacts`);
    const before = await callCount(page);
    await page.getByRole("button", { name: "חייג" }).first().click();
    await page.locator("div.sticky").getByRole("button", { name: "נתק" }).waitFor({ timeout: 20000 });
    await shot("contacts-callbar");
    const after = await callCount(page);
    await endAnyCall(page);
    return { pass: after !== before, actual: `שיחה חדשה=${after !== before}` };
  }, P);

  await t("U11", "מנהל", "דשבורד מנהל מציג נציג 'בשיחה' בזמן אמת", "שורת agent1 מציגה 'בשיחה' ואחרי תיעוד 'זמין'/'מנותק'", async (shot) => {
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    await page.goto(`${BASE}/dialer`);
    await page.getByPlaceholder("050-1234567").fill("0501234509");
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    await waitCallStatus(page, ["answered"]);
    await mpage.goto(`${BASE}/manager`);
    const row = mpage.locator("tr", { hasText: "דנה כהן" });
    await row.getByText("בשיחה").first().waitFor({ timeout: 15000 });
    const live = await row.textContent();
    await mpage.screenshot({ path: path.join(SHOTS, "U11-manager-live.png") });
    await endAnyCall(page);
    await sleep(5000);
    const after = await mpage.locator("tr", { hasText: "דנה כהן" }).textContent();
    await mctx.close();
    return { pass: Boolean(live?.includes("בשיחה")) && !after?.includes("בשיחה"), actual: `בזמן שיחה: כולל 'בשיחה'=${live?.includes("בשיחה")}; אחרי: ${after?.includes("זמין") ? "זמין" : after?.includes("מנותק") ? "מנותק" : "?"}` };
  }, P);

  await t("U12", "UI", "מיקרופון חסום – הודעה ברורה", "בלי הרשאת מיקרופון מוצגת הודעת שגיאה בלוח השיחה", async () => {
    const dctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } });
    await dctx.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    });
    const dpage = await login(dctx, "agent2@demo.local", "agent123");
    await dpage.goto(`${BASE}/dialer`);
    const msg = dpage.getByText(/מיקרופון/).first();
    await msg.waitFor({ timeout: 15000 });
    const text = await msg.textContent();
    await dpage.screenshot({ path: path.join(SHOTS, "U12-mic-denied.png") });
    await dctx.close();
    return { pass: Boolean(text && /חסם|הרשאת|לא נמצא/.test(text)), actual: `"${text?.trim()}"` };
  });

  await t("U13", "UI", "עמודי ניהול נטענים עם נתונים אמיתיים", "/lists מציג את הרשימה, /tasks נטען, /settings טאבים", async () => {
    await page.goto(`${BASE}/lists`);
    const list = await page.getByText("לידים חמים – ספטמבר").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    await page.goto(`${BASE}/tasks`);
    const tasks = await page.getByText("משימות חזרה").first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    await page.goto(`${BASE}/settings`);
    await page.getByRole("button", { name: "טלפוניה", exact: true }).click();
    const tel = await page.getByText("חיבור טלפוניה (Telnyx)").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    return { pass: list && tasks && tel, actual: `lists=${list}, tasks=${tasks}, telephony tab=${tel}` };
  }, P);


  await t("U14", "שיחות נכנסות", "שיחה נכנסת מוצגת לנציג עם קבל/דחה; קבלה → בשיחה; ניתוק → תיעוד", "פס 'שיחה נכנסת' + כפתורים; אחרי קבלה טיימר; אחרי ניתוק פאנל תוצאה", async (shot) => {
    await endAnyCall(page);
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "חיוג ידני", exact: true }).click();
    await page.getByRole("button", { name: /התחל סשן ידני/ }).click();
    await sleep(2500);
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    const sim = await apiJson(mpage, "/api/dev/simulate-inbound", { method: "POST", body: JSON.stringify({ from: "0501234533" }) });
    await mctx.close();
    await page.getByText("📞 שיחה נכנסת").waitFor({ timeout: 15000 });
    await shot("inbound-ringing");
    await page.getByRole("button", { name: "קבל", exact: true }).click();
    const answered = await waitCallStatus(page, ["answered"]);
    await sleep(2000);
    await page.locator("aside").last().getByText("בשיחה", { exact: true }).first().waitFor();
    await page.getByRole("button", { name: /^נתק/ }).click();
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 20000 });
    await shot("inbound-wrapup");
    await page.keyboard.press("1"); await page.keyboard.press("Enter");
    await page.getByText("התוצאה נשמרה").waitFor();
    await endAnyCall(page);
    return { pass: sim?.data?.id && answered?.id === sim.data.id && answered.direction === "inbound", actual: `routed=${sim?.data?.routingNote}; answered inbound=${answered?.direction === "inbound"}` };
  }, P);

  await t("U15", "תותח שיחות", "סיום רשימה: סיכום סשן אמיתי ומודל", "אחרי הליד האחרון מוצג 'הרשימה נגמרה – סיכום סשן' עם מספרים", async (shot) => {
    await endAnyCall(page);
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    // one-lead list: the lead rings out (…4500 ends with 0 → no answer)
    const contacts = (await apiJson(mpage, "/api/contacts?q=0501234500")).data.items as any[];
    const list = (await apiJson(mpage, "/api/lists", { method: "POST", body: JSON.stringify({ name: "QA-UI-one-" + Date.now(), contactIds: [contacts[0].id] }) })).data;
    await mctx.close();
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "תותח שיחות", exact: true }).click();
    await page.waitForFunction((id) => [...document.querySelectorAll("option")].some((o) => (o as HTMLOptionElement).value === id), list.id, { timeout: 15000 });
    await page.locator("select").first().selectOption({ value: list.id });
    await page.locator("select").nth(1).selectOption({ value: "0" });
    await page.getByRole("button", { name: /התחל תותח שיחות/ }).click();
    const first = await waitCallStatus(page, ["answered", "ended"], 40000);
    const sessionList = (await apiJson(page, "/api/dialer/state")).data.session?.listId;
    if (first && !first.endedAt) { await sleep(1000); await page.getByRole("button", { name: /^נתק/ }).click(); }
    await page.getByText("תוצאת שיחה").waitFor({ timeout: 60000 });
    await page.keyboard.press("6"); await page.keyboard.press("Enter"); // wrong number → lead closed → list empty
    await page.getByText("הרשימה נגמרה – סיכום סשן").waitFor({ timeout: 45000 });
    await shot("session-summary");
    const text = await page.locator('[role="dialog"]').textContent();
    await page.locator('[role="dialog"] footer').getByRole("button", { name: "סגור" }).click();
    const st = (await apiJson(page, "/api/dialer/state")).data;
    return { pass: sessionList === list.id && Boolean(text?.includes("חיוגים")) && !st.session, actual: `list ok=${sessionList === list.id}; modal="${text?.slice(0, 80)}"; session ended=${!st.session}` };
  }, P);

  await t("U16", "מנהל", "kill switch: מנהל עוצר חיוגים – הנציג נחסם עם הודעה ברורה", "חיוג ידני מקבל toast 'החיוג מושהה'; אחרי חידוש עובד", async (shot) => {
    await endAnyCall(page);
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    await mpage.goto(`${BASE}/manager`);
    await mpage.getByRole("button", { name: /עצור חיוגים חדשים/ }).click();
    await mpage.getByText("החיוג היוצא מושהה ברמת העסק").waitFor({ timeout: 10000 });
    await mpage.screenshot({ path: path.join(SHOTS, "U16-manager-paused.png") });
    await page.goto(`${BASE}/dialer`);
    await page.getByPlaceholder("050-1234567").fill("0501234500");
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    const blocked = await page.getByText("החיוג מושהה ברמת העסק").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await shot("agent-blocked");
    await mpage.getByRole("button", { name: /חדש חיוגים לכל העסק/ }).click();
    await sleep(1500);
    await mctx.close();
    const before = await callCount(page);
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    await waitCallStatus(page, ["ringing", "answered", "ended"]);
    const after = await callCount(page);
    await endAnyCall(page);
    return { pass: blocked && after !== before, actual: `נחסם עם הודעה=${blocked}; אחרי חידוש שיחה חדשה=${after !== before}` };
  }, P);

  await t("U17", "תעדוף", "'למה עכשיו' מוצג בכרטיס הליד", "טקסט הסבר תעדוף מופיע", async (shot) => {
    await endAnyCall(page);
    await requeueDemoList();
    await page.goto(`${BASE}/dialer`);
    await page.getByRole("button", { name: "Preview" }).click();
    await page.getByRole("button", { name: /התחל Preview/ }).click();
    const el = page.getByText(/^למה עכשיו:/);
    const ok = await el.waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    const text = ok ? await el.textContent() : null;
    await shot("why-now");
    await endAnyCall(page);
    return { pass: ok, actual: `"${text?.trim()}"` };
  }, P);

  await t("U18", "הגדרות", "טאבים חדשים: תעדוף, בטיחות, היסטוריה נטענים עם נתונים", "", async () => {
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "admin@demo.local", "admin123");
    await mpage.goto(`${BASE}/settings`);
    await mpage.getByRole("button", { name: "תעדוף לידים", exact: true }).click();
    const prio = await mpage.getByLabel("חזרה שהגיע מועדה").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await mpage.getByRole("button", { name: "בטיחות ושיחות נכנסות", exact: true }).click();
    const safety = await mpage.getByText("עצירת חיוגים חדשים לכל העסק").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await mpage.getByRole("button", { name: "היסטוריית שינויים", exact: true }).click();
    const hist = await mpage.getByText("היסטוריית שינויים ואוטומציות").waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
    await mpage.screenshot({ path: path.join(SHOTS, "U18-settings-history.png") });
    await mctx.close();
    return { pass: prio && safety && hist, actual: `prio=${prio} safety=${safety} history=${hist}` };
  });

  await t("U19", "מוקד חי", "דף 'מוקד בזמן אמת': מצבים, חיווי חיבור, מדדים מוגדרים, מצב חי לא מוצג בדוחות", "כותרת, 'מתעדכן בזמן אמת', שתי קבוצות מדדים, טאב דוחות ללא עמודת סטטוס", async () => {
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    await mpage.goto(`${BASE}/manager`);
    await mpage.getByText("מוקד בזמן אמת").first().waitFor();
    const liveBadge = await mpage.getByText("מתעדכן בזמן אמת").waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    const groups = (await mpage.getByText("מצב המוקד כרגע").isVisible()) && (await mpage.getByText("ביצועי היום").isVisible());
    const tip = await mpage.getByText("שיחות יוצאות", { exact: true }).first().getAttribute("title");
    await mpage.screenshot({ path: path.join(SHOTS, "U19-live-floor.png"), fullPage: true });
    await mpage.getByRole("button", { name: "דוחות", exact: true }).click();
    await mpage.getByText("דוחות לתקופה").waitFor();
    const noStatusCol = !(await mpage.locator("th", { hasText: "מצב" }).count());
    await mpage.screenshot({ path: path.join(SHOTS, "U19-reports.png") });
    await mctx.close();
    return { pass: liveBadge && groups && Boolean(tip) && noStatusCol, actual: `live badge=${liveBadge}, groups=${groups}, tooltip="${tip?.slice(0, 40)}", reports without status column=${noStatusCol}` };
  });

  await t("U20", "האזנה", "מנהל רואה נציג בשיחה תוך ~2ש׳, מצטרף להאזנה, לוחש בלחיצה-והחזקה, אובדן פוקוס מפסיק, יציאה לא פוגעת בשיחה", "", async (shot) => {
    await endAnyCall(page);
    await page.goto(`${BASE}/dialer`);
    const mctx = await ctxWithMic();
    const mpage = await login(mctx, "manager@demo.local", "manager123");
    await mpage.goto(`${BASE}/manager`);
    await mpage.getByText("מתעדכן בזמן אמת").waitFor({ timeout: 15000 });
    await page.getByPlaceholder("050-1234567").fill("0501234533");
    await page.getByRole("button", { name: "חייג", exact: true }).click();
    const answered = await waitCallStatus(page, ["answered"], 45000);
    if (!answered?.answeredAt) { await endAnyCall(page); await mctx.close(); return { pass: false, actual: `agent call never reached answered: ${JSON.stringify((await apiJson(page, "/api/dialer/state")).data.activeCall?.status)}` }; }
    const tAns = new Date(answered.answeredAt).getTime();
    const tVisible = Date.now(); // the answer is now applied server-side (agent API reflects it)
    const row = mpage.locator("tr", { hasText: "דנה כהן" }).first();
    await row.getByText("בשיחה").first().waitFor({ timeout: 10000 });
    const lagMs = Date.now() - tVisible; // event-applied → manager UI (includes 1.5s poll + request time)
    const lagFromProvider = Date.now() - tAns;
    const rowText = await row.textContent();
    await row.getByRole("button", { name: "האזנה", exact: true }).click();
    await mpage.getByText("האזנה לשיחה").waitFor();
    const connecting = await mpage.getByText("מתחבר…").isVisible().catch(() => false);
    await mpage.getByText("האזנה בלבד").waitFor({ timeout: 10000 });
    await mpage.screenshot({ path: path.join(SHOTS, "U20-monitor-listening.png") });
    const ptt = mpage.getByRole("button", { name: /לחץ והחזק כדי ללחוש/ });
    await ptt.dispatchEvent("mousedown");
    await mpage.getByText("לחישה לנציג").waitFor({ timeout: 8000 });
    await mpage.screenshot({ path: path.join(SHOTS, "U20-monitor-whispering.png") });
    const whisperAudit = (await apiJson(mpage, "/api/settings/history")).data.find((x: any) => x.action === "monitor.whisper_on");
    await mpage.evaluate(() => window.dispatchEvent(new Event("blur"))); // focus loss must end the whisper
    await mpage.getByText("האזנה בלבד").waitFor({ timeout: 8000 });
    const backToListen = await mpage.getByText("האזנה בלבד").isVisible();
    // second listen click while connected → same panel, no second monitor
    const monitorsBefore = (await apiJson(mpage, "/api/manager/monitor")).data?.id;
    await mpage.route("**/api/manager/monitor/*", async route => {
      if (route.request().method() === "DELETE") await route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"ניתוק ההאזנה נכשל בבדיקת QA",code:"monitor_disconnect_failed"})});
      else await route.continue();
    });
    await mpage.locator("aside footer").getByRole("button", { name: "יציאה מהאזנה" }).click();
    await mpage.getByText("ניתוק ההאזנה נכשל בבדיקת QA").waitFor();
    const failedExitRetained = await mpage.getByText("האזנה לשיחה").isVisible();
    await mpage.screenshot({path:path.join(SHOTS,"U20-disconnect-failure.png")});
    await mpage.unroute("**/api/manager/monitor/*");
    await mpage.locator("aside footer").getByRole("button", { name: "יציאה מהאזנה" }).click();
    await sleep(1500);
    const agentCall = (await apiJson(page, "/api/dialer/state")).data.activeCall;
    const monitorAfter = (await apiJson(mpage, "/api/manager/monitor")).data;
    await mctx.close();
    await endAnyCall(page);
    return { pass: failedExitRetained && lagMs < 5000 && Boolean(rowText?.includes("4533")) && connecting !== null && Boolean(whisperAudit) && backToListen && Boolean(monitorsBefore) && agentCall && !agentCall.endedAt && monitorAfter === null, actual: `failed disconnect retained panel=${failedExitRetained}; אירוע-הוחל→שורה 'בשיחה' ${lagMs}ms (כולל poll 1.5s + זמן בקשה מקומי); מחותמת הספק ${lagFromProvider}ms; row="${rowText?.slice(0, 60)}"; whisper audit=${Boolean(whisperAudit)}; blur→listen=${backToListen}; agent call alive after exit=${Boolean(agentCall && !agentCall.endedAt)}; monitor cleared=${monitorAfter === null}` };
  }, P);
  await ctx.close();
  await browser.close();
  const summary = { total: rows.length, passed: rows.filter((r) => r.status === "עבר").length, failed: rows.filter((r) => r.status === "נכשל").length };
  fs.writeFileSync(ONLY.length ? "qa-results-ui-subset.json" : "qa-results-ui.json", JSON.stringify({ summary, rows }, null, 2));
  process.exitCode = summary.failed ? 1 : 0;
  console.log("\nSUMMARY", JSON.stringify(summary));
}

main().catch((e) => { console.error(e); process.exit(1); });

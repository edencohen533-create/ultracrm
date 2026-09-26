/** Browser + live-endpoint QA for abandoned carts on production (a WooCommerce test store, deleted at the end). */
import crypto from "node:crypto";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', "manager@demo.local"); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
let store;
await step("C1 menu → עגלות נטושות; connect a WooCommerce store; setup shows script + webhook URL + secret", async () => {
  await page.click('[data-testid="nav-carts"]'); await page.waitForURL((u) => u.pathname === "/carts"); await page.waitForSelector('[data-testid="carts-screen"]');
  await page.click('[data-testid="store-connect"]'); await page.click('[data-testid="platform-woocommerce"]'); await page.fill('[data-testid="store-name"]', `QA Woo ${Date.now()}`);
  await page.click('[data-testid="store-create"]'); await page.waitForSelector('[data-testid="store-snippet"]');
  const snippet = await page.textContent('[data-testid="store-snippet"]'); const url = await page.textContent('[data-testid="store-webhook-url"]'); const secret = await page.textContent('[data-testid="store-webhook-secret"]');
  if (!snippet.includes("/api/track/") || !url.includes("/api/webhooks/stores/woocommerce/") || secret.length < 20) throw new Error("setup incomplete");
  store = { id: url.split("/").pop(), secret, key: snippet.match(/track\/([^/]+)\/script/)[1] };
  await page.screenshot({ path: "docs/qa/carts-setup.png" });
});
await step("C2 live endpoints: script served, signed WooCommerce webhook creates a cart, unsigned rejected", async () => {
  const js = await fetch(`${BASE}/api/track/${store.key}/script`); if (!js.ok || !(await js.text()).includes("wc/store/v1/cart")) throw new Error(`script ${js.status}`);
  const body = JSON.stringify({ id: 9001, number: "9001", status: "pending", currency: "ILS", total: "150.00", payment_url: "https://woo.example.com/checkout/order-pay/9001/", billing: { first_name: "בדיקה", last_name: "QA", email: `qa${Date.now()}@example.test`, phone: "0507770001" }, line_items: [{ name: "מוצר בדיקה", quantity: 1, price: 150 }] });
  const bad = await fetch(`${BASE}/api/webhooks/stores/woocommerce/${store.id}`, { method: "POST", body }); if (bad.status !== 401) throw new Error(`unsigned ${bad.status}`);
  const sig = crypto.createHmac("sha256", store.secret).update(body).digest("base64");
  const ok = await fetch(`${BASE}/api/webhooks/stores/woocommerce/${store.id}`, { method: "POST", body, headers: { "x-wc-webhook-signature": sig, "x-wc-webhook-topic": "order.created" } }); if (!ok.ok) throw new Error(`signed ${ok.status}`);
  const ev = await fetch(`${BASE}/api/track/${store.key}/events`, { method: "POST", body: JSON.stringify({ type: "cart", externalId: "qa_web_1", phone: "0507770002", total: 42, currency: "ILS", items: [{ name: "גרביים", quantity: 1, price: 42 }] }), headers: { "Content-Type": "text/plain" } }); if (ev.status !== 204) throw new Error(`track ${ev.status}`);
});
await step("C3 the carts appear on the screen with customer, items, total and a cart link", async () => {
  await page.goto(`${BASE}/carts`); await page.waitForSelector("text=מוצר בדיקה", { timeout: 60000 }); await page.waitForSelector("text=גרביים");
  await page.waitForSelector("a:has-text('קישור לעגלה')"); await page.screenshot({ path: "docs/qa/carts-list.png" });
});
await step("C4 'מסע שחזור עגלה' opens the journey builder with the 'עגלה ננטשה' trigger", async () => {
  await page.click('[data-testid="carts-journey"]'); await page.waitForSelector('[data-testid="journey-builder"]');
  if ((await page.inputValue('[data-testid="journey-trigger-select"]').catch(async () => { await page.click('[data-testid="journey-trigger"]'); return page.inputValue('[data-testid="journey-trigger-select"]'); })) !== "CART_ABANDONED") throw new Error("trigger not preselected");
  await page.screenshot({ path: "docs/qa/carts-journey.png" });
});
await step("C5 cleanup: disconnect the test store (its carts are removed)", async () => { const r = await api(`/api/stores/${store.id}`, "DELETE"); if (r.status !== 200) throw new Error(String(r.status)); });
await b.close(); console.log(results.join("\n"));

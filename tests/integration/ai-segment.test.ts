/**
 * Segments from real purchases + the AI segment builder (real DB; the model is stubbed – no real AI call).
 * The example: "bought probiotics in the last 14 days and a week later bought another product".
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, afterEach, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { previewAudience, listAudienceWhere } from "@/server/services/audience-service";
import { upsertStoreOrder, type OrderSnapshot } from "@/server/services/store-order-service";
import { draftSegment } from "@/server/ai/segment-builder";
import type { AudienceNode } from "@/lib/audiences";

let A: Awaited<ReturnType<typeof createBusiness>>, B: Awaited<ReturnType<typeof createBusiness>>;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const DAY = 86400_000; const ago = (d: number) => new Date(Date.now() - d * DAY);
let n = 0;
const person = async (biz = A) => { n++; const p = `+97254${String(1000000 + n).slice(-7)}`; return db.contact.create({ data: { businessId: biz.business.id, fullName: `קונה ${n}`, phoneE164: p, phoneRaw: p } }); };
const buy = (biz: typeof A, c: { phoneE164: string }, daysAgo: number, items: OrderSnapshot["items"], status: OrderSnapshot["status"] = "completed") =>
  run(biz.session, () => upsertStoreOrder(biz.business.id, "api", { externalId: crypto.randomUUID(), orderNumber: `#${++n}`, status, phone: c.phoneE164, placedAt: ago(daysAgo).toISOString(), items }));
const item = (name: string, extra: Partial<NonNullable<OrderSnapshot["items"]>[number]> = {}) => ({ key: crypto.randomUUID(), name, quantity: 1, kind: "product" as const, ...extra });
const SEQ: AudienceNode = { operator: "AND", conditions: [{ field: "purchaseSequence", first: { products: ["פרוביוטיקה"], withinDays: 14 }, then: { products: [], otherThanFirst: true, minDaysAfter: 7 } }] };
const ids: Record<string, string> = {};

describe("purchase segments + AI builder", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("seg-a", { modules: { crm: true, messaging: true } }); B = await createBusiness("seg-b", { modules: { crm: true, messaging: true } });
    accounts.push(A.account.id, B.account.id);
    const a = await person(); await buy(A, a, 10, [item("פרוביוטיקה 30 כמוסות")]); await buy(A, a, 2, [item("מגנזיום")]); ids.match_order = a.id;           // 8 days later → in
    const b = await person(); await buy(A, b, 10, [item("פרוביוטיקה")]); await buy(A, b, 5, [item("מגנזיום")]); ids.too_soon = b.id;                        // 5 days later → out
    const c = await person(); await buy(A, c, 20, [item("פרוביוטיקה")]); await buy(A, c, 5, [item("מגנזיום")]); ids.first_too_old = c.id;                   // first 20 days ago → out
    const d = await person(); await buy(A, d, 12, [item("פרוביוטיקה")]); await buy(A, d, 3, [item("פרוביוטיקה")]); ids.same_product = d.id;                 // same product again → out
    const e = await person(); // phone sale with items (deal) then a store order
    const deal = await db.deal.create({ data: { businessId: A.business.id, contactId: e.id, title: "מכירה", amount: 200, status: "won", stage: "won", closedAt: ago(13) } });
    await db.dealItem.create({ data: { businessId: A.business.id, dealId: deal.id, contactId: e.id, name: "פרוביוטיקה", quantity: 1, unitPrice: 200, startsAt: ago(13) } });
    await buy(A, e, 2, [item("ויטמין C")]); ids.match_deal = e.id;
    const f = await person(); await buy(A, f, 11, [item("מארז בריאות", { kind: "bundle", components: [{ name: "פרוביוטיקה", quantity: 1 }, { name: "אומגה 3", quantity: 1 }] })]); await buy(A, f, 1, [item("מגנזיום")]); ids.match_bundle = f.id;
    const g = await person(); await buy(A, g, 10, [item("פרוביוטיקה")], "cancelled"); await buy(A, g, 2, [item("מגנזיום")]); ids.cancelled = g.id;           // cancelled first → out
    const h = await person(B); await buy(B, h, 10, [item("פרוביוטיקה")]); await buy(B, h, 2, [item("מגנזיום")]); ids.other_business = h.id;                // other business → never in A
  }, 900_000);
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.ANTHROPIC_API_KEY; });
  afterAll(async () => { if (A) await destroyBusiness(A.business.id); if (B) await destroyBusiness(B.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  const members = async (segment: AudienceNode) => run(A.session, async () => { const list = { id: "x", segment: segment as never }; return (await db.contact.findMany({ where: await listAudienceWhere(db as never, list, new Date()), select: { id: true } })).map((c) => c.id).sort(); });

  it("the example: probiotics in the last 14 days, then another product at least a week later", async () => {
    expect(await members(SEQ)).toEqual([ids.match_order, ids.match_deal, ids.match_bundle].sort());
    expect(await run(A.session, () => previewAudience({ segment: SEQ, marketing: false }))).toMatchObject({ matched: 3 });
  });

  it("purchase / no purchase with a window; the other business is never counted", async () => {
    const bought = await members({ operator: "AND", conditions: [{ field: "purchase", operator: "did", products: ["מגנזיום"], withinDays: 3 }] });
    expect(bought.sort()).toEqual([ids.match_order, ids.match_bundle, ids.cancelled].sort());
    const never = await members({ operator: "AND", conditions: [{ field: "purchase", operator: "did_not", products: ["פרוביוטיקה"] }] });
    expect(never).toContain(ids.cancelled); expect(never).not.toContain(ids.match_bundle); expect(never).not.toContain(ids.other_business);
    const inB = await run(B.session, async () => (await db.contact.findMany({ where: await listAudienceWhere(db as never, { id: "x", segment: SEQ as never }, new Date()), select: { id: true } })).map((c) => c.id));
    expect(inB).toEqual([ids.other_business]);
  });

  describe("AI builder (model stubbed)", () => {
    const stub = (answers: Array<Record<string, unknown>>) => {
      const queue = [...answers]; const seen: Array<{ system: string; messages: unknown }> = []; process.env.ANTHROPIC_API_KEY = "test-key-not-real";
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        if (!String(url).includes("/v1/messages")) throw new Error(`unexpected fetch ${url}`);
        const body = JSON.parse(String(init.body)); seen.push({ system: body.system, messages: body.messages });
        return new Response(JSON.stringify({ content: [{ type: "tool_use", id: `tu_${crypto.randomUUID()}`, name: "build_segment", input: queue.shift() }], stop_reason: "tool_use" }), { status: 200 });
      }));
      return seen;
    };
    const ask = (prompt: string) => run(A.session, () => draftSegment({ businessId: A.business.id, userId: A.session.id, prompt }));

    it("free text → validated draft with its interpretation and live count; nothing is saved", async () => {
      const lists = await db.distributionList.count({ where: { businessId: A.business.id } });
      const seen = stub([{ name: "פרוביוטיקה ואז מוצר נוסף", explanation: "רכשו פרוביוטיקה ב-14 הימים האחרונים, ולפחות 7 ימים אחרי כן רכשו מוצר אחר", assumptions: ["'אחרי שבוע' = לפחות 7 ימים אחרי הרכישה הראשונה"], unsupported: [], segment: SEQ.conditions[0] }]);
      const d = await ask("תבנה לי קהל של אנשים שרכשו פרוביוטיקה ב14 ימים האחרונים ואחרי שבוע רכשו מוצר נוסף");
      expect(d).toMatchObject({ matched: 3, segment: SEQ });
      expect(d.assumptions[0]).toContain("7 ימים");
      expect(seen[0].system).toContain("פרוביוטיקה 30 כמוסות"); // the business's real product names
      expect(seen[0].system).not.toContain(ids.other_business);
      expect(await db.distributionList.count({ where: { businessId: A.business.id } })).toBe(lists);
    });

    it("an invalid answer gets one correction round with the exact error", async () => {
      const seen = stub([{ name: "x", explanation: "x", segment: { field: "purchasedWithin", value: 14 } }, { name: "תקין", explanation: "x", segment: SEQ }]);
      const d = await ask("פרוביוטיקה ואחר כך משהו אחר");
      expect(d.matched).toBe(3);
      expect(JSON.stringify(seen[1].messages)).toContain("הטיוטה נדחתה");
    });

    it("a reference outside this business is refused – never a guessed segment", async () => {
      const foreign = await db.tag.create({ data: { businessId: B.business.id, name: "VIP-B" } });
      stub([{ name: "x", explanation: "x", segment: { field: "tag", operator: "is", value: foreign.id } }, { name: "x", explanation: "x", segment: { field: "tag", operator: "is", value: foreign.id } }]);
      await expect(ask("לקוחות VIP")).rejects.toMatchObject({ status: 422 });
    });

    it("no model connection → a clear message, no draft", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await expect(ask("כל מי שרכש החודש")).rejects.toMatchObject({ status: 409 });
    });
  });
});

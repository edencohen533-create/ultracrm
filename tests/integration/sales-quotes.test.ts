import { beforeEach, afterEach, it, expect } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import {
  saveOffer,
  createQuote,
  quoteAction,
  publicQuote,
  acceptQuote,
  listSales,
} from "@/server/sales/quotes";
let a: Awaited<ReturnType<typeof createBusiness>>,
  b: Awaited<ReturnType<typeof createBusiness>>,
  leadId: string,
  offerId: string;
const run = <T>(f: () => Promise<T>) =>
  withBusiness(a.business.id, f, a.session);
const draft = (extra = {}) => ({
  leadId,
  title: "הצעת בדיקה",
  terms: "תנאים",
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  lines: [{ offerId, quantity: 2, discountBps: 1000 }],
  ...extra,
});
beforeEach(async () => {
  a = await createBusiness("quotes", { modules: { crm: true } });
  b = await createBusiness("other-quotes", { modules: { crm: true } });
  const c = await db.contact.create({
    data: {
      businessId: a.business.id,
      fullName: "Quote buyer",
      phoneE164: "+972550000123",
      phoneRaw: "qa",
      ownerUserId: a.user.id,
    },
  });
  leadId = (
    await db.lead.create({
      data: {
        businessId: a.business.id,
        contactId: c.id,
        ownerUserId: a.user.id,
      },
    })
  ).id;
  offerId = (
    await run(() =>
      saveOffer(a.session, {
        name: "מסלול",
        unitAmount: 10000,
        unitCost: 3000,
        taxBps: 1800,
        maxDiscountBps: 500,
      }),
    )
  ).id;
});
afterEach(async () => {
  await destroyBusiness(a.business.id, [a.account.id]);
  await destroyBusiness(b.business.id, [b.account.id]);
});
it("server-calculated totals require manager approval for excessive discounts", async () => {
  const q = await run(() => createQuote(a.session, draft()));
  expect(q).toMatchObject({
    subtotal: 18000,
    tax: 3240,
    total: 21240,
    status: "pending_approval",
  });
  await expect(
    run(() => quoteAction(a.session, q.id, "share")),
  ).rejects.toMatchObject({ code: "state" });
  await run(() => quoteAction(a.session, q.id, "approve"));
  expect((await run(() => quoteAction(a.session, q.id, "share"))).path).toMatch(
    /^\/offer\//,
  );
});
it("shared view contains snapshot prices, no customer or internal cost data; acceptance is once only", async () => {
  const q = await run(() =>
    createQuote(a.session, draft({ lines: [{ offerId, quantity: 1 }] })),
  );
  const link = await run(() => quoteAction(a.session, q.id, "share"));
  const token = link.path!.split("/").pop()!;
  await run(() =>
    saveOffer(
      a.session,
      { name: "Changed", unitAmount: 50000, unitCost: 9000 },
      offerId,
    ),
  );
  const view = await publicQuote(token);
  expect(view.total).toBe(11800);
  expect(JSON.stringify(view)).not.toContain("unitCost");
  expect(JSON.stringify(view)).not.toContain("Quote buyer");
  const results = await Promise.allSettled([
    acceptQuote(token, { name: "לקוח", revision: 1, agree: true }),
    acceptQuote(token, { name: "לקוח", revision: 1, agree: true }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect((await publicQuote(token)).status).toBe("accepted");
  await expect(
    run(() => quoteAction(a.session, q.id, "revoke")),
  ).rejects.toMatchObject({ code: "accepted" });
});
it("new shared revision invalidates the prior link and cannot reuse the old approval", async () => {
  const q = await run(() =>
    createQuote(a.session, draft({ lines: [{ offerId, quantity: 1 }] })),
  );
  const first = await run(() => quoteAction(a.session, q.id, "share"));
  const next = await run(() =>
    createQuote(a.session, draft({ previousId: q.id })),
  );
  expect(next.revision).toBe(2);
  await expect(
    run(() => quoteAction(a.session, next.id, "share")),
  ).rejects.toMatchObject({ code: "state" });
  await run(() => quoteAction(a.session, next.id, "approve"));
  await run(() => quoteAction(a.session, next.id, "share"));
  await expect(
    publicQuote(first.path!.split("/").pop()!),
  ).rejects.toMatchObject({ code: "not_found" });
});
it("different businesses cannot read or change a quote or use another catalog", async () => {
  await expect(
    withBusiness(
      b.business.id,
      () => createQuote(b.session, draft()),
      b.session,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  const q = await run(() => createQuote(a.session, draft()));
  await expect(
    withBusiness(
      b.business.id,
      () => quoteAction(b.session, q.id, "approve"),
      b.session,
    ),
  ).rejects.toMatchObject({ code: "not_found" });
  expect(
    (await withBusiness(b.business.id, () => listSales(b.session), b.session))
      .quotes,
  ).toHaveLength(0);
});
it("expired and revoked links cannot be accepted", async () => {
  const q = await run(() =>
    createQuote(a.session, draft({ lines: [{ offerId, quantity: 1 }] })),
  );
  const l = await run(() => quoteAction(a.session, q.id, "share"));
  const token = l.path!.split("/").pop()!;
  await db.salesQuote.update({
    where: { id: q.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await expect(
    acceptQuote(token, { name: "לקוח", revision: 1, agree: true }),
  ).rejects.toMatchObject({ code: "state" });
  await expect(publicQuote(token)).rejects.toMatchObject({ code: "expired" });
});
it("agent cannot approve an exceptional discount or edit the catalog", async () => {
  const agent = { ...a.session, role: "agent" as const };
  await expect(
    run(() => saveOffer(agent, { name: "Bad", unitAmount: 1 })),
  ).rejects.toMatchObject({ code: "forbidden" });
  const q = await run(() => createQuote(a.session, draft()));
  await expect(
    run(() => quoteAction(agent, q.id, "approve")),
  ).rejects.toMatchObject({ code: "forbidden" });
});
it("cost snapshots and margins stay private to managers", async () => {
  const q = await run(() => createQuote(a.session, draft()));
  expect(q.costTotal).toBe(6000);
  const manager = await run(() => listSales(a.session));
  expect(manager.quotes[0]).toMatchObject({ costTotal: 6000, margin: 12000 });
  const agent = await run(() => listSales({ ...a.session, role: "agent" }));
  expect(JSON.stringify(agent)).not.toContain("costTotal");
  expect(JSON.stringify(agent)).not.toContain("unitCost");
  expect(JSON.stringify(agent)).not.toContain("margin");
});

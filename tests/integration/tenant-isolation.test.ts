import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact } from "@/lib/crm/contacts";

/**
 * Two businesses, the same phone number in both. The scoped client must never
 * cross the boundary, strict models must refuse queries without a tenant.
 */
describe("tenant isolation", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let b: Awaited<ReturnType<typeof createBusiness>>;
  beforeAll(async () => {
    a = await createBusiness("iso-a");
    b = await createBusiness("iso-b");
  });
  afterAll(async () => {
    await destroyBusiness(a.business.id, [a.account.id]);
    await destroyBusiness(b.business.id, [b.account.id]);
  });

  it("same phone can exist in both businesses and each only sees its own contact", async () => {
    const ca = await withBusiness(a.business.id, () => createContact(a.session, { fullName: "A person", phone: "0501110001" }), a.session);
    const cb = await withBusiness(b.business.id, () => createContact(b.session, { fullName: "B person", phone: "+972501110001" }), b.session);
    expect(ca.phoneE164).toBe(cb.phoneE164);
    expect(ca.id).not.toBe(cb.id);
    const seenFromA = await withBusiness(a.business.id, () => prisma.contact.findMany({ select: { id: true } }));
    expect(seenFromA.map((c) => c.id)).toEqual([ca.id]);
    // Even an explicit id of the other business is filtered out by the scope.
    const stolen = await withBusiness(a.business.id, () => prisma.contact.findUnique({ where: { id: cb.id } }));
    expect(stolen).toBeNull();
    const updated = await withBusiness(a.business.id, () => prisma.contact.updateMany({ where: { id: cb.id }, data: { fullName: "hacked" } }));
    expect(updated.count).toBe(0);
    expect((await db.contact.findUnique({ where: { id: cb.id } }))?.fullName).toBe("B person");
  });

  it("create inside a scope stamps the business id; strict models refuse to run without a scope", async () => {
    const lead = await withBusiness(a.business.id, async () => {
      const c = await prisma.contact.findFirstOrThrow();
      return prisma.lead.create({ data: { contactId: c.id } as never });
    });
    expect(lead.businessId).toBe(a.business.id);
    await expect(prisma.lead.findMany()).rejects.toThrow(/Business context is required/);
    await expect(prisma.conversation.count()).rejects.toThrow(/Business context is required/);
  });

  it("nested scopes do not leak between concurrent async flows", async () => {
    const [x, y] = await Promise.all([
      withBusiness(a.business.id, async () => { await new Promise((r) => setTimeout(r, 20)); return prisma.contact.count(); }),
      withBusiness(b.business.id, async () => prisma.contact.count()),
    ]);
    expect(x).toBe(1);
    expect(y).toBe(1);
  });
});

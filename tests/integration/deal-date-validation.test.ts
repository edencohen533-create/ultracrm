import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { closeDeal, closeDealSchema } from "@/lib/crm/deal-close";
import { createBusiness, destroyBusiness } from "./helpers";
vi.mock("@/lib/events", async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));
let tenant: Awaited<ReturnType<typeof createBusiness>>;
let contactId: string;
beforeAll(async () => { tenant = await createBusiness("deal-date"); contactId = (await db.contact.create({ data: { businessId: tenant.business.id, fullName: "Dates", phoneRaw: "0509884001", phoneE164: "+972509884001" } })).id; });
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });
it.each(["2027-02-29", "2027-02-30", "2027-13-01"])("rejects invalid renewal %s without storing an open-ended purchase", async (endsAt) => {
  const input = closeDealSchema.parse({ contactId, items: [{ name: "Monthly", startsAt: "2027-01-31", endsAt, unitPrice: 150 }] });
  await expect(withBusiness(tenant.business.id, () => closeDeal(tenant.session, input))).rejects.toMatchObject({ code: "invalid_date" });
  expect(await db.deal.count({ where: { contactId } })).toBe(0);
});

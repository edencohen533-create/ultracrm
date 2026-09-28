import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { mergeContacts } from "@/lib/crm/contacts";
import { marketingEligibilityWhere } from "@/server/services/audience-service";
import type { Prisma } from "@/generated/prisma/client";
import { createBusiness, destroyBusiness } from "./helpers";

vi.mock("@/lib/events", async (original) => ({ ...await original<object>(), kickEventProcessing: vi.fn() }));

let tenant: Awaited<ReturnType<typeof createBusiness>>;
let sequence = 0;
const earlier = new Date("2026-09-20T10:00:00Z");
const later = new Date("2026-09-21T10:00:00Z");

beforeAll(async () => { tenant = await createBusiness("merge-integrity"); });
afterAll(async () => {
  if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]);
});

function contact(data: Partial<Prisma.ContactUncheckedCreateInput> = {}) {
  const phone = `+97250128${String(++sequence).padStart(4, "0")}`;
  return db.contact.create({ data: { businessId: tenant.business.id, fullName: "Merge test", phoneE164: phone, phoneRaw: phone, ...data } });
}

function merge(primaryId: string, duplicateId: string) {
  return withBusiness(tenant.business.id, () => mergeContacts(tenant.session, primaryId, duplicateId), tenant.session);
}

it("keeps store carts attached to the surviving contact", async () => {
  const primary = await contact();
  const duplicate = await contact();
  const store = await db.storeConnection.create({ data: { businessId: tenant.business.id, platform: "custom", name: "Merge store", publicKey: `merge-${tenant.business.id}` } });
  const cart = await db.cart.create({ data: { businessId: tenant.business.id, storeId: store.id, externalId: "checkout-1", contactId: duplicate.id, status: "abandoned" } });
  await merge(primary.id, duplicate.id);
  expect(await db.cart.findUniqueOrThrow({ where: { id: cart.id } })).toMatchObject({ contactId: primary.id, status: "abandoned" });
  expect(await db.contact.findUnique({ where: { id: duplicate.id } })).toBeNull();
});

it.each([false, true])("keeps the chronologically latest activity (reverse=%s)", async (reverse) => {
  const primary = await contact({ lastActivityAt: reverse ? later : earlier });
  const duplicate = await contact({ lastActivityAt: reverse ? earlier : later });
  expect((await merge(primary.id, duplicate.id)).lastActivityAt).toEqual(later);
});

it.each([null, earlier, later])("preserves the first customer date when the survivor has %s", async (customerSince) => {
  const primary = await contact({ customerSince });
  const duplicate = await contact({ customerSince: earlier });
  expect((await merge(primary.id, duplicate.id)).customerSince).toEqual(earlier);
});

it.each([false, true])("preserves the marketing frequency cap from either contact (reverse=%s)", async (reverse) => {
  const now = new Date();
  const recent = new Date(now.getTime() - 60_000);
  const old = new Date(now.getTime() - 7 * 86_400_000);
  const primary = await contact({ consentStatus: "OPTED_IN", lastMarketingAt: reverse ? recent : old });
  const duplicate = await contact({ consentStatus: "OPTED_IN", lastMarketingAt: reverse ? old : recent });
  expect((await merge(primary.id, duplicate.id)).lastMarketingAt).toEqual(recent);
  expect(await db.contact.count({ where: { id: primary.id, ...marketingEligibilityWhere(now) } })).toBe(0);
});

it("does not transfer a bounce from a different email to the retained address", async () => {
  const primary = await contact({ email: "good@example.test" });
  const duplicate = await contact({ email: "bounced@example.test", emailStatus: "hard_bounce", emailBouncedAt: earlier });
  expect(await merge(primary.id, duplicate.id)).toMatchObject({ email: primary.email, emailStatus: null, emailBouncedAt: null });
});

it("copies deliverability status and timestamp together when adopting an email", async () => {
  const primary = await contact();
  const duplicate = await contact({ email: "adopted@example.test", emailStatus: "hard_bounce", emailBouncedAt: earlier });
  expect(await merge(primary.id, duplicate.id)).toMatchObject({ email: duplicate.email, emailStatus: "hard_bounce", emailBouncedAt: earlier });
});

it("keeps the retained email's existing deliverability record", async () => {
  const primary = await contact({ email: "retained@example.test", emailStatus: "soft_bounce", emailBouncedAt: earlier });
  const duplicate = await contact({ email: "other@example.test", emailStatus: "hard_bounce", emailBouncedAt: later });
  expect(await merge(primary.id, duplicate.id)).toMatchObject({ email: primary.email, emailStatus: "soft_bounce", emailBouncedAt: earlier });
});

it("keeps absent dates and email metadata empty", async () => {
  const primary = await contact();
  const duplicate = await contact();
  expect(await merge(primary.id, duplicate.id)).toMatchObject({ lastActivityAt: null, lastMarketingAt: null, customerSince: null, email: null, emailStatus: null, emailBouncedAt: null });
});

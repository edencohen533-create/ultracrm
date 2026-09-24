import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";

/** Create an isolated test business (slug `test-*`) with one owner. Deleted by `destroyBusiness`. */
export async function createBusiness(tag: string, opts: { modules?: Record<string, boolean> } = {}) {
  const slug = `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const business = await db.business.create({ data: { name: `[TEST] ${tag}`, slug, modules: opts.modules ?? {}, settings: { dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } });
  const account = await db.account.create({ data: { email: `${slug}@test.local`, fullName: `Owner ${tag}`, passwordHash: await bcrypt.hash("Test1234!", 4) } });
  const user = await db.user.create({ data: { businessId: business.id, accountId: account.id, email: account.email, fullName: account.fullName, role: "owner" } });
  const session: SessionUser = { id: user.id, accountId: account.id, businessId: business.id, email: account.email, fullName: account.fullName, role: "owner", teamId: null };
  return { business, account, user, session };
}

export async function destroyBusiness(businessId: string, accountIds: string[] = []) {
  await db.campaignRecipient.deleteMany({ where: { campaign: { businessId } } });
  await db.campaign.deleteMany({ where: { businessId } });
  await db.business.delete({ where: { id: businessId } });
  if (accountIds.length) await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

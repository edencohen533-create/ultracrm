import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { assertBillingAdmin } from "@/server/billing/subscriptions";
import { getPolicy, setPolicy, spentThisMonth } from "@/server/billing/budget";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { await assertBillingAdmin(user); return ok({ policy: await getPolicy(user.businessId), spent: await spentThisMonth(user.businessId) }); });
export const PUT = withAuth(async ({ req, user }) => { await assertBillingAdmin(user); const b = await parseBody(req, z.object({ monthlyCapMinor: z.number().int().min(0).max(1e10).nullable(), alertPercents: z.array(z.number().int().min(1).max(200)).max(6), hardStop: z.boolean() })); return ok(await setPolicy(user.businessId, user.id, b)); });

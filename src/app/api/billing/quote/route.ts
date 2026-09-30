import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { assertBillingAdmin, desiredSchema, quote } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
/** Price of a change before confirming: what is charged now (prorated), the new monthly total, when reductions apply. */
export const POST = withAuth(async ({ req, user }) => { await assertBillingAdmin(user); const b = await parseBody(req, z.object({ desired: desiredSchema })); return ok(await quote(user.businessId, b.desired)); });

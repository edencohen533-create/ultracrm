import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { licenseSummary, setLicense } from "@/server/billing/licenses";
import { assertBillingAdmin } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { await assertBillingAdmin(user); return ok(await licenseSummary(user)); });
/** Assign / release a license (moving it between employees needs no purchase). */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, z.object({ userId: z.string().max(64), module: z.enum(["crm", "telephony", "whatsapp", "sms", "email"]), on: z.boolean() })); return ok(await setLicense(user, b)); });

import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { simulate } from "@/server/automations/journeys";

export const dynamic = "force-dynamic";
/** Dry run with test data or a real contact (read-only) – explains each decision; nothing is sent. */
const schema = z.object({ definition: z.unknown(), contactId: z.string().optional(), data: z.object({ tags: z.array(z.string()).optional(), leadStatus: z.string().optional(), consent: z.enum(["OPTED_IN", "UNKNOWN", "OPTED_OUT"]).optional(), replied: z.boolean().optional(), converted: z.boolean().optional() }).optional() });
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, schema); return ok(await simulate(user, b.definition, { contactId: b.contactId, data: b.data })); }, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });

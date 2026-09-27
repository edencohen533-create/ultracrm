import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { listSequences, saveSequence, sequenceSchema } from "@/server/services/sequence-service";

export const dynamic = "force-dynamic";
export const GET = withAuth(async () => ok({ items: await listSequences() }), { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });
export const POST = withAuth(async ({ req, user }) => ok(await saveSequence(user, await parseBody(req, sequenceSchema))), { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });

import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { createTask, listTasks, taskFilterSchema, taskInputSchema } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => ok(await listTasks(user, parseQuery(req, taskFilterSchema))), { perm: ["crm.view", "telephony.use", "whatsapp.view"] });

export const POST = withAuth(async ({ req, user }) => ok(await createTask(user, await parseBody(req, taskInputSchema)), 201), { perm: ["crm.edit", "telephony.use", "whatsapp.reply"] });

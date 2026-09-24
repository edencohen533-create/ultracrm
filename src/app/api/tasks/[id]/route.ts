import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { taskPatchSchema, updateTask } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const PATCH = withAuth(async ({ req, user, params }) => ok(await updateTask(user, params.id, await parseBody(req, taskPatchSchema))));

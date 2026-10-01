import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { patchSchema, updateAppointment } from "@/server/services/appointments";

export const dynamic = "force-dynamic";
export const PATCH = withAuth(async ({ req, user, params }) => ok(await updateAppointment(user, params.id, await parseBody(req, patchSchema))), { perm: "crm.edit" });

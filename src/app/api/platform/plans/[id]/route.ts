import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { requirePlatformAdmin, savePlan } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Editing a package creates a NEW version; businesses keep their version until it is applied to them explicitly. */
export const PUT = withAuth(async ({ req, user, params }) => { await requirePlatformAdmin(user); return ok(await savePlan(user, await req.json().catch(() => null), params.id)); });

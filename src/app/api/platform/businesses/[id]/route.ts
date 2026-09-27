import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { businessDetail, requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user, params }) => { await requirePlatformAdmin(user); return ok(await businessDetail(params.id)); });

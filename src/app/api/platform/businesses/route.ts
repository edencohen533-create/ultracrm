import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { listBusinesses, requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { await requirePlatformAdmin(user); return ok({ items: await listBusinesses() }); });

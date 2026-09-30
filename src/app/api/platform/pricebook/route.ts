import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";
import { createVersion, ensureLaunchDraft, USAGE_SERVICES } from "@/server/billing/pricebook";

export const dynamic = "force-dynamic";
/** Price book versions (platform admin). The launch prices exist as a draft until explicitly published. */
export const GET = withAuth(async ({ user }) => { await requirePlatformAdmin(user); await withoutBusiness(() => ensureLaunchDraft()); return ok({ versions: await withoutBusiness(() => db.priceBookVersion.findMany({ orderBy: { version: "desc" } })), services: USAGE_SERVICES }); });
export const POST = withAuth(async ({ req, user }) => { await requirePlatformAdmin(user); return ok(await withoutBusiness(async () => createVersion(user.accountId, await req.json())), 201); });

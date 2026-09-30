import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { requirePlatformAdmin } from "@/lib/access/manage";
import { pricingOverview, savePricing } from "@/server/billing/pricing";

export const dynamic = "force-dynamic";

/** Custom pricing of one business (platform admin only): terms in force, versions, credits, audit. */
export const GET = withAuth(async ({ user, params }) => { await requirePlatformAdmin(user); return ok(await pricingOverview(params.id)); });
/** Save a NEW version (never edits an old one); the preview total must match what was shown. */
export const POST = withAuth(async ({ req, user, params }) => { await requirePlatformAdmin(user); return ok(await savePricing(user, params.id, await req.json().catch(() => null)), 201); });

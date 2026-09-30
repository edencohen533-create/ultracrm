import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { requirePlatformAdmin } from "@/lib/access/manage";
import { addCredit } from "@/server/billing/pricing";

export const dynamic = "force-dynamic";

/** One-time credit – consumed by the next renewal(s), never below zero. */
export const POST = withAuth(async ({ req, user, params }) => { await requirePlatformAdmin(user); return ok(await addCredit(user, params.id, await req.json().catch(() => null)), 201); });

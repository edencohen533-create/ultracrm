import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { ACCESS_STATUSES, requirePlatformAdmin, setAccessStatus, statusImpact } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
const schema = z.object({ status: z.enum(ACCESS_STATUSES), until: z.iso.datetime().nullable().optional(), reason: z.string().trim().max(500).optional(), confirmName: z.string().max(200).optional() });
/** Access policy (separate from payment): setup / trial / active / grace (with an end date) / suspended / cancelled. */
export const POST = withAuth(async ({ req, user, params }) => { const b = await parseBody(req, schema); await setAccessStatus(user, params.id, b.status, b.until ? new Date(b.until) : null, { reason: b.reason, confirmName: b.confirmName }); return ok({ ok: true }); });
/** Impact preview of a status change (nothing is changed). */
export const GET = withAuth(async ({ req, user, params }) => { await requirePlatformAdmin(user); const s = z.enum(ACCESS_STATUSES).parse(new URL(req.url).searchParams.get("status")); return ok(await statusImpact(params.id, s)); });

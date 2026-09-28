import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { setAccessStatus } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
const schema = z.object({ status: z.enum(["active", "trial", "grace", "suspended"]), until: z.iso.datetime().nullable().optional() });
/** Access policy (separate from payment): active / trial / grace (with an end date) / suspended. */
export const POST = withAuth(async ({ req, user, params }) => { const b = await parseBody(req, schema); await setAccessStatus(user, params.id, b.status, b.until ? new Date(b.until) : null); return ok({ ok: true }); });

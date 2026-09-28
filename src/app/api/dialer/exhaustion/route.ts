import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { applyExhaustion, exhaustionPreview } from "@/lib/dialer/exhaustion";

export const dynamic = "force-dynamic";

/** Preview: existing leads that the current quota would move to "לא רלוונטי" (nothing changes). ?listId= for a campaign. */
export const GET = withAuth(async ({ req, user }) => ok(await exhaustionPreview(user, req.nextUrl.searchParams.get("listId"))), { minRole: "manager", perm: "telephony.team_settings" });

/** Explicit manager approval of exactly the previewed leads (each one re-checked before it moves). */
const schema = z.object({ listId: z.string().nullable().optional(), leadIds: z.array(z.string()).min(1).max(5000) });
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, schema); return ok(await applyExhaustion(user, b.listId ?? null, b.leadIds)); }, { minRole: "manager", perm: "telephony.team_settings" });

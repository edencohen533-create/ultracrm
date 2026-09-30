import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { estimateCost } from "@/server/billing/budget";

export const dynamic = "force-dynamic";
/** Cost estimate before a large send (campaign): units × rate and whether it fits the monthly cap. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, z.object({ service: z.string().max(40), units: z.number().min(0).max(1e7) })); return ok(await estimateCost(user.businessId, b.service, b.units)); });

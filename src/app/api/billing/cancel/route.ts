import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { cancel } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
/** Cancel at the end of the paid period (data kept) – or undo that before the date. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, z.object({ resume: z.boolean().default(false) })); return ok(await cancel(user, b.resume)); });

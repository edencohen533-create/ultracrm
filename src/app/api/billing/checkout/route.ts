import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { checkout, desiredSchema } from "@/server/billing/subscriptions";

export const dynamic = "force-dynamic";
/** Confirm a change for the exact total shown (idempotent). Applied only after the provider verifies payment. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, z.object({ desired: desiredSchema, idempotencyKey: z.string().min(8).max(100), expectedTotalMinor: z.number().int().min(0) })); return ok(await checkout(user, b)); });

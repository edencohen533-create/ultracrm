import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { createPaymentRequest } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Create (or return, for the same idempotency key) a payment request and its provider page. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({
    contactId: z.string().min(1).max(64), callId: z.string().min(1).max(64).nullable().optional(),
    source: z.object({ type: z.enum(["product", "quote", "deal", "custom"]), id: z.string().max(64).nullable().optional() }),
    amountAgorot: z.number().int().min(1).max(10_000_000).nullable().optional(), description: z.string().max(200).nullable().optional(),
    idempotencyKey: z.string().min(8).max(100),
  }));
  return ok(await createPaymentRequest(user, b), 201);
}, { perm: "crm.payments" });

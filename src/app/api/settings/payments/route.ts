import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { connectPaymentProvider, connectionSummary, disconnectPaymentProvider } from "@/server/services/payment-service";

export const dynamic = "force-dynamic";

/** The business's card-payment provider (secrets are never returned). */
export const GET = withAuth(async ({ user }) => ok(await connectionSummary(user.businessId)), { minRole: "manager" });
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ provider: z.enum(["payplus", "sandbox"]), environment: z.enum(["test", "live"]), apiKey: z.string().trim().max(200).optional(), secretKey: z.string().trim().max(200).optional(), paymentPageUid: z.string().trim().max(100).optional(), label: z.string().trim().max(80).optional() }));
  return ok(await connectPaymentProvider(user, b));
}, { minRole: "owner" });
export const DELETE = withAuth(async ({ user }) => ok(await disconnectPaymentProvider(user)), { minRole: "owner" });

import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { saveZadarmaAccount, zadarmaOverview } from "@/server/services/zadarma-admin-service";

export const dynamic = "force-dynamic";

const body = z.object({
  apiKey: z.string().min(8).max(200).optional(),
  apiSecret: z.string().min(8).max(200).optional(),
  sandbox: z.boolean().optional(),
  callerIdE164: z.string().max(30).nullable().optional(),
  callerIdSource: z.enum(["zadarma_number", "verified_external"]).nullable().optional(),
  approveCallerId: z.boolean().optional(),
  testNumbers: z.array(z.string().max(30)).max(5).optional(),
  maxConcurrent: z.number().int().min(1).max(500).nullable().optional(),
});

/** Zadarma backup account – business owner only. Secrets are write-only. */
export const GET = withAuth(async ({ user }) => ok(await zadarmaOverview(user.businessId)), { minRole: "owner", module: "telephony" });
export const PUT = withAuth(async ({ req, user }) => ok(await saveZadarmaAccount(user.businessId, user.id, await parseBody(req, body))), { minRole: "owner", module: "telephony" });

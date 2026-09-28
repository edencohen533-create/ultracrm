import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { businessDeletionStatus, cancelBusinessDeletion, requestBusinessDeletion } from "@/server/services/account-deletion-service";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => ok(await businessDeletionStatus(user.businessId)));

/** Owner: schedule (typing the business name) or cancel the deletion of the business and all its data. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.union([z.object({ action: z.literal("request"), confirmName: z.string().min(1).max(200) }), z.object({ action: z.literal("cancel") })]));
  if (b.action === "cancel") { await cancelBusinessDeletion(user); return ok({ cancelled: true }); }
  return ok(await requestBusinessDeletion(user, b.confirmName));
}, { minRole: "owner" });

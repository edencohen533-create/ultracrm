import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { createCustomerBusiness, platformBusinessList } from "@/lib/platform/businesses";

export const dynamic = "force-dynamic";
/** Platform admins only (checked inside): the businesses using UltraCRM – management fields, no content. */
export const GET = withAuth(async ({ user }) => ok({ items: await platformBusinessList(user) }));

const schema = z.object({
  name: z.string().trim().min(2).max(120), ownerName: z.string().trim().max(120).default(""), ownerEmail: z.string().trim().email().max(200),
  status: z.enum(["setup", "trial", "active"]).default("setup"), trialUntil: z.iso.datetime().nullable().optional(), planVersionId: z.string().min(1).nullable().optional(),
  timezone: z.string().max(60).optional(),
});
/** A new customer business: isolated, empty, its owner invited by a one-time link (shown once). */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  return ok(await createCustomerBusiness(user, { ...b, trialUntil: b.trialUntil ? new Date(b.trialUntil) : null }));
});

import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { requirePlatformAdmin } from "@/lib/access/manage";
import { previewPricing, termsSchema } from "@/server/billing/pricing";

export const dynamic = "force-dynamic";

/** The next bill now vs. with the proposed terms / credit – nothing is saved. */
export const POST = withAuth(async ({ req, user, params }) => {
  await requirePlatformAdmin(user);
  const b = await parseBody(req, z.object({ terms: termsSchema, creditMinor: z.number().int().min(0).max(100_000_000).default(0) }));
  return ok(await previewPricing(params.id, b.terms, b.creditMinor));
});

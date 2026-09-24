import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { completeSignup } from "@/server/services/embedded-signup-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  state: z.string().min(20).max(200),
  code: z.string().min(10).max(2000),
  wabaId: z.string().regex(/^\d+$/),
  phoneNumberId: z.string().regex(/^\d+$/),
  metaBusinessId: z.string().regex(/^\d+$/).optional(),
  label: z.string().trim().max(100).optional(),
  teamId: z.string().min(1).nullable().optional(),
});

/** Exchange the code server-side, verify the granted assets, subscribe + register, persist. */
export const POST = withAuth(async ({ req, user }) => ok(await completeSignup(user, await parseBody(req, schema))), { minRole: "manager", module: "messaging" });

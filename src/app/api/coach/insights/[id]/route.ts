import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { reviewInsight } from "@/server/coach/sales";

export const dynamic = "force-dynamic";

/** Approve (optionally edited → new version) / reject / remove / restore an earlier version. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ action: z.enum(["approve", "reject", "remove", "restore"]), title: z.string().max(160).optional(), body: z.string().max(1200).optional(), objection: z.string().max(400).nullable().optional(), acknowledgeFlags: z.boolean().optional(), versionId: z.string().optional() }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the embedding vector is never sent to the browser
  const { embedding: _e, ...row } = await reviewInsight(user, params.id, b);
  return ok(row);
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });

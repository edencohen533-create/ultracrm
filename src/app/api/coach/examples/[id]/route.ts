import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { embed } from "@/server/coach/providers";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Approve / edit / reject an example for future retrieval. Approving computes the embedding when a provider exists. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ status: z.enum(["pending", "approved", "rejected"]).optional(), editedResponse: z.string().trim().max(600).nullable().optional(), objection: z.string().trim().min(1).max(300).optional() }));
  const ex = await prisma.coachExample.findUnique({ where: { id: params.id } });
  if (!ex) throw new ApiError("דוגמה לא נמצאה", 404, "not_found");
  let embedding: Prisma.InputJsonValue | undefined;
  const objection = b.objection ?? ex.objection;
  if ((b.status === "approved" || b.objection) && (!Array.isArray(ex.embedding) || b.objection)) {
    const e = await embed([objection]).catch(() => ({ vectors: null }));
    if (e.vectors) embedding = e.vectors[0] as unknown as Prisma.InputJsonValue;
  }
  const row = await prisma.coachExample.update({ where: { id: ex.id }, data: { status: b.status, editedResponse: b.editedResponse, objection: b.objection, embedding, reviewedById: user.id, reviewedAt: new Date() } });
  await audit(user.businessId, user.id, "coach", row.id, "coach.example_reviewed", { status: row.status, edited: Boolean(b.editedResponse) });
  return ok(row);
}, { minRole: "manager" });

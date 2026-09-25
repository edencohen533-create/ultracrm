import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { knowledgeView } from "@/server/coach/prompt";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const text = (max: number) => z.string().trim().max(max);
const schema = z.object({
  description: text(2000).optional(), audience: text(1000).optional(),
  products: z.array(z.object({ name: text(120), price: text(80).optional(), notes: text(300).optional() })).max(100).optional(),
  benefits: z.array(text(200)).max(50).optional(),
  faqs: z.array(z.object({ question: text(300), answer: text(800) })).max(100).optional(),
  objections: z.array(z.object({ objection: text(300), response: text(800) })).max(100).optional(),
  forbiddenClaims: z.array(text(200)).max(50).optional(),
  style: text(500).optional(), callGoal: text(300).optional(),
});

/** Business knowledge the coach may rely on. Managers edit; agents never see the raw editor (the model uses it server-side). */
export const GET = withAuth(async ({ user }) => ok(knowledgeView(await prisma.coachKnowledge.findUnique({ where: { businessId: user.businessId } }))), { minRole: "manager" });

export const PUT = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const data = { ...b, updatedById: user.id } as unknown as Prisma.CoachKnowledgeUncheckedUpdateInput;
  const row = await prisma.coachKnowledge.upsert({ where: { businessId: user.businessId }, update: data, create: { ...(b as unknown as Omit<Prisma.CoachKnowledgeUncheckedCreateInput, "businessId">), businessId: user.businessId, updatedById: user.id } });
  await audit(user.businessId, user.id, "coach", row.id, "coach.knowledge_updated", { fields: Object.keys(b) });
  return ok(knowledgeView(row));
}, { minRole: "manager" });

import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { effectiveAccess, can } from "@/lib/access/engine";
import { audit } from "@/lib/audit";
const KIND = "expert_assistance";
async function ownCall(user: SessionUser, id: string) {
  const c = await prisma.call.findFirst({
    where: {
      id,
      businessId: user.businessId,
      userId: user.id,
      endedAt: null,
      answeredAt: { not: null },
    },
  });
  if (!c)
    throw new ApiError(
      "נדרשת שיחה פעילה שלך עם לקוח שענה",
      409,
      "call_unavailable",
    );
  return c;
}
export async function assistanceCandidates(user: SessionUser, callId: string) {
  await ownCall(user, callId);
  const users = await prisma.user.findMany({
    where: {
      businessId: user.businessId,
      id: { not: user.id },
      isActive: true,
      role: { in: ["owner", "manager"] },
      lastSeenAt: { gte: new Date(Date.now() - 90000) },
    },
  });
  const candidates = [];
  for (const u of users) {
    const ids = await visibleUserIds(u);
    if (ids && !ids.includes(user.id)) continue;
    const access = await effectiveAccess(user.businessId, u.id);
    if (!can(access, "telephony.use")) continue;
    if (
      (await prisma.call.findFirst({
        where: { businessId: user.businessId, userId: u.id, endedAt: null },
      })) ||
      (await prisma.callMonitor.findFirst({
        where: { businessId: user.businessId, managerId: u.id, endedAt: null },
      }))
    )
      continue;
    candidates.push({ id: u.id, name: u.fullName });
  }
  const request = await prisma.opsRecommendation.findUnique({
    where: {
      businessId_dedupeKey: {
        businessId: user.businessId,
        dedupeKey: `expert:${callId}`,
      },
    },
    select: { status: true, expiresAt: true },
  });
  return { candidates, request };
}
export async function requestAssistance(user: SessionUser, input: unknown) {
  const b = z
    .object({
      callId: z.string(),
      expertId: z.string(),
      summary: z.string().trim().min(3).max(1500),
    })
    .parse(input);
  await ownCall(user, b.callId);
  if (
    !(await assistanceCandidates(user, b.callId)).candidates.some(
      (u) => u.id === b.expertId,
    )
  )
    throw new ApiError(
      "המומחה אינו זמין או אינו מורשה לשיחה",
      409,
      "expert_unavailable",
    );
  const data = {
    evidence: {},
    agentId: user.id,
    kind: KIND,
    title: `בקשת סיוע מ${user.fullName}`,
    explanation: b.summary,
    proposal: { callId: b.callId, expertId: b.expertId },
    status: "pending_expert",
    expiresAt: new Date(Date.now() + 120000),
  };
  const rec = await prisma.opsRecommendation.upsert({
    where: {
      businessId_dedupeKey: {
        businessId: user.businessId,
        dedupeKey: `expert:${b.callId}`,
      },
    },
    create: {
      businessId: user.businessId,
      ...data,
      code: String(crypto.randomInt(1000, 10000)),
      dedupeKey: `expert:${b.callId}`,
    },
    update: data,
  });
  await audit(
    user.businessId,
    user.id,
    "call",
    b.callId,
    "sales.expert_requested",
    { expertId: b.expertId, requestId: rec.id },
  );
  return { id: rec.id, status: rec.status };
}
export async function assistanceInbox(user: SessionUser) {
  if (user.role === "agent")
    throw new ApiError("המסך מיועד למנהלים", 403, "forbidden");
  const rows = await prisma.opsRecommendation.findMany({
    where: {
      businessId: user.businessId,
      kind: KIND,
      status: "pending_expert",
      expiresAt: { gt: new Date() },
      proposal: { path: ["expertId"], equals: user.id },
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const ids = await visibleUserIds(user);
  const result = [];
  for (const r of rows) {
    if (!r.agentId || (ids && !ids.includes(r.agentId))) continue;
    const p = r.proposal as { callId: string };
    const call = await prisma.call.findFirst({
      where: {
        id: p.callId,
        businessId: user.businessId,
        userId: r.agentId,
        endedAt: null,
        answeredAt: { not: null },
      },
    });
    if (call)
      result.push({
        id: r.id,
        callId: call.id,
        title: r.title,
        summary: r.explanation,
        expiresAt: r.expiresAt,
      });
  }
  return { items: result };
}

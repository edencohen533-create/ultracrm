/** Store only a verbatim excerpt of the actual inbound message, under a configured question. */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getAiSettings } from "./settings";
export type QualificationAnswer = {
  question: string;
  answer: string;
  messageId: string;
  at: string;
};
export async function qualificationAnswers(
  contactId: string,
  questions?: string[],
): Promise<QualificationAnswer[]> {
  const rows = await prisma.aiAction.findMany({
    where: {
      channel: "qualification",
      kind: "answer",
      status: "executed",
      params: { path: ["contactId"], equals: contactId },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    const r = row.result as unknown as QualificationAnswer;
    if (
      !r?.question ||
      !r.answer ||
      seen.has(r.question) ||
      (questions && !questions.includes(r.question))
    )
      return [];
    seen.add(r.question);
    return [r];
  });
}
export async function saveQualification(
  businessId: string,
  contactId: string,
  messageId: string,
  input: Record<string, unknown>,
) {
  const { ai } = await getAiSettings(businessId);
  const question = String(input.question ?? ""),
    answer = String(input.answer ?? "").trim();
  if (
    !ai.service.enabled ||
    !ai.service.qualificationQuestions.includes(question)
  )
    return { error: "השאלה אינה מוגדרת לסינון" };
  const m = await prisma.message.findFirst({
    where: {
      id: messageId,
      businessId,
      direction: "INBOUND",
      conversation: { contactId, businessId, channel: "whatsapp" },
    },
    include: { conversation: true },
  });
  if (!m || !answer || answer.length > 1000 || !m.body?.includes(answer))
    return {
      error: "יש לצטט תשובה מתוך הודעת הלקוח הנוכחית, ללא ניחוש או שינוי",
    };
  if (
    ["human", "handoff", "handoff_done"].includes(m.conversation.aiMode ?? "")
  )
    return { error: "נציג כבר מטפל בשיחה" };
  if (
    await prisma.message.findFirst({
      where: {
        conversationId: m.conversationId,
        direction: "INBOUND",
        createdAt: { gt: m.createdAt },
      },
    })
  )
    return { error: "התקבלה הודעה חדשה יותר" };
  const result = { question, answer, messageId, at: m.createdAt.toISOString() };
  const key = `qualification:${messageId}:${crypto.createHash("sha256").update(question).digest("hex")}`;
  await prisma.aiAction.upsert({
    where: { businessId_dedupeKey: { businessId, dedupeKey: key } },
    create: {
      businessId,
      channel: "qualification",
      kind: "answer",
      params: { contactId, conversationId: m.conversationId },
      summary: `תשובת סינון: ${question}`,
      status: "executed",
      requiresApproval: false,
      executedAt: new Date(),
      result: result as Prisma.InputJsonValue,
      dedupeKey: key,
    },
    update: {},
  });
  const answers = await qualificationAnswers(
    contactId,
    ai.service.qualificationQuestions,
  );
  return {
    saved: true,
    complete: ai.service.qualificationQuestions.every((q) =>
      answers.some((a) => a.question === q),
    ),
    answers,
  };
}

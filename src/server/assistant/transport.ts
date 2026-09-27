/**
 * Delivery to an assistant link over the business's EXISTING WhatsApp connection (no second integration).
 *  • Inside WhatsApp's 24h service window (the owner wrote to us in the last 24h): free text.
 *  • Outside it: only an APPROVED template (settings.assistant.templateId) – the report itself is kept as
 *    `pendingReport` and delivered as soon as the owner replies. Without an approved template nothing is sent.
 * These messages are internal (owner ↔ assistant): they never enter the customer inbox.
 */
import { prisma } from "@/lib/db";
import { getActiveProvider } from "@/server/providers/provider-registry";
import { getBusinessSettings } from "@/lib/settings";
import type { AssistantLink } from "@/generated/prisma/client";

const WINDOW_MS = 24 * 3600_000;
export const inWindow = (link: Pick<AssistantLink, "lastInboundAt">, now = new Date()) => Boolean(link.lastInboundAt && now.getTime() - link.lastInboundAt.getTime() < WINDOW_MS);
const chunks = (t: string) => { const out: string[] = []; let s = t; while (s.length > 3800) { const cut = s.lastIndexOf("\n", 3800); out.push(s.slice(0, cut > 1000 ? cut : 3800)); s = s.slice(cut > 1000 ? cut : 3800); } out.push(s); return out; };

export type SendOutcome = { status: "sent" | "template" | "skipped" | "failed"; detail?: string };

export async function sendToLink(link: AssistantLink, text: string, opts: { credentialId?: string | null; title?: string } = {}): Promise<SendOutcome> {
  const provider = await getActiveProvider(opts.credentialId ?? undefined).catch((e: Error) => { throw new Error(`אין חיבור WhatsApp פעיל: ${e.message}`); });
  if (inWindow(link)) {
    for (const part of chunks(text)) {
      const r = await provider.sendMessage({ conversationId: "", to: link.phoneE164, type: "TEXT", body: part });
      if (r.status === "FAILED") return { status: "failed", detail: r.error ?? "הספק דחה את ההודעה" };
    }
    return { status: "sent" };
  }
  const { assistant } = await getBusinessSettings(link.businessId);
  const tpl = assistant.templateId ? await prisma.template.findFirst({ where: { id: assistant.templateId, channel: "whatsapp" } }) : null;
  if (!tpl || tpl.status !== "APPROVED") return { status: "skipped", detail: tpl ? `התבנית "${tpl.name}" אינה מאושרת (${tpl.status})` : "מחוץ לחלון 24 השעות ואין תבנית מאושרת מוגדרת" };
  const r = await provider.sendTemplate({ conversationId: "", to: link.phoneE164, type: "TEMPLATE", templateId: tpl.id, templateVariables: { "1": (opts.title ?? "דוח חדש מהעוזר").slice(0, 60) } });
  if (r.status === "FAILED") return { status: "failed", detail: r.error ?? "שליחת התבנית נכשלה" };
  await prisma.assistantLink.update({ where: { id: link.id }, data: { pendingReport: text.slice(0, 8000) } });
  return { status: "template", detail: tpl.name };
}

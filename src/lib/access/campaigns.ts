/**
 * Campaign permissions by channel (WhatsApp broadcasts / SMS / email). Preparing (draft) and sending are separate
 * actions; the channel is read from the campaign / draft row (never from the browser) or from the request body.
 * Existing gates (owner/manager actor, quotas, suppression, provider limits) still apply on top.
 */
import { prisma } from "@/lib/db";
import type { ModuleKey, Permission } from "./catalog";

type Level = "view" | "draft" | "send";
type Ch = "whatsapp" | "sms" | "email";
export function channelPerm(ch: Ch, level: Level): Permission[] {
  if (ch === "whatsapp") return level === "send" ? ["whatsapp.campaign_send"] : level === "draft" ? ["whatsapp.campaign_draft"] : ["whatsapp.campaign_draft", "whatsapp.campaign_send"];
  return [`${ch}.${level}` as Permission];
}
const ANY: Record<Level, Array<ModuleKey | Permission>> = {
  view: ["whatsapp.campaign_draft", "whatsapp.campaign_send", "sms.view", "email.view"],
  draft: ["whatsapp.campaign_draft", "sms.draft", "email.draft"],
  send: ["whatsapp.campaign_send", "sms.send", "email.send"],
};
const asCh = (v: unknown): Ch | null => (v === "whatsapp" || v === "sms" || v === "email" ? v : null);

/** Unknown / missing channel → any of the channels at that level (the handler then answers 404 / 400). */
export async function campaignNeed(id: string | undefined, level: Level) {
  const c = id ? await prisma.campaign.findFirst({ where: { id }, select: { channel: true } }) : null;
  const ch = asCh(c?.channel); return ch ? channelPerm(ch, level) : ANY[level];
}
export async function draftNeed(id: string | undefined, level: Level) {
  const d = id ? await prisma.campaignDraft.findFirst({ where: { id }, select: { channel: true } }) : null;
  const ch = asCh(d?.channel); return ch ? channelPerm(ch, level) : ANY[level];
}
export function queryChannelNeed(request: Request | null, level: Level) {
  const ch = asCh(request ? new URL(request.url).searchParams.get("channel") : null); return ch ? channelPerm(ch, level) : ANY[level];
}
export async function bodyChannelNeed(request: Request | null, level: Level, fallback: Ch | null = null) {
  const body = request ? await request.clone().json().catch(() => null) : null;
  const ch = asCh((body as { channel?: unknown } | null)?.channel) ?? fallback; return ch ? channelPerm(ch, level) : ANY[level];
}
/** Campaign PATCH: launching / resuming / retrying = send; pausing / cancelling / unscheduling / renaming = draft or send. */
export async function campaignPatchNeed(request: Request | null, id: string | undefined) {
  const body = request ? await request.clone().json().catch(() => null) as { action?: string } | null : null;
  const sending = ["start", "resume", "retry_recipient"].includes(String(body?.action));
  if (sending) return campaignNeed(id, "send");
  const [d, s] = await Promise.all([campaignNeed(id, "draft"), campaignNeed(id, "send")]);
  return [...d, ...s];
}
export { ANY as CAMPAIGN_ANY };

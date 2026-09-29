/**
 * Zadarma PBX notifications → our provider events.
 * Each business has its own Zadarma account and webhook URL (/api/webhooks/zadarma/<credential id>); the signature is
 * checked with THAT account's secret, and only that business's calls can match – one business's events can never
 * touch another's calls or recordings.
 *
 * Zadarma sends no reference of ours, so an outgoing event is matched to the business's live Zadarma call from the
 * agent's extension (`internal`) to the destination, started in the last 30 minutes; after that the provider's
 * pbx_call_id is stored as the customer leg id and later events match on it.
 * Event ids for de-duplication: `${event}:${pbx_call_id}:${call_start}` (Zadarma has no event id).
 * Zadarma's signature carries no timestamp: exact replays are stopped by that de-duplication and by accepting
 * events only for calls that are still live / recent.
 */
import { prisma } from "@/lib/db";
import { processProviderEvent } from "./events";
import { recordProviderResult } from "./routing";
import { mapDisposition, verifyZadarmaWebhook, zadarmaAccount, zadarmaNumber } from "./zadarma";
import type { ProviderEvent } from "./types";

const MATCH_WINDOW_MS = 30 * 60_000;

async function findCall(businessId: string, f: Record<string, string>) {
  if (f.pbx_call_id) {
    const byLeg = await prisma.call.findFirst({ where: { businessId, provider: "zadarma", leadLegId: f.pbx_call_id } });
    if (byLeg) return byLeg;
  }
  if (!f.internal || !f.destination) return null;
  const ep = await prisma.telephonyAgentEndpoint.findFirst({ where: { businessId, provider: "zadarma", extension: String(f.internal) } });
  if (!ep) return null;
  const dest = zadarmaNumber(f.destination).slice(-9);
  const candidates = await prisma.call.findMany({ where: { businessId, provider: "zadarma", userId: ep.userId, direction: "outbound", leadLegId: null, createdAt: { gte: new Date(Date.now() - MATCH_WINDOW_MS) } }, orderBy: { createdAt: "desc" }, take: 5 });
  return candidates.find((c) => zadarmaNumber(c.toE164).endsWith(dest)) ?? null;
}

export type ZadarmaWebhookResult = { status: number; body: Record<string, unknown> };

export async function handleZadarmaWebhook(accountId: string, fields: Record<string, string>, signature: string | null): Promise<ZadarmaWebhookResult> {
  const cred = await prisma.telephonyProviderCredential.findFirst({ where: { id: accountId, provider: "zadarma" } });
  if (!cred) return { status: 404, body: { error: "unknown account" } };
  const acc = await zadarmaAccount(cred.businessId);
  if (!acc || !verifyZadarmaWebhook(fields, signature, acc.apiSecret)) return { status: 401, body: { error: "invalid signature" } };
  const event = fields.event;
  if (!["NOTIFY_OUT_START", "NOTIFY_OUT_END", "NOTIFY_RECORD"].includes(event)) return { status: 200, body: { ignored: event ?? "none" } }; // inbound via Zadarma is not routed (docs/TELEPHONY_ZADARMA.md)
  const call = await findCall(cred.businessId, fields);
  if (!call) return { status: 200, body: { matched: false } };
  const pbx = fields.pbx_call_id ?? "";
  const base = `${event}:${pbx}:${fields.call_start ?? ""}`;
  const mk = (suffix: string, type: ProviderEvent["type"], leg: "agent" | "lead", extra: Partial<ProviderEvent> = {}): ProviderEvent => ({
    provider: "zadarma", eventId: `${base}:${suffix}`, type, leg, callId: call.id, legId: leg === "agent" ? call.agentLegId ?? `zd-cb-${call.id}` : pbx, raw: fields, occurredAt: new Date(), ...extra,
  });
  const events: ProviderEvent[] = [];
  if (event === "NOTIFY_OUT_START") {
    // Zadarma starts the outgoing leg only after the agent answered the callback: agent connected, customer leg id known.
    // Not "ringing": a provider failure right after this must stay a technical failure (no attempt charged).
    events.push(mk("agent", "leg.answered", "agent"), mk("lead", "other", "lead"));
  } else if (event === "NOTIFY_OUT_END") {
    const d = mapDisposition(fields.disposition ?? "");
    events.push(mk("agent", "leg.answered", "agent"), mk("lead", "other", "lead"));
    if (d.answered) events.push(mk("answered", "leg.answered", "lead", { occurredAt: new Date(Date.now() - Math.max(0, Number(fields.duration) || 0) * 1000) }));
    events.push(mk("hangup", "leg.hangup", "lead", { hangupCause: d.hangupCause, hangupSource: "zadarma" }));
    if (d.failure) await recordProviderResult(cred.businessId, "zadarma", { ok: false, failureClass: d.failure, detail: `disposition ${fields.disposition}` });
  } else {
    events.push(mk("record", "recording.saved", "lead", { recordingId: fields.call_id_with_rec }));
  }
  let duplicates = 0;
  for (const ev of events) if ((await processProviderEvent(ev)).duplicate) duplicates++;
  // A live test call whose end event arrived proves the events reach us end to end.
  if (event === "NOTIFY_OUT_END" && call.routingNote === "zadarma_live_test") {
    await prisma.telephonyProviderCredential.update({ where: { id: cred.id }, data: { liveTestPassedAt: new Date(), liveTestCallId: call.id } });
    // Not a customer call: nothing to document, and the owner is free for the next dial.
    await prisma.call.updateMany({ where: { id: call.id, outcomeSavedAt: null }, data: { outcomeSavedAt: new Date(), outcomeNote: "Zadarma live test", activeForUser: null } });
    await prisma.user.updateMany({ where: { id: call.userId, presence: { in: ["in_call", "wrap_up"] } }, data: { presence: "available", presenceAt: new Date() } });
  }
  return { status: 200, body: { ok: true, callId: call.id, duplicates } };
}

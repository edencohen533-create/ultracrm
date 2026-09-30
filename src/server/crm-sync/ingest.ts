/**
 * Applying one inbound change from an external CRM (webhook / poll / initial sync / API push) – the ONLY way external
 * data enters. In order:
 *  1. dedupe by event id (the same delivery twice = once), stale check against the source timestamp / version kept on
 *     the link (an older event never overwrites a newer one), echo check (our own write coming back = no loop);
 *  2. identity: business + connection + record type + external id → one local record. A new contact is linked to an
 *     existing card only on a clear match (same phone AND same email / name); anything ambiguous goes to review –
 *     never merged blindly, never duplicated silently. A card owned by another connection is not touched;
 *  3. fields by source of truth (settings): contact details + handling agent from the external CRM; status /
 *     follow-up only if mapped and in the chosen direction – a local change newer than the last sync is a conflict for
 *     review, not an overwrite; blocks are never lifted by an ordinary external update;
 *  4. an unmapped external agent → review queue (the lead waits, no random agent); an agent change moves the lead
 *     like a transfer (queues follow); selection rules decide what enters work – syncing never dials or messages;
 *  5. history imports are marked historical and raise no "new lead" automations (synced leads never do – starting a
 *     queue is a separate, explicit step).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { audit } from "@/lib/audit";
import { OPEN_LEAD_STATUSES } from "@/lib/crm/labels";
import type { CrmSettings } from "./settings";
import type { ExtContact, ExtLead, InboundChange } from "./types";

type Conn = { id: string; businessId: string; name: string; priority: number; createdById: string | null; settings: CrmSettings };
export type ApplyResult = { status: "applied" | "skipped_duplicate" | "skipped_stale" | "skipped_echo" | "review" | "conflict" | "failed"; localId?: string | null; message?: string; reviewIds?: string[] };

const ts = (s?: string | null) => { if (!s) return null; const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d; };
const norm = (s?: string | null) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

async function review(conn: Conn, kind: string, recordType: string, externalId: string, localId: string | null, details: Record<string, unknown>) {
  const r = await prisma.crmReviewItem.upsert({
    where: { connectionId_kind_recordType_externalId: { connectionId: conn.id, kind, recordType, externalId } },
    create: { businessId: conn.businessId, connectionId: conn.id, kind, recordType, externalId, localId, details: details as Prisma.InputJsonValue },
    update: { status: "open", localId, details: details as Prisma.InputJsonValue, resolvedAt: null, resolution: null },
  });
  return r.id;
}

/** Local user for an external agent id – only an active, non-support user of THIS business that the mapping names. */
async function mapOwner(conn: Conn, ext: string | null | undefined) {
  if (!ext) return { userId: null as string | null, unmapped: false };
  const local = conn.settings.userMap[ext];
  if (!local) return { userId: null, unmapped: true };
  const u = await prisma.user.findFirst({ where: { id: local, businessId: conn.businessId, isActive: true, isSupport: false }, select: { id: true } });
  return { userId: u?.id ?? null, unmapped: !u };
}

async function linkOf(conn: Conn, recordType: string, externalId: string) {
  return prisma.externalRecordLink.findUnique({ where: { businessId_connectionId_recordType_externalId: { businessId: conn.businessId, connectionId: conn.id, recordType, externalId } } });
}

function isStale(link: { sourceUpdatedAt: Date | null; sourceVersion: string | null } | null, at: Date | null, version?: string | null) {
  if (!link) return false;
  if (version && link.sourceVersion && /^\d+$/.test(version) && /^\d+$/.test(link.sourceVersion)) return Number(version) <= Number(link.sourceVersion);
  return Boolean(at && link.sourceUpdatedAt && at.getTime() <= link.sourceUpdatedAt.getTime());
}

async function applyContact(conn: Conn, c: ExtContact, at: Date | null, historical: boolean): Promise<ApplyResult> {
  const link = await linkOf(conn, "contact", c.externalId);
  if (isStale(link, at, c.version)) return { status: "skipped_stale", localId: link?.localId ?? null };
  const phones = [...new Set((c.phones ?? []).map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p)))];
  const email = c.email?.trim().toLowerCase() || null;
  const owner = await mapOwner(conn, c.ownerExternalId);
  const reviews: string[] = [];

  if (c.deleted) {
    if (!link?.localId) return { status: "applied", localId: null, message: "deleted before it was linked" };
    await prisma.externalRecordLink.update({ where: { id: link.id }, data: { deletedAt: new Date(), sourceUpdatedAt: at ?? link.sourceUpdatedAt, sourceVersion: c.version ?? link.sourceVersion, lastSyncedAt: new Date(), selected: false } });
    await stopFutureWork(conn, link.localId, "external_deleted");
    reviews.push(await review(conn, "deleted_external", "contact", c.externalId, link.localId, { name: c.name ?? null, policy: conn.settings.deletionPolicy }));
    return { status: "applied", localId: link.localId, message: "נמחק במקור – פעילות עתידית בוטלה, ההיסטוריה נשמרה", reviewIds: reviews };
  }

  let contactId = link?.localId ?? null;
  if (!contactId) {
    if (!phones.length) return { status: "failed", message: "לרשומה אין טלפון תקין – לא ניתן ליצור איש קשר" };
    // Candidates: any card of this business with one of these phones (main or extra).
    const candidates = await prisma.contact.findMany({ where: { businessId: conn.businessId, OR: [{ phoneE164: { in: phones } }, { phones: { some: { e164: { in: phones } } } }] }, select: { id: true, fullName: true, email: true } });
    if (candidates.length) {
      const owned = await prisma.externalRecordLink.findMany({ where: { businessId: conn.businessId, recordType: "contact", localId: { in: candidates.map((x) => x.id) }, deletedAt: null }, select: { localId: true, connectionId: true, externalId: true } });
      const clear = candidates.filter((x) => (email && x.email?.toLowerCase() === email) || (c.name && norm(x.fullName) === norm(c.name)));
      const free = clear.filter((x) => !owned.some((o) => o.localId === x.id));
      if (candidates.length === 1 && free.length === 1) contactId = free[0].id; // one clear, unowned match → link
      else {
        // Ambiguous (shared phone, different name, several cards, or a card another source already owns): a person decides.
        const id = await review(conn, owned.some((o) => o.connectionId !== conn.id) ? "conflict" : "fuzzy_match", "contact", c.externalId, candidates[0]?.id ?? null, { incoming: { name: c.name ?? null, phones, email }, candidates: candidates.map((x) => ({ id: x.id, name: x.fullName, email: x.email, ownedBy: owned.filter((o) => o.localId === x.id).map((o) => ({ connectionId: o.connectionId, externalId: o.externalId })) })) });
        await prisma.externalRecordLink.upsert({ where: { businessId_connectionId_recordType_externalId: { businessId: conn.businessId, connectionId: conn.id, recordType: "contact", externalId: c.externalId } }, create: { businessId: conn.businessId, connectionId: conn.id, recordType: "contact", externalId: c.externalId, localId: null, snapshot: c as unknown as Prisma.InputJsonValue, sourceUpdatedAt: at, sourceVersion: c.version ?? null, lastSyncedAt: new Date() }, update: { snapshot: c as unknown as Prisma.InputJsonValue } });
        return { status: "review", localId: null, message: "התאמה עמומה – ממתין לבירור", reviewIds: [id] };
      }
    } else {
      const created = await prisma.contact.create({ data: { businessId: conn.businessId, fullName: (c.name?.trim() || phones[0]).slice(0, 120), phoneE164: phones[0], phoneRaw: phones[0], email, source: c.source ?? `crm:${conn.name}`.slice(0, 100), ownerUserId: owner.userId } });
      contactId = created.id;
      await audit(conn.businessId, null, "contact", contactId, "crm_sync.contact_created", { connectionId: conn.id, externalId: c.externalId, historical });
    }
  } else {
    // Only a card this connection owns is updated (its link exists); contact details come from the external CRM.
    const cur = await prisma.contact.findFirst({ where: { id: contactId, businessId: conn.businessId }, select: { id: true, email: true } });
    if (!cur) return { status: "failed", message: "הכרטיס המקושר לא נמצא" };
    const emailFree = email && email !== cur.email ? !(await prisma.contact.findFirst({ where: { businessId: conn.businessId, email, NOT: { id: cur.id } }, select: { id: true } })) : false;
    await prisma.contact.update({ where: { id: cur.id }, data: { ...(c.name ? { fullName: c.name.trim().slice(0, 120) } : {}), ...(emailFree ? { email } : {}), ...(conn.settings.ownerAuthority === "external" && c.ownerExternalId !== undefined && !owner.unmapped ? { ownerUserId: owner.userId } : {}) } });
  }
  // Extra phones are added, never removed (a number may still be in a call / history).
  for (const p of phones) await prisma.contactPhone.upsert({ where: { businessId_e164: { businessId: conn.businessId, e164: p } }, create: { businessId: conn.businessId, contactId: contactId!, e164: p }, update: {} }).catch(() => undefined);
  if (owner.unmapped) reviews.push(await review(conn, "unmapped_owner", "contact", c.externalId, contactId, { ownerExternalId: c.ownerExternalId }));
  if (c.isCustomer || c.purchases?.length) await applyPurchases(conn, contactId!, c, owner.userId);
  await prisma.externalRecordLink.upsert({
    where: { businessId_connectionId_recordType_externalId: { businessId: conn.businessId, connectionId: conn.id, recordType: "contact", externalId: c.externalId } },
    create: { businessId: conn.businessId, connectionId: conn.id, recordType: "contact", externalId: c.externalId, localId: contactId, sourceUpdatedAt: at, sourceVersion: c.version ?? null, lastSyncedAt: new Date(), snapshot: c as unknown as Prisma.InputJsonValue },
    update: { localId: contactId, sourceUpdatedAt: at ?? undefined, sourceVersion: c.version ?? undefined, lastSyncedAt: new Date(), deletedAt: null, snapshot: c as unknown as Prisma.InputJsonValue },
  });
  return { status: reviews.length ? "review" : "applied", localId: contactId, reviewIds: reviews };
}

/** Purchases reported by the source make the person an existing customer (the local customer rules then apply). */
async function applyPurchases(conn: Conn, contactId: string, c: ExtContact, ownerUserId: string | null) {
  const list = c.purchases?.length ? c.purchases : c.isCustomer ? [{ externalId: `customer:${c.externalId}`, amount: 0, currency: "ILS", at: c.updatedAt ?? new Date().toISOString() }] : [];
  for (const p of list) {
    const l = await linkOf(conn, "purchase", p.externalId);
    if (l?.localId) continue;
    const d = await prisma.deal.create({ data: { businessId: conn.businessId, contactId, title: `רכישה (${conn.name})`.slice(0, 160), amount: p.amount, currency: p.currency ?? "ILS", stage: "won", status: "won", closedAt: ts(p.at) ?? new Date(), ownerUserId, notes: `מסונכרן מ-CRM חיצוני, מזהה ${p.externalId}` } });
    await prisma.externalRecordLink.create({ data: { businessId: conn.businessId, connectionId: conn.id, recordType: "purchase", externalId: p.externalId, localId: d.id, lastSyncedAt: new Date() } });
    await (await import("@/lib/crm/customer-identity")).markPurchase(prisma, { businessId: conn.businessId, contactId, actorUserId: null, via: "crm_sync" }).catch(() => undefined);
  }
}

function selected(s: CrmSettings, l: ExtLead) {
  const sel = s.selection;
  if (!sel.statuses.length && !sel.lists.length && !sel.owners.length && !sel.teams.length) return false;
  return (!sel.statuses.length || sel.statuses.includes(l.status ?? "")) && (!sel.lists.length || sel.lists.includes(l.list ?? "")) && (!sel.owners.length || sel.owners.includes(l.ownerExternalId ?? "")) && (!sel.teams.length || sel.teams.includes(l.team ?? ""));
}

async function applyLead(conn: Conn, l: ExtLead, at: Date | null, historical: boolean): Promise<ApplyResult> {
  const link = await linkOf(conn, "lead", l.externalId);
  if (isStale(link, at, l.version)) return { status: "skipped_stale", localId: link?.localId ?? null };
  const cLink = await linkOf(conn, "contact", l.contactExternalId);
  if (!cLink?.localId) return { status: "failed", message: "איש הקשר של הפנייה עוד לא סונכרן / ממתין לבירור" };
  const contactId = cLink.localId;
  const s = conn.settings; const reviews: string[] = [];
  // Our own status write coming back from the source (webhook echo): recorded, nothing re-applied – no loop.
  const out = (link?.lastOutbound ?? {}) as { status?: string; at?: string };
  const echo = Boolean(link && out.status && l.status === out.status && out.at && Date.now() - new Date(out.at).getTime() < 30 * 60_000 && (!l.ownerExternalId || l.ownerExternalId === (link.snapshot as ExtLead | null)?.ownerExternalId));
  if (echo) {
    await prisma.externalRecordLink.update({ where: { id: link!.id }, data: { sourceUpdatedAt: at ?? undefined, sourceVersion: l.version ?? undefined, lastSyncedAt: new Date(), lastOutbound: {} } });
    return { status: "skipped_echo", localId: link!.localId };
  }
  const owner = await mapOwner(conn, l.ownerExternalId);
  if (owner.unmapped) reviews.push(await review(conn, "unmapped_owner", "lead", l.externalId, link?.localId ?? null, { ownerExternalId: l.ownerExternalId }));
  const mapped = l.status ? s.statusMap[l.status] : undefined;
  if (l.status && !mapped && (s.directions.status === "in" || s.directions.status === "both")) reviews.push(await review(conn, "unmapped_status", "lead", l.externalId, link?.localId ?? null, { status: l.status }));
  const statusIn = s.directions.status === "in" || s.directions.status === "both";

  let leadId = link?.localId ?? null;
  const lead = leadId ? await prisma.lead.findFirst({ where: { id: leadId, businessId: conn.businessId } }) : null;
  if (l.deleted) {
    if (lead) {
      await stopFutureWork(conn, contactId, "external_deleted", lead.id);
      if (s.deletionPolicy === "close_lead" && (OPEN_LEAD_STATUSES as readonly string[]).includes(lead.status)) await prisma.lead.update({ where: { id: lead.id }, data: { status: "lost", closedAt: new Date(), closeReason: "נמחק ב-CRM החיצוני" } });
      reviews.push(await review(conn, "deleted_external", "lead", l.externalId, lead.id, { policy: s.deletionPolicy }));
    }
    if (link) await prisma.externalRecordLink.update({ where: { id: link.id }, data: { deletedAt: new Date(), selected: false, sourceUpdatedAt: at ?? undefined, lastSyncedAt: new Date() } });
    return { status: "applied", localId: lead?.id ?? null, reviewIds: reviews };
  }
  if (!lead) {
    // A distinct external opportunity is a distinct local lead – even for the same person (never folded together).
    const created = await prisma.lead.create({ data: {
      businessId: conn.businessId, contactId, title: l.title?.slice(0, 160) ?? null, status: (statusIn && mapped) || "new", source: (l.source ?? `crm:${conn.name}`).slice(0, 100),
      ownerUserId: owner.userId, reviewReason: owner.userId ? null : "external_owner_unmapped",
      sourceAttribution: { channel: "external_crm", connectionId: conn.id, externalId: l.externalId, campaign: l.campaign ?? null, product: l.product ?? null } as Prisma.InputJsonValue,
      ...(historical && at ? { createdAt: at } : {}),
    } });
    leadId = created.id;
    const { recordTouchpoint } = await import("@/lib/marketing/touchpoints");
    await recordTouchpoint(prisma, { businessId: conn.businessId, contactId, leadId, touch: { source: l.source ?? undefined, utm: { campaign: l.campaign ?? undefined } }, fallback: "other", dataSource: `crm:${conn.id}`, dedupeKey: `lead:${leadId}`, occurredAt: at ?? new Date() });
    await audit(conn.businessId, null, "lead", leadId, "crm_sync.lead_created", { connectionId: conn.id, externalId: l.externalId, historical, ownerUserId: owner.userId });
  } else {
    // Status: external value only if mapped and inbound; a local change after our last sync is a conflict, not an overwrite.
    let status = lead.status;
    if (statusIn && mapped && mapped !== lead.status) {
      const localChangedSinceSync = Boolean(link?.lastSyncedAt && lead.updatedAt.getTime() > link.lastSyncedAt.getTime() + 1000 && (link.snapshot as ExtLead | null)?.status !== l.status && s.directions.status === "both");
      if (localChangedSinceSync) reviews.push(await review(conn, "conflict", "lead", l.externalId, lead.id, { field: "status", local: lead.status, external: l.status, mappedTo: mapped }));
      else status = mapped;
    }
    await prisma.lead.update({ where: { id: lead.id }, data: { status, ...(l.title ? { title: l.title.slice(0, 160) } : {}) } });
    // Handling agent from the external CRM: moving it is a transfer (tasks, queues, follow-ups follow).
    if (s.ownerAuthority === "external" && !owner.unmapped && owner.userId !== lead.ownerUserId && l.ownerExternalId !== undefined) {
      if (owner.userId) {
        const { transferLeadBySource } = await import("@/lib/crm/lead-ops");
        await transferLeadBySource(conn.businessId, lead.id, owner.userId, conn.createdById ?? owner.userId);
        await prisma.lead.update({ where: { id: lead.id }, data: { reviewReason: null } });
      } else await prisma.lead.update({ where: { id: lead.id }, data: { ownerUserId: owner.userId, reviewReason: owner.userId ? null : "external_owner_unmapped" } });
    }
  }
  // Follow-up (with the source's time zone) – one task per external opportunity, updated in place.
  if ((s.directions.followUp === "in" || s.directions.followUp === "both") && l.followUpAt !== undefined) await applyFollowUp(conn, leadId!, contactId, l);
  const isSelected = selected(s, l) && !owner.unmapped;
  await prisma.externalRecordLink.upsert({
    where: { businessId_connectionId_recordType_externalId: { businessId: conn.businessId, connectionId: conn.id, recordType: "lead", externalId: l.externalId } },
    create: { businessId: conn.businessId, connectionId: conn.id, recordType: "lead", externalId: l.externalId, localId: leadId, sourceUpdatedAt: at, sourceVersion: l.version ?? null, lastSyncedAt: new Date(), selected: isSelected, snapshot: l as unknown as Prisma.InputJsonValue },
    update: { localId: leadId, sourceUpdatedAt: at ?? undefined, sourceVersion: l.version ?? undefined, lastSyncedAt: new Date(), selected: isSelected, snapshot: l as unknown as Prisma.InputJsonValue, deletedAt: null },
  });
  await syncQueueMembership(conn, contactId, isSelected);
  return { status: reviews.length ? "review" : "applied", localId: leadId, reviewIds: reviews };
}

async function applyFollowUp(conn: Conn, leadId: string, contactId: string, l: ExtLead) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { ownerUserId: true } });
  const key = `crm:${conn.id}:${l.externalId}:followup`;
  const due = ts(l.followUpAt);
  if (!due) { await prisma.task.updateMany({ where: { businessId: conn.businessId, requestKey: key, status: "open" }, data: { status: "cancelled" } }); return; }
  if (!lead?.ownerUserId) return;
  await prisma.task.upsert({
    where: { businessId_requestKey: { businessId: conn.businessId, requestKey: key } },
    create: { businessId: conn.businessId, userId: lead.ownerUserId, contactId, leadId, type: "callback", dueAt: due, status: "open", title: "פולואפ (מ-CRM חיצוני)", requestKey: key, note: l.timezone ? `אזור זמן במקור: ${l.timezone}` : null } as Prisma.TaskUncheckedCreateInput,
    update: { dueAt: due, userId: lead.ownerUserId, status: "open" },
  });
}

/** Explicit queue step: only when the manager turned it on for a list – selected in, deselected / moved out. */
async function syncQueueMembership(conn: Conn, contactId: string, isSelected: boolean) {
  const q = conn.settings.queue;
  if (!q.enabled || !q.listId) return;
  const list = await prisma.dialList.findFirst({ where: { id: q.listId, businessId: conn.businessId }, select: { id: true } });
  if (!list) return;
  if (isSelected) await prisma.listLead.upsert({ where: { listId_contactId: { listId: list.id, contactId } }, create: { businessId: conn.businessId, listId: list.id, contactId }, update: {} });
  else await prisma.listLead.updateMany({ where: { listId: list.id, contactId, status: { in: ["pending", "callback"] } }, data: { status: "removed" } });
}
/** External deletion: future work stops (queues, open follow-ups); calls / messages / history are never deleted. */
async function stopFutureWork(conn: Conn, contactId: string, why: string, leadId?: string) {
  await prisma.listLead.updateMany({ where: { businessId: conn.businessId, contactId, status: { in: ["pending", "callback"] } }, data: { status: "removed" } });
  await prisma.task.updateMany({ where: { businessId: conn.businessId, contactId, status: "open", ...(leadId ? { leadId } : {}), requestKey: { startsWith: `crm:${conn.id}:` } }, data: { status: "cancelled" } });
  await audit(conn.businessId, null, "contact", contactId, "crm_sync.future_work_stopped", { connectionId: conn.id, why });
}

/** Entry point: dedupe → apply → record. `kind` = webhook | poll | initial | reconcile | api. */
export async function applyChange(conn: Conn, change: InboundChange, opts: { kind: string; historical?: boolean; correlationId?: string | null }): Promise<ApplyResult> {
  const at = ts(change.occurredAt) ?? ts(change.record.updatedAt);
  let ev;
  try {
    ev = await prisma.crmSyncEvent.create({ data: { businessId: conn.businessId, connectionId: conn.id, eventId: change.eventId.slice(0, 300), kind: opts.kind, recordType: change.recordType, externalId: change.record.externalId, occurredAt: at, payload: change.record as unknown as Prisma.InputJsonValue, correlationId: opts.correlationId ?? null } });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      const prev = await prisma.crmSyncEvent.findUnique({ where: { connectionId_eventId: { connectionId: conn.id, eventId: change.eventId.slice(0, 300) } } });
      // A failed event may be delivered again (retry) – that is processed; an applied one is a duplicate.
      if (!prev || prev.status !== "failed") return { status: "skipped_duplicate", localId: (prev?.result as { localId?: string } | null)?.localId ?? null };
      ev = await prisma.crmSyncEvent.update({ where: { id: prev.id }, data: { attempts: { increment: 1 } } });
    } else throw e;
  }
  let r: ApplyResult;
  try {
    r = change.recordType === "contact" ? await applyContact(conn, change.record, at, Boolean(opts.historical)) : await applyLead(conn, change.record, at, Boolean(opts.historical));
  } catch (e) { r = { status: "failed", message: (e as Error).message.slice(0, 300) }; }
  await prisma.crmSyncEvent.update({ where: { id: ev.id }, data: { status: r.status, error: r.status === "failed" ? r.message ?? null : null, result: { localId: r.localId ?? null, reviewIds: r.reviewIds ?? [], message: r.message ?? null } as Prisma.InputJsonValue, processedAt: new Date() } });
  if (r.status !== "failed") await prisma.crmConnection.update({ where: { id: conn.id }, data: { lastSyncAt: new Date(), lastSyncStatus: "ok" } });
  return r;
}

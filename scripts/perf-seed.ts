/**
 * Performance seed for the LOCAL isolated DB only: one "[PERF]" business with realistic volume, so heavy queries
 * show up in measurements (the demo business is too small). Wiped and recreated on every run.
 *   npx tsx scripts/perf-seed.ts
 * Login: perf-volume@local.test / PerfLocal!2026 (owner). Nothing here ever touches a non-local database.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost):5544\//.test(url)) { console.error("refusing: perf seed only runs against the local isolated DB on :5544"); process.exit(1); }
const CONTACTS = Number(process.env.CONTACTS ?? 20000), AGENTS = 20, CONVS = Number(process.env.CONVS ?? 3000), MSGS = 30, CALLS = Number(process.env.CALLS ?? 60000);
const id = () => crypto.randomBytes(12).toString("hex");
const chunk = async <T,>(rows: T[], fn: (c: T[]) => Promise<unknown>, n = 5000) => { for (let i = 0; i < rows.length; i += n) await fn(rows.slice(i, i + n)); };

async function main() {
  const old = await db.business.findMany({ where: { slug: { startsWith: "perf-volume" } }, select: { id: true } });
  for (const b of old) { await db.$executeRawUnsafe(`DELETE FROM messages WHERE business_id = $1`, b.id); await db.$executeRawUnsafe(`DELETE FROM calls WHERE business_id = $1`, b.id); await db.conversation.deleteMany({ where: { businessId: b.id } }); await db.business.delete({ where: { id: b.id } }); }
  await db.account.deleteMany({ where: { email: { endsWith: "@perf.local" } } });
  await db.account.deleteMany({ where: { email: "perf-volume@local.test" } });
  const t0 = Date.now();
  const biz = await db.business.create({ data: { name: "[PERF] נפח", slug: `perf-volume-${Date.now()}`, modules: { crm: true, telephony: true, whatsapp: true, sms: true, email: true }, settings: { timezone: "Asia/Jerusalem", dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } });
  const hash = await bcrypt.hash("PerfLocal!2026", 8);
  const ownerAcc = await db.account.create({ data: { email: "perf-volume@local.test", fullName: "Perf Volume", passwordHash: hash, claimedAt: new Date() } });
  const owner = await db.user.create({ data: { businessId: biz.id, accountId: ownerAcc.id, email: ownerAcc.email, fullName: "Perf Volume", role: "owner" } });
  const agents: string[] = [];
  for (let i = 0; i < AGENTS; i++) { const a = await db.account.create({ data: { email: `agent${i}@perf.local`, fullName: `נציג ${i}`, passwordHash: hash, claimedAt: new Date() } }); agents.push((await db.user.create({ data: { businessId: biz.id, accountId: a.id, email: a.email, fullName: a.fullName, role: "agent" } })).id); }
  await db.providerCredential.create({ data: { businessId: biz.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
  const day = 86400_000, now = Date.now();
  const contacts = Array.from({ length: CONTACTS }, (_, i) => ({ id: id(), businessId: biz.id, fullName: `לקוח ${i}`, phoneE164: `+97250${String(1000000 + i).padStart(7, "0")}`, phoneRaw: "x", ownerUserId: agents[i % AGENTS], source: ["facebook", "google", "site"][i % 3], customFields: { product: ["מגנזיום", "ויטמין D", "אומגה 3"][i % 3] }, createdAt: new Date(now - (i % 90) * day) }));
  await chunk(contacts, (c) => db.contact.createMany({ data: c }));
  const statuses = ["new", "contacted", "follow_up", "qualified", "unqualified", "converted", "lost"] as const;
  await chunk(contacts.map((c, i) => ({ id: id(), businessId: biz.id, contactId: c.id, ownerUserId: c.ownerUserId, status: statuses[i % statuses.length], source: c.source, createdAt: c.createdAt })), (c) => db.lead.createMany({ data: c }));
  const list = await db.dialList.create({ data: { businessId: biz.id, name: "קמפיין נפח" } });
  await chunk(contacts.slice(0, 10000).map((c, i) => ({ id: id(), businessId: biz.id, listId: list.id, contactId: c.id, status: (["pending", "callback", "completed", "exhausted"] as const)[i % 4], attempts: i % 5 })), (c) => db.listLead.createMany({ data: c }));
  await chunk(Array.from({ length: CALLS }, (_, i) => { const c = contacts[i % CONTACTS]; const at = new Date(now - (i % 60) * day - (i % 600) * 60_000); const ans = i % 3 !== 0;
    return { id: id(), businessId: biz.id, userId: agents[i % AGENTS], contactId: c.id, listId: i % 2 ? list.id : null, direction: "outbound" as const, mode: "power" as const, provider: "mock" as const, idempotencyKey: id(), toE164: c.phoneE164, fromE164: "+97230000000", agentLegId: `leg-${i}`, status: "ended" as const, createdAt: at, answeredAt: ans ? new Date(at.getTime() + 8000) : null, endedAt: new Date(at.getTime() + 90_000), talkSeconds: ans ? 60 + (i % 240) : 0, telephonyResult: ans ? "answered" as const : "no_answer" as const, outcome: ans ? "answered_not_interested" as const : "no_answer" as const, outcomeSavedAt: new Date(at.getTime() + 100_000) }; }), (c) => db.call.createMany({ data: c }));
  await chunk(contacts.slice(0, 600).map((c, i) => ({ id: id(), businessId: biz.id, contactId: c.id, title: `עסקה ${i}`, amount: 500 + (i % 10) * 100, status: "won" as const, stage: "won" as const, ownerUserId: c.ownerUserId, closedAt: new Date(now - (i % 60) * day) })), (c) => db.deal.createMany({ data: c }));
  const convs = contacts.slice(0, CONVS).map((c, i) => ({ id: id(), businessId: biz.id, contactId: c.id, channel: "whatsapp" as const, assignedAgentId: i % 4 ? c.ownerUserId : null, lastMessageAt: new Date(now - i * 60_000), lastInboundAt: new Date(now - i * 60_000) }));
  await chunk(convs, (c) => db.conversation.createMany({ data: c }));
  const msgs = convs.flatMap((cv, i) => Array.from({ length: MSGS }, (_, k) => ({ id: id(), businessId: biz.id, conversationId: cv.id, channel: "whatsapp" as const, direction: (k % 2 ? "OUTBOUND" : "INBOUND") as "OUTBOUND" | "INBOUND", type: "TEXT" as const, body: `הודעה ${k} בשיחה ${i}`, status: "DELIVERED" as const, createdAt: new Date(now - i * 60_000 - (MSGS - k) * 30_000) })));
  await chunk(msgs, (c) => db.message.createMany({ data: c }), 10000);
  console.log(JSON.stringify({ businessId: biz.id, ownerId: owner.id, contacts: CONTACTS, calls: CALLS, conversations: CONVS, messages: msgs.length, seconds: Math.round((Date.now() - t0) / 1000) }));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

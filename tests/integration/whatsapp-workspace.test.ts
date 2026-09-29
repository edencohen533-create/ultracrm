/**
 * WhatsApp workspace (real DB, mock WhatsApp, no model):
 *  • "תוסיף ליד: …" from a verified internal user creates the lead in the right business, asks one focused question
 *    when something is missing or several products match, never derives a campaign / ad from "פייסבוק", refuses the
 *    block list, does not duplicate an open lead (other number format too) or a retried webhook; a customer (not a
 *    linked user) writing the same text is just a customer message.
 *  • "תיק לקוח" next to the conversation: lead + purchases + open opportunity + store order + documents, missing
 *    values null, nothing from another contact; restricted views for no CRM permission / another agent's contact.
 *  • "WhatsApp" in contacts opens the contact's own thread; refused with the reason for a blocked contact.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { handleAssistantInbound } from "@/server/assistant/inbound";
import { customerFile } from "@/server/services/customer-file-service";
import { POST as whatsappPOST } from "@/app/api/contacts/[id]/whatsapp/route";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
let agent: SessionUser, agent2: SessionUser;
const accounts: string[] = [];
const OWNER_PHONE = `+97250${String(Date.now()).slice(-7)}`;
const B_OWNER_PHONE = `+97253${String(Date.now()).slice(-7)}`;
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
let seq = 0;
const newPhone = () => { seq++; return `05${4 + (seq % 3)}${String(1000000 + ((Date.now() / 7) % 8000000) + seq * 37).slice(0, 7)}`; };
const e164 = (local: string) => `+972${local.slice(1)}`;

async function say(biz: Biz, phone: string, text: string, providerMessageId: string = crypto.randomUUID()) {
  const before = new Date();
  const handled = await withBusiness(biz.business.id, () => handleAssistantInbound({ businessId: biz.business.id, phoneE164: phone, text, providerMessageId }));
  const out = await db.assistantMessage.findFirst({ where: { businessId: biz.business.id, direction: "out", link: { phoneE164: phone }, createdAt: { gte: before } }, orderBy: { createdAt: "desc" } });
  return { handled, reply: out?.text ?? "" };
}
const leadsFor = (biz: Biz, local: string) => withBusiness(biz.business.id, () => db.lead.findMany({ where: { businessId: biz.business.id, contact: { phoneE164: e164(local) } }, include: { contact: true } }));
async function member(biz: Biz, role: "manager" | "agent", name: string): Promise<SessionUser> {
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: biz.business.id, accountId: acc.id, email: acc.email, fullName: name, role } });
  return { id: u.id, accountId: acc.id, businessId: biz.business.id, email: acc.email, fullName: name, role, teamId: null };
}
async function req(user: SessionUser, url: string, method = "POST") {
  return new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(user)}` } });
}

describe("WhatsApp workspace", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
    A = await createBusiness("wa-ws-a", { modules: { crm: true, telephony: true, whatsapp: true } });
    B = await createBusiness("wa-ws-b", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(A.account.id, B.account.id);
    agent = await member(A, "agent", "דנה נציגה");
    agent2 = await member(A, "agent", "יוסי נציג");
    for (const [biz, phone] of [[A, OWNER_PHONE], [B, B_OWNER_PHONE]] as const) {
      await db.providerCredential.create({ data: { businessId: biz.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
      const x = await db.business.findUniqueOrThrow({ where: { id: biz.business.id } });
      await db.business.update({ where: { id: biz.business.id }, data: { settings: { ...(x.settings as object), timezone: "Asia/Jerusalem", assistant: { enabled: true, daily: { enabled: false, time: "19:00", days: [] } }, leadAssignment: { mode: "round_robin", maxOpenLeadsPerAgent: 0, agentIds: [agent.id, agent2.id], perAgentMax: {}, lastAssignedUserId: null, notifyWhatsApp: { enabled: false, templateId: null } } } as object } });
      await db.assistantLink.create({ data: { businessId: biz.business.id, userId: biz.user.id, phoneE164: phone, status: "active", verifiedAt: new Date(), scope: "business", createdById: biz.user.id } });
    }
    await db.coachKnowledge.create({ data: { businessId: A.business.id, products: [{ name: "מגנזיום ציטרט" }, { name: "מגנזיום ביסגליצינט" }, { name: "ויטמין D" }] } });
  }, 600_000);
  afterAll(async () => { for (const b of [A, B]) if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("creates the lead from free text in the right business, assigned by the existing rules, with a link – no campaign or ad invented", async () => {
    const phone = newPhone();
    const { handled, reply } = await say(A, OWNER_PHONE, `תוסיף ליד: דנה כהן, ${phone}, ויטמין D, מקור פייסבוק`);
    expect(handled).toBe(true);
    const leads = await leadsFor(A, phone);
    expect(leads).toHaveLength(1);
    const [l] = leads;
    expect(l.contact.fullName).toBe("דנה כהן");
    expect(l.source).toBe("פייסבוק");
    expect((l.contact.customFields as Record<string, unknown>).product).toBe("ויטמין D");
    expect((l.contact.customFields as Record<string, unknown>).campaign).toBeUndefined();
    expect((l.contact.customFields as Record<string, unknown>).ad).toBeUndefined();
    expect(l.sourceAttribution).toMatchObject({ adId: null, campaignId: null });
    expect([agent.id, agent2.id]).toContain(l.ownerUserId);
    expect(reply).toContain("✅ הליד נשמר");
    expect(reply).toContain(`/leads/${l.id}`);
    expect(reply).toContain("קמפיין / מודעה: לא ידוע");
    expect(await withBusiness(B.business.id, () => db.lead.count({ where: { businessId: B.business.id } }))).toBe(0);
    expect(await withBusiness(A.business.id, () => db.auditLog.count({ where: { businessId: A.business.id, action: "assistant.lead_created", entityId: l.id } }))).toBe(1);
  });

  it("a retried webhook (same message id) creates nothing twice and replies once", async () => {
    const phone = newPhone(); const id = `wamid.${crypto.randomUUID()}`;
    await say(A, OWNER_PHONE, `ליד חדש: רון לוי, ${phone}, ויטמין D, מקור אתר`, id);
    await say(A, OWNER_PHONE, `ליד חדש: רון לוי, ${phone}, ויטמין D, מקור אתר`, id);
    expect(await leadsFor(A, phone)).toHaveLength(1);
    const outs = await db.assistantMessage.count({ where: { businessId: A.business.id, direction: "out", intent: "create_lead", text: { contains: "רון לוי" } } });
    expect(outs).toBe(1);
  });

  it("asks one focused question for a missing field and for several matching products; then saves", async () => {
    const phone = newPhone();
    let r = await say(A, OWNER_PHONE, "תוסיף ליד מיכל אברהם, מגנזיום, מקור אינסטגרם");
    expect(r.reply).toContain("מה מספר הטלפון");
    r = await say(A, OWNER_PHONE, "12345");
    expect(r.reply).toContain("לא זיהיתי מספר טלפון");
    r = await say(A, OWNER_PHONE, "0000000000");
    expect(r.reply).toContain("אינו מספר טלפון תקין");
    r = await say(A, OWNER_PHONE, phone.replace(/^(\d{3})/, "$1-"));
    expect(r.reply).toContain("כמה מוצרים מתאימים");
    expect(r.reply).toContain("מגנזיום ציטרט"); expect(r.reply).toContain("מגנזיום ביסגליצינט");
    expect(await leadsFor(A, phone)).toHaveLength(0); // nothing saved before the answers
    r = await say(A, OWNER_PHONE, "2");
    expect(r.reply).toContain("✅ הליד נשמר");
    const [l] = await leadsFor(A, phone);
    expect((l.contact.customFields as Record<string, unknown>).product).toBe("מגנזיום ביסגליצינט");
    expect(l.source).toBe("אינסטגרם");
    // Source and product may be answered "none" – left empty, not guessed.
    const p2 = newPhone();
    r = await say(A, OWNER_PHONE, `תוסיף ליד: שירה, ${p2}`);
    expect(r.reply).toContain("איזה מוצר");
    r = await say(A, OWNER_PHONE, "אין");
    expect(r.reply).toContain("מה המקור");
    r = await say(A, OWNER_PHONE, "לא ידוע");
    expect(r.reply).toContain("✅ הליד נשמר");
    expect(r.reply).toContain("מוצר: לא צוין");
    const [l2] = await leadsFor(A, p2);
    expect((l2.contact.customFields as Record<string, unknown> | null)?.product).toBeUndefined();
    // "בטל" drops a draft.
    r = await say(A, OWNER_PHONE, "תוסיף ליד: אבי");
    expect(r.reply).toContain("מה מספר הטלפון");
    r = await say(A, OWNER_PHONE, "בטל");
    expect(r.reply).toContain("לא נוצר ליד");
  });

  it("no duplicate for an open lead (other number format), block list refused, customers cannot run the command", async () => {
    const phone = newPhone();
    await say(A, OWNER_PHONE, `תוסיף ליד: עומר, ${phone}, ויטמין D, מקור גוגל`);
    const r = await say(A, OWNER_PHONE, `תוסיף ליד: עומר, +972 ${phone.slice(1, 3)} ${phone.slice(3)}, ויטמין D, מקור גוגל`);
    expect(r.reply).toContain("כבר קיים ליד פתוח");
    expect(await leadsFor(A, phone)).toHaveLength(1);
    const blocked = newPhone();
    await db.dncEntry.create({ data: { businessId: A.business.id, phoneE164: e164(blocked), reason: "test" } });
    const rb = await say(A, OWNER_PHONE, `תוסיף ליד: חסום, ${blocked}, ויטמין D, מקור אתר`);
    expect(rb.reply).toContain("לא נוצר ליד");
    expect(await leadsFor(A, blocked)).toHaveLength(0);
    // A customer's phone (no verified link) → not handled by the assistant at all.
    const customer = `+97258${String(Date.now()).slice(-7)}`;
    const h = await withBusiness(A.business.id, () => handleAssistantInbound({ businessId: A.business.id, phoneE164: customer, text: `תוסיף ליד: האקר, ${newPhone()}, ויטמין D, מקור אתר`, providerMessageId: crypto.randomUUID() }));
    expect(h).toBe(false);
  });

  it("a verified internal user without the 'create leads' permission is refused – nothing is created", async () => {
    const viewer = await member(A, "agent", "צופה בלבד");
    await db.user.update({ where: { id: viewer.id }, data: { permissions: { template: "custom", scope: "own", modules: { crm: { enabled: true, actions: ["view"] } } } } });
    const phone = `+97254${String(Date.now()).slice(-7)}`;
    await db.assistantLink.create({ data: { businessId: A.business.id, userId: viewer.id, phoneE164: phone, status: "active", verifiedAt: new Date(), scope: "own", createdById: A.user.id } });
    const lp = newPhone();
    const r = await say(A, phone, `תוסיף ליד: ללא הרשאה, ${lp}, ויטמין D, מקור אתר`);
    expect(r.reply).toContain("אין לך הרשאה ליצור לידים");
    expect(await leadsFor(A, lp)).toHaveLength(0);
  });

  it("customer file: lead, purchases, open opportunity, store order and documents – missing values null, no mixing between customers", async () => {
    const c1 = await db.contact.create({ data: { businessId: A.business.id, fullName: "לקוח ותיק", phoneE164: e164(newPhone()), phoneRaw: "x", ownerUserId: agent.id, customFields: { product: "מגנזיום ציטרט", campaign: "קיץ 2026" } } });
    const c2 = await db.contact.create({ data: { businessId: A.business.id, fullName: "לקוח אחר", phoneE164: e164(newPhone()), phoneRaw: "x", ownerUserId: agent.id } });
    await db.lead.create({ data: { businessId: A.business.id, contactId: c1.id, status: "contacted", source: "פייסבוק", ownerUserId: agent.id } });
    const won = await db.deal.create({ data: { businessId: A.business.id, contactId: c1.id, title: "מנוי שנתי", amount: 1200, status: "won", stage: "won", closedAt: new Date("2026-05-01"), ownerUserId: agent.id } });
    await db.dealItem.create({ data: { businessId: A.business.id, dealId: won.id, contactId: c1.id, name: "מגנזיום ציטרט", quantity: 2, unitPrice: 600, startsAt: new Date("2026-05-01"), endsAt: new Date("2027-05-01") } });
    await db.deal.create({ data: { businessId: A.business.id, contactId: c1.id, title: "שדרוג", amount: 300, status: "open", stage: "proposal", ownerUserId: agent.id } });
    const store = await db.storeConnection.create({ data: { businessId: A.business.id, platform: "woocommerce", name: "חנות", publicKey: crypto.randomUUID() } });
    await db.cart.create({ data: { businessId: A.business.id, storeId: store.id, externalId: crypto.randomUUID(), contactId: c1.id, status: "converted", orderId: "1001", orderTotal: 250, currency: "ILS", convertedAt: new Date("2026-06-01"), items: [{ name: "ויטמין D", quantity: 1, price: 250 }] } });
    const conv = await db.conversation.create({ data: { businessId: A.business.id, contactId: c1.id, channel: "whatsapp", assignedAgentId: agent.id } });
    const msg = await db.message.create({ data: { businessId: A.business.id, conversationId: conv.id, direction: "INBOUND", type: "DOCUMENT", body: "", status: "DELIVERED" } });
    await db.messageAttachment.create({ data: { messageId: msg.id, url: "/api/attachments/x1", mimeType: "application/pdf", fileName: "קבלה-1001.pdf" } });
    await db.messageAttachment.create({ data: { messageId: msg.id, url: "/api/attachments/x2", mimeType: "image/jpeg", fileName: "photo.jpg" } });

    const f1 = (await run(agent, () => customerFile(agent, c1.id, { crmView: true })))!;
    expect(f1.restricted).toBeNull();
    expect(f1.leads[0]).toMatchObject({ status: "contacted", source: "פייסבוק", owner: "דנה נציגה", adId: null });
    expect(f1.contact).toMatchObject({ product: "מגנזיום ציטרט", campaign: "קיץ 2026", ad: null });
    expect(f1.purchases).toHaveLength(1);
    expect(f1.purchases[0]).toMatchObject({ title: "מנוי שנתי", amount: 1200, items: [expect.objectContaining({ name: "מגנזיום ציטרט", quantity: 2 })] });
    expect(f1.opportunities).toHaveLength(1);
    expect(f1.orders[0]).toMatchObject({ orderId: "1001", total: 250, items: [{ name: "ויטמין D", quantity: 1, price: 250 }] });
    expect(f1.documents.map((d) => d.fileName)).toEqual(["קבלה-1001.pdf"]);

    const f2 = (await run(agent, () => customerFile(agent, c2.id, { crmView: true })))!;
    expect(f2.contact.name).toBe("לקוח אחר");
    expect(f2.leads).toHaveLength(0); expect(f2.purchases).toHaveLength(0); expect(f2.orders).toHaveLength(0); expect(f2.documents).toHaveLength(0);
    expect(f2.contact.product).toBeNull();

    // Another agent: identity only. No CRM permission: identity only.
    expect((await run(agent2, () => customerFile(agent2, c1.id, { crmView: true })))!).toMatchObject({ restricted: "not_yours", purchases: [], leads: [] });
    expect((await run(agent, () => customerFile(agent, c1.id, { crmView: false })))!).toMatchObject({ restricted: "no_crm", purchases: [] });
    // Another business cannot load it.
    expect(await run(B.session, () => customerFile(B.session, c1.id, { crmView: true }))).toBeNull();
  });

  it("contacts → WhatsApp opens the contact's own thread (reused), refused with the reason for a blocked contact", async () => {
    const c = await db.contact.create({ data: { businessId: A.business.id, fullName: "פתיחת וואטסאפ", phoneE164: e164(newPhone()), phoneRaw: "x", ownerUserId: agent.id } });
    const r1 = await run(agent, async () => whatsappPOST(await req(agent, `/api/contacts/${c.id}/whatsapp`), { params: Promise.resolve({ id: c.id }) }));
    expect(r1.status).toBe(200);
    const id1 = (await r1.json()).data.conversationId;
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: id1 } });
    expect(conv).toMatchObject({ contactId: c.id, channel: "whatsapp" });
    const r2 = await run(agent, async () => whatsappPOST(await req(agent, `/api/contacts/${c.id}/whatsapp`), { params: Promise.resolve({ id: c.id }) }));
    expect((await r2.json()).data.conversationId).toBe(id1);
    // Another agent's contact → not found.
    const r3 = await run(agent2, async () => whatsappPOST(await req(agent2, `/api/contacts/${c.id}/whatsapp`), { params: Promise.resolve({ id: c.id }) }));
    expect(r3.status).toBe(404);
    // Fully blocked → 403 with the reason.
    await db.contact.update({ where: { id: c.id }, data: { isBlocked: true } });
    const r4 = await run(agent, async () => whatsappPOST(await req(agent, `/api/contacts/${c.id}/whatsapp`), { params: Promise.resolve({ id: c.id }) }));
    expect(r4.status).toBe(403);
    expect(JSON.stringify(await r4.json())).toContain("חסום");
  });
});

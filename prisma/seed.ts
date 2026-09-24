/**
 * UltraCRM demo seed – clearly marked TEST DATA (business slugs `demo-*`,
 * emails `@demo.local`, contact names prefixed with "[דמו]").
 *
 * Creates: two plans, two isolated businesses (for tenant-isolation checks), one
 * account that is a member of both, owner/manager/agents, contacts with tags,
 * leads, deals, tasks, a dial list, WhatsApp templates / canned replies (mock
 * provider) and one suppressed contact. Safe to re-run (idempotent upserts).
 *
 * Simulation hints (telephony mock): numbers ending in 0 → no answer, 1 → busy, 2 → rejected, otherwise → answered.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const schema = url.searchParams.get("schema") ?? "public";
url.searchParams.delete("schema");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });

export const DEMO_PASSWORD = "Demo1234!";

async function main() {
  const starter = await prisma.plan.upsert({ where: { key: "starter" }, update: {}, create: { key: "starter", name: "Starter", modules: { crm: true, messaging: true, telephony: false }, quotas: { users: 5, contacts: 2000, messages_sent: 1000, campaigns_started: 5 } } });
  const pro = await prisma.plan.upsert({ where: { key: "pro" }, update: {}, create: { key: "pro", name: "Pro", modules: { crm: true, messaging: true, telephony: true }, quotas: { users: 50, contacts: 100000, messages_sent: 50000, calls_started: 50000, campaigns_started: 100 } } });

  const openWindow = { wrapUpSeconds: 60, autoDialCountdownSeconds: 5, maxAttempts: 3, retryIntervalMinutes: 120, recordingEnabled: false, dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6], timezone: "Asia/Jerusalem" } };
  const business = await prisma.business.upsert({
    where: { slug: "demo-a" },
    update: { planId: pro.id, settings: openWindow },
    create: { name: "[דמו] סולינה מכירות", slug: "demo-a", planId: pro.id, settings: openWindow },
  });
  const businessB = await prisma.business.upsert({
    where: { slug: "demo-b" },
    update: { planId: starter.id },
    create: { name: "[דמו] עסק שני (בידוד)", slug: "demo-b", planId: starter.id, settings: openWindow },
  });

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const account = async (email: string, fullName: string) => prisma.account.upsert({ where: { email }, update: { fullName }, create: { email, fullName, passwordHash: hash } });
  const member = async (businessId: string, accountId: string, email: string, fullName: string, role: "owner" | "manager" | "agent", teamId?: string) =>
    prisma.user.upsert({ where: { businessId_accountId: { businessId, accountId } }, update: { role, teamId: teamId ?? undefined, fullName }, create: { businessId, accountId, email, fullName, role, teamId } });

  const ownerAcc = await account("owner@demo.local", "אורן בעלים");
  const managerAcc = await account("manager@demo.local", "יעל מנהלת");
  const agent1Acc = await account("agent1@demo.local", "דנה כהן");
  const agent2Acc = await account("agent2@demo.local", "אבי לוי");
  const ownerBAcc = await account("owner-b@demo.local", "בעלים עסק ב");

  const owner = await member(business.id, ownerAcc.id, ownerAcc.email, ownerAcc.fullName, "owner");
  const manager = await member(business.id, managerAcc.id, managerAcc.email, managerAcc.fullName, "manager");
  let team = await prisma.team.findFirst({ where: { businessId: business.id, name: "צוות מכירות" } });
  if (!team) team = await prisma.team.create({ data: { businessId: business.id, name: "צוות מכירות", managerId: manager.id } });
  await prisma.user.update({ where: { id: manager.id }, data: { teamId: team.id } });
  const agent1 = await member(business.id, agent1Acc.id, agent1Acc.email, agent1Acc.fullName, "agent", team.id);
  const agent2 = await member(business.id, agent2Acc.id, agent2Acc.email, agent2Acc.fullName, "agent", team.id);
  // The owner of business A is also a member (agent) of business B → single login, business switcher.
  await member(businessB.id, ownerBAcc.id, ownerBAcc.email, ownerBAcc.fullName, "owner");
  await member(businessB.id, ownerAcc.id, ownerAcc.email, ownerAcc.fullName, "agent");

  await prisma.phoneNumber.upsert({ where: { businessId_e164: { businessId: business.id, e164: "+97233761234" } }, update: {}, create: { businessId: business.id, e164: "+97233761234", label: "מספר ראשי (דמו)", isDefault: true, provider: "mock" } });

  const script = (await prisma.script.findFirst({ where: { businessId: business.id } })) ?? (await prisma.script.create({ data: { businessId: business.id, title: "תסריט פתיחה", isDefault: true, body: "שלום, מדבר/ת {{agent}} מ{{business}}. אני מתקשר/ת בהמשך לפנייה שלך.\n\n1. לוודא שזה זמן נוח.\n2. להבין את הצורך.\n3. להציע פגישה / הצעה." } }));

  const tagNames = ["VIP", "ליד חם", "לקוח חוזר", "עגלה נטושה", "פרימיום"];
  const tags: Record<string, string> = {};
  for (const [i, name] of tagNames.entries()) {
    const t = await prisma.tag.upsert({ where: { businessId_name: { businessId: business.id, name } }, update: {}, create: { businessId: business.id, name, color: ["#5b6cff", "#f59e0b", "#22c55e", "#ef4444", "#38bdf8"][i] } });
    tags[name] = t.id;
  }

  const names = ["ישראל ישראלי", "שרה כהן", "משה לוי", "רחל אברהם", "יעקב גולן", "מרים שפירא", "אהרון בן דוד", "דבורה פרידמן", "נועה ברק", "עומר חדד", "טל מזרחי", "ליאור פרץ"];
  const contacts = [];
  for (let i = 0; i < names.length; i++) {
    const last = i % 10;
    const phone = `05012345${String(i).padStart(1, "0")}${last}`;
    const e164 = "+972" + phone.slice(1);
    const c = await prisma.contact.upsert({
      where: { businessId_phoneE164: { businessId: business.id, phoneE164: e164 } },
      update: {},
      create: {
        businessId: business.id, fullName: `[דמו] ${names[i]}`, phoneE164: e164, phoneRaw: phone, email: `demo${i}@example.com`,
        source: i % 3 === 0 ? "facebook" : i % 3 === 1 ? "website" : "referral", city: i % 2 ? "תל אביב" : "חיפה", company: i % 4 === 0 ? "חברה בע\"מ" : null,
        ownerUserId: i % 2 ? agent1.id : agent2.id,
        consentStatus: i % 4 === 3 ? "UNKNOWN" : "OPTED_IN", consentAt: i % 4 === 3 ? null : new Date(), consentSource: i % 4 === 3 ? null : "seed", consentScope: "marketing", consentEvidence: i % 4 === 3 ? null : "נתוני דמו – הסכמה מדומה",
        tags: { create: [{ tagId: tags[tagNames[i % tagNames.length]] }] },
      },
    });
    contacts.push(c);
  }

  // Leads & deals & tasks
  for (const [i, c] of contacts.slice(0, 6).entries()) {
    const exists = await prisma.lead.findFirst({ where: { contactId: c.id } });
    if (!exists) await prisma.lead.create({ data: { businessId: business.id, contactId: c.id, title: `פנייה מ-${c.source}`, status: (["new", "contacted", "qualified", "new", "unqualified", "converted"] as const)[i], source: c.source, ownerUserId: i % 2 ? agent1.id : null } });
  }
  if (!(await prisma.deal.findFirst({ where: { businessId: business.id } }))) {
    await prisma.deal.create({ data: { businessId: business.id, contactId: contacts[5].id, title: "מזרן פרימיום + משלוח", amount: 4200, stage: "won", status: "won", closedAt: new Date(), ownerUserId: agent1.id } });
    await prisma.deal.create({ data: { businessId: business.id, contactId: contacts[2].id, title: "חבילת חדר שינה", amount: 9800, stage: "proposal", status: "open", ownerUserId: agent2.id, expectedCloseAt: new Date(Date.now() + 7 * 86400_000) } });
  }
  await prisma.task.upsert({ where: { businessId_requestKey: { businessId: business.id, requestKey: "seed:task:1" } }, update: {}, create: { businessId: business.id, requestKey: "seed:task:1", userId: agent1.id, createdById: manager.id, contactId: contacts[0].id, type: "follow_up", title: "לשלוח הצעת מחיר", dueAt: new Date(Date.now() - 3600_000) } });
  await prisma.task.upsert({ where: { businessId_requestKey: { businessId: business.id, requestKey: "seed:task:2" } }, update: {}, create: { businessId: business.id, requestKey: "seed:task:2", userId: agent2.id, createdById: manager.id, contactId: contacts[3].id, type: "todo", title: "לבדוק זמינות מלאי", dueAt: new Date(Date.now() + 2 * 3600_000) } });

  // Dial list
  let list = await prisma.dialList.findFirst({ where: { businessId: business.id, name: "[דמו] לידים חמים" } });
  if (!list) list = await prisma.dialList.create({ data: { businessId: business.id, name: "[דמו] לידים חמים", description: "רשימת דמו", priority: 10, scriptId: script.id, agents: { create: [{ userId: agent1.id }, { userId: agent2.id }] } } });
  await prisma.listLead.createMany({ data: contacts.map((c) => ({ businessId: business.id, listId: list!.id, contactId: c.id })), skipDuplicates: true });

  // Messaging: templates + canned replies (mock provider – no Meta credentials)
  const templates = [
    { name: "welcome_message", category: "UTILITY" as const, body: "שלום {{1}}, תודה שפנית אלינו! נציג יחזור אליך בהקדם." },
    { name: "follow_up_after_call", category: "UTILITY" as const, body: "היי {{1}}, תודה על השיחה. מצורף סיכום קצר; נשמח לענות על כל שאלה." },
    { name: "spring_sale", category: "MARKETING" as const, body: "{{1}}, מבצע אביב! 20% הנחה על כל המזרנים עד סוף החודש." },
  ];
  for (const t of templates) {
    await prisma.template.upsert({ where: { businessId_name_language: { businessId: business.id, name: t.name, language: "he" } }, update: {}, create: { businessId: business.id, name: t.name, language: "he", category: t.category, body: t.body, variables: ["1"], status: "APPROVED" } });
  }
  for (const r of [{ title: "ברכת פתיחה", body: "שלום! איך אפשר לעזור?", shortcut: "/hi" }, { title: "שעות פעילות", body: "אנחנו זמינים א-ה 9:00-18:00.", shortcut: "/hours" }]) {
    await prisma.cannedReply.upsert({ where: { businessId_shortcut: { businessId: business.id, shortcut: r.shortcut } }, update: {}, create: { businessId: business.id, ...r, createdByUserId: owner.id } });
  }

  // A contact that asked to be removed from marketing on every channel.
  const optedOut = contacts[7];
  await prisma.contact.update({ where: { id: optedOut.id }, data: { consentStatus: "OPTED_OUT", consentSource: "whatsapp", consentEvidence: "seed unsubscribe" } });
  if (!(await prisma.suppression.findFirst({ where: { businessId: business.id, identifier: optedOut.phoneE164, revokedAt: null } }))) {
    await prisma.suppression.create({ data: { businessId: business.id, contactId: optedOut.id, identifierType: "phone", identifier: optedOut.phoneE164, scope: "marketing", source: "whatsapp", reason: "נתוני דמו – ביקש הסרה" } });
  }

  // SMS / email simulation providers + one template per channel (no real sending).
  const { sealSecret } = await import("../src/lib/crypto");
  const encryption = Boolean(process.env.ENCRYPTION_KEY);
  for (const [channel, provider, extra] of [
    ["sms", "mock_sms", { senders: [{ id: "DEMO", type: "alphanumeric", value: "DEMO", inbound: false }, { id: "+972501110000", type: "number", value: "+972501110000", inbound: true }], testRecipients: ["+972509998888"], unitPrice: 0.02, unitPriceCurrency: "USD" }],
    ["email", "mock_email", { senderName: "[דמו] סולינה", senderEmail: "news@demo.local", testRecipients: ["qa@demo.local"] }],
  ] as const) {
    const existing = await prisma.providerCredential.findFirst({ where: { businessId: business.id, channel, provider } });
    if (!existing) await prisma.providerCredential.create({ data: { businessId: business.id, channel, provider, label: "הדמיה", isActive: true, isDefault: true, status: "connected", connectionMethod: "manual", config: { webhookSecret: encryption ? sealSecret(`mock-${channel}-demo`) : `mock-${channel}-demo` }, capabilities: { inbound: channel === "sms", deliveryReports: true, opens: channel === "email", clicks: channel === "email", bounces: channel === "email", complaints: channel === "email", suppressionSync: false, cancelQueued: false, alphanumericSender: true, unicode: true, cost: false }, lastCheckedAt: new Date(), ...extra } });
  }
  const { renderEmailHtml, renderEmailText, defaultEmailDesign } = await import("../src/lib/email/blocks");
  const design = defaultEmailDesign();
  await prisma.template.upsert({ where: { businessId_name_language: { businessId: business.id, name: "[דמו] מבצע SMS", language: "he" } }, update: {}, create: { businessId: business.id, channel: "sms", name: "[דמו] מבצע SMS", language: "he", category: "MARKETING", status: "APPROVED", body: "שלום {{first_name|לקוח}}, השבוע 20% הנחה על כל המזרנים ב-{{company|סולינה}}!", variables: ["first_name", "company"] } });
  await prisma.template.upsert({ where: { businessId_name_language: { businessId: business.id, name: "[דמו] ניוזלטר", language: "he" } }, update: {}, create: { businessId: business.id, channel: "email", name: "[דמו] ניוזלטר", language: "he", category: "MARKETING", status: "APPROVED", subject: "חדש אצלנו, {{first_name|לקוח}}", preheader: "מבצעי החודש", design: design as object, html: renderEmailHtml(design, { preheader: "מבצעי החודש" }), text: renderEmailText(design), body: renderEmailText(design), variables: ["first_name", "name", "company"] } });

  // Distribution list of consenting demo contacts for SMS / email / WhatsApp campaigns.
  if (!(await prisma.distributionList.findFirst({ where: { businessId: business.id, name: "[דמו] רשימת דיוור" } }))) {
    const optedIn = await prisma.contact.findMany({ where: { businessId: business.id, consentStatus: "OPTED_IN" }, select: { id: true }, take: 20 });
    await prisma.distributionList.create({ data: { businessId: business.id, name: "[דמו] רשימת דיוור", members: { create: optedIn.map((c) => ({ contactId: c.id })) } } });
  }

  // Business B: one contact, must never be visible from business A.
  await prisma.contact.upsert({ where: { businessId_phoneE164: { businessId: businessB.id, phoneE164: "+972521111111" } }, update: {}, create: { businessId: businessB.id, fullName: "[דמו] לקוח של עסק ב", phoneE164: "+972521111111", phoneRaw: "0521111111", source: "manual" } });

  console.log("Seeded businesses demo-a (Pro, all modules) and demo-b (Starter, no telephony).");
  console.log(`Password for every demo account: ${DEMO_PASSWORD}`);
  console.log("  owner@demo.local    – owner of demo-a, agent in demo-b (business switcher)");
  console.log("  manager@demo.local  – manager of demo-a");
  console.log("  agent1@demo.local / agent2@demo.local – agents of demo-a");
  console.log("  owner-b@demo.local  – owner of demo-b");
  void owner;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

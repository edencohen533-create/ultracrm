/**
 * Isolated QA data: a second business ("qa-b") with its own users, number,
 * contacts and list. Re-runnable. Never touches business "demo" users.
 * Simulation hint: last digit 0 → no answer, 1 → busy, 2 → rejected, else answered.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const schema = url.searchParams.get("schema") ?? "public";
url.searchParams.delete("schema");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });

async function main() {
  const b = await prisma.business.upsert({
    where: { slug: "qa-b" },
    update: {},
    create: {
      name: "עסק QA ב׳",
      slug: "qa-b",
      settings: { wrapUpSeconds: 30, autoDialCountdownSeconds: 2, maxAttempts: 2, retryIntervalMinutes: 30, busyRetryMinutes: 5, recordingEnabled: true, dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6], timezone: "Asia/Jerusalem" } },
    },
  });
  const mk = async (email: string, fullName: string, role: "admin" | "manager" | "agent", password: string, teamId?: string) =>
    prisma.user.upsert({ where: { businessId_email: { businessId: b.id, email } }, update: { teamId: teamId ?? undefined, isActive: true }, create: { businessId: b.id, email, fullName, role, passwordHash: await bcrypt.hash(password, 10), teamId } });
  await mk("admin@qa-b.local", "אדמין ב׳", "admin", "admin123");
  const mgr = await mk("manager@qa-b.local", "מנהלת ב׳", "manager", "manager123");
  let team = await prisma.team.findFirst({ where: { businessId: b.id, name: "צוות ב׳" } });
  if (!team) team = await prisma.team.create({ data: { businessId: b.id, name: "צוות ב׳", managerId: mgr.id } });
  const a3 = await mk("agent3@qa-b.local", "נציג ג׳", "agent", "agent123", team.id);
  const a4 = await mk("agent4@qa-b.local", "נציג ד׳", "agent", "agent123", team.id);
  // a manager of business B with NO team members (visibility test)
  await mk("lonely@qa-b.local", "מנהל בלי צוות", "manager", "manager123");

  await prisma.phoneNumber.upsert({ where: { businessId_e164: { businessId: b.id, e164: "+97239876543" } }, update: {}, create: { businessId: b.id, e164: "+97239876543", label: "QA-B ראשי", isDefault: true, provider: "mock" } });

  // Contacts: includes +972501234533 which also exists in business "demo" (tenant separation test)
  const rows = [
    ["לקוח ב׳ 1", "0521000003"], ["לקוח ב׳ 2", "0521000004"], ["לקוח ב׳ 3 (אין מענה)", "0521000010"], ["לקוח ב׳ 4 (תפוס)", "0521000011"],
    ["לקוח ב׳ 5 (נדחה)", "0521000012"], ["לקוח ב׳ 6", "0521000005"], ["לקוח משותף עם א׳", "0501234533"],
  ];
  const contacts = [];
  for (const [name, phone] of rows) {
    const e164 = "+972" + phone.slice(1);
    contacts.push(await prisma.contact.upsert({ where: { businessId_phoneE164: { businessId: b.id, phoneE164: e164 } }, update: {}, create: { businessId: b.id, fullName: name, phoneE164: e164, phoneRaw: phone, source: "qa", ownerUserId: a3.id } }));
  }
  let list = await prisma.dialList.findFirst({ where: { businessId: b.id, name: "QA-B רשימה" } });
  if (!list) list = await prisma.dialList.create({ data: { businessId: b.id, name: "QA-B רשימה", priority: 5, agents: { create: [{ userId: a3.id }, { userId: a4.id }] } } });
  await prisma.listLead.createMany({ data: contacts.map((c) => ({ businessId: b.id, listId: list!.id, contactId: c.id })), skipDuplicates: true });
  // A list restricted to agent4 only (access test) and an empty list (empty-queue test)
  let restricted = await prisma.dialList.findFirst({ where: { businessId: b.id, name: "QA-B רק נציג ד׳" } });
  if (!restricted) restricted = await prisma.dialList.create({ data: { businessId: b.id, name: "QA-B רק נציג ד׳", agents: { create: [{ userId: a4.id }] } } });
  let empty = await prisma.dialList.findFirst({ where: { businessId: b.id, name: "QA-B ריקה" } });
  if (!empty) empty = await prisma.dialList.create({ data: { businessId: b.id, name: "QA-B ריקה" } });
  // Night-only list (dial window test)
  let night = await prisma.dialList.findFirst({ where: { businessId: b.id, name: "QA-B לילה בלבד" } });
  if (!night) night = await prisma.dialList.create({ data: { businessId: b.id, name: "QA-B לילה בלבד", dialWindowJson: { start: "03:00", end: "03:01", days: [0, 1, 2, 3, 4, 5, 6] } } });
  await prisma.listLead.createMany({ data: [{ businessId: b.id, listId: night.id, contactId: contacts[0].id }], skipDuplicates: true });

  console.log(JSON.stringify({ businessId: b.id, listId: list.id, restrictedListId: restricted.id, emptyListId: empty.id, nightListId: night.id }));
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());

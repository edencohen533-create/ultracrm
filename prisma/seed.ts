/**
 * Demo seed. Creates one business with admin / manager / two agents,
 * a caller-id number, contacts, a dial list and a script.
 * Simulation hints: numbers ending in 0 → no answer, 1 → busy, 2 → rejected, else answered.
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
  const business = await prisma.business.upsert({
    where: { slug: "demo" },
    update: { settings: { wrapUpSeconds: 60, autoDialCountdownSeconds: 5, maxAttempts: 3, retryIntervalMinutes: 120, recordingEnabled: false, dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6], timezone: "Asia/Jerusalem" } } },
    create: {
      name: "עסק לדוגמה",
      slug: "demo",
      settings: { wrapUpSeconds: 60, autoDialCountdownSeconds: 5, maxAttempts: 3, retryIntervalMinutes: 120, recordingEnabled: false, dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6], timezone: "Asia/Jerusalem" } },
    },
  });

  const mk = async (email: string, fullName: string, role: "admin" | "manager" | "agent", password: string, teamId?: string) =>
    prisma.user.upsert({
      where: { businessId_email: { businessId: business.id, email } },
      update: { teamId: teamId ?? undefined },
      create: { businessId: business.id, email, fullName, role, passwordHash: await bcrypt.hash(password, 10), teamId },
    });

  const admin = await mk("admin@demo.local", "מנהל מערכת", "admin", "admin123");
  const manager = await mk("manager@demo.local", "יעל מנהלת", "manager", "manager123");
  let team = await prisma.team.findFirst({ where: { businessId: business.id, name: "צוות מכירות" } });
  if (!team) team = await prisma.team.create({ data: { businessId: business.id, name: "צוות מכירות", managerId: manager.id } });
  await prisma.user.update({ where: { id: manager.id }, data: { teamId: team.id } });
  const agent1 = await mk("agent1@demo.local", "דנה כהן", "agent", "agent123", team.id);
  const agent2 = await mk("agent2@demo.local", "אבי לוי", "agent", "agent123", team.id);

  await prisma.phoneNumber.upsert({
    where: { businessId_e164: { businessId: business.id, e164: "+97233761234" } },
    update: {},
    create: { businessId: business.id, e164: "+97233761234", label: "מספר ראשי", isDefault: true, provider: "mock" },
  });

  const script = await prisma.script.findFirst({ where: { businessId: business.id } }) ??
    (await prisma.script.create({
      data: {
        businessId: business.id,
        title: "תסריט פתיחה",
        isDefault: true,
        body: "שלום, מדבר/ת {{agent}} מ{{business}}. אני מתקשר/ת בהמשך לפנייה שלך.\n\n1. לוודא שזה זמן נוח.\n2. להבין את הצורך.\n3. להציע פגישה / הצעה.\n\nהתנגדויות נפוצות:\n- \"יקר לי\" → להסביר ערך.\n- \"לא עכשיו\" → לקבוע מועד חזרה.",
      },
    }));

  const names = ["ישראל ישראלי", "שרה כהן", "משה לוי", "רחל אברהם", "יעקב גולן", "מרים שפירא", "אהרון בן דוד", "דבורה פרידמן", "נועה ברק", "עומר חדד", "טל מזרחי", "ליאור פרץ"];
  const contacts = [];
  for (let i = 0; i < names.length; i++) {
    const last = i % 10; // spread simulation scenarios
    const phone = `05012345${String(i).padStart(1, "0")}${last}`;
    const e164 = "+972" + phone.slice(1);
    contacts.push(
      await prisma.contact.upsert({
        where: { businessId_phoneE164: { businessId: business.id, phoneE164: e164 } },
        update: {},
        create: { businessId: business.id, fullName: names[i], phoneE164: e164, phoneRaw: phone, source: i % 3 === 0 ? "facebook" : i % 3 === 1 ? "website" : "referral", city: i % 2 ? "תל אביב" : "חיפה", company: i % 4 === 0 ? "חברה בע\"מ" : null, ownerUserId: i % 2 ? agent1.id : agent2.id },
      }),
    );
  }

  let list = await prisma.dialList.findFirst({ where: { businessId: business.id, name: "לידים חמים – ספטמבר" } });
  if (!list) {
    list = await prisma.dialList.create({
      data: { businessId: business.id, name: "לידים חמים – ספטמבר", description: "רשימת דמו", priority: 10, scriptId: script.id, agents: { create: [{ userId: agent1.id }, { userId: agent2.id }] } },
    });
  }
  await prisma.listLead.createMany({ data: contacts.map((c) => ({ businessId: business.id, listId: list!.id, contactId: c.id })), skipDuplicates: true });

  console.log("Seeded business", business.slug);
  console.log("  admin@demo.local / admin123");
  console.log("  manager@demo.local / manager123");
  console.log("  agent1@demo.local / agent123");
  console.log("  agent2@demo.local / agent123");
  void admin;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

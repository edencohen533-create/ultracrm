/**
 * Load-test seed for an ISOLATED database (refuses to run against a non-local DATABASE_URL).
 *   BIZ=10 AGENTS=20 LEADS=40 npx tsx scripts/load/seed.ts > /tmp/load-seed.json
 * Per business: 1 manager + N agents (signed session cookies), leads assigned per agent (phone last digit drives the
 * simulated call result), mock WhatsApp credential + approved template, mock caller-id numbers, a WooCommerce store
 * (webhook secret) and a public API key. Everything is tagged "[LOAD]" / slug load-* and wiped on every run.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { signSession, type SessionUser } from "@/lib/auth";
import { createApiKey } from "@/server/services/integrations";
import { newPublicKey, sealStoreConfig } from "@/server/services/cart-service";
import { withBusiness } from "@/lib/tenant";

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost):5544\//.test(url)) { console.error("refusing: load seed only runs against the local isolated DB on :5544"); process.exit(1); }
const BIZ = Number(process.env.BIZ ?? 1), AGENTS = Number(process.env.AGENTS ?? 5), LEADS = Number(process.env.LEADS ?? 40);

async function wipe() {
  const old = await db.business.findMany({ where: { slug: { startsWith: "load-" } }, select: { id: true } });
  for (const b of old) {
    await db.$executeRawUnsafe(`DELETE FROM calls WHERE business_id = $1`, b.id);
    await db.conversation.deleteMany({ where: { businessId: b.id } });
    await db.providerWebhookEvent.deleteMany({ where: { businessId: b.id } });
    await db.providerCredential.deleteMany({ where: { businessId: b.id } });
    await db.business.delete({ where: { id: b.id } });
  }
  await db.account.deleteMany({ where: { email: { endsWith: "@load.local" } } });
}

async function main() {
  await wipe();
  const hash = await bcrypt.hash("Load1234!", 4);
  const out: unknown[] = [];
  for (let b = 0; b < BIZ; b++) {
    const business = await db.business.create({ data: { name: `[LOAD] עסק ${b + 1}`, slug: `load-${b + 1}-${Date.now()}`, modules: { crm: true, telephony: true, messaging: true }, settings: { dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxDialsPerMinute: 0, marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] }, maxPerMinute: 0, minHoursBetweenMarketing: 0 } } } });
    const mk = async (role: "manager" | "agent", i: number) => {
      const email = `b${b + 1}-${role}${i}@load.local`;
      const acc = await db.account.create({ data: { email, fullName: `${role === "manager" ? "מנהל" : "נציג"} ${b + 1}.${i}`, passwordHash: hash } });
      const u = await db.user.create({ data: { businessId: business.id, accountId: acc.id, email, fullName: acc.fullName, role } });
      const s: SessionUser = { id: u.id, accountId: acc.id, businessId: business.id, email, fullName: acc.fullName, role, teamId: null };
      return { id: u.id, email, session: s, cookie: `ultracrm_session=${await signSession(s)}` };
    };
    const manager = await mk("manager", 0);
    const agents = []; for (let i = 1; i <= AGENTS; i++) agents.push(await mk("agent", i));
    for (let n = 0; n < Math.max(3, Math.ceil(AGENTS / 3)); n++) await db.phoneNumber.create({ data: { businessId: business.id, e164: `+9727${String(b + 1).padStart(2, "0")}${String(n).padStart(6, "0")}`, provider: "mock" } });
    const cred = await db.providerCredential.create({ data: { businessId: business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    const tpl = await db.template.create({ data: { businessId: business.id, channel: "whatsapp", name: "load_followup", language: "he", category: "UTILITY", body: "שלום {{1}}, תודה על השיחה", variables: ["1"], status: "APPROVED" } });
    // Leads: last digit → simulated result: 1 busy (~2.5s), 2 rejected (~3s), 5/6/7 answered, 0 no-answer (12s).
    const digits = ["1", "2", "5", "6", "7", "1", "2", "5", "0", "6"];
    const contacts: Array<{ id: string; owner: string }> = [];
    for (const [ai, ag] of agents.entries()) {
      const rows = Array.from({ length: LEADS }, (_, k) => ({ id: crypto.randomUUID().replaceAll("-", "").slice(0, 25), businessId: business.id, fullName: `ליד ${b + 1}.${ai + 1}.${k + 1}`, phoneE164: `+97250${String(b + 1).padStart(2, "0")}${String(ai + 1).padStart(2, "0")}${String(k).padStart(2, "0")}${digits[k % 10]}`, phoneRaw: "x", ownerUserId: ag.id, consentStatus: "OPTED_IN" as const }));
      await db.contact.createMany({ data: rows });
      await db.lead.createMany({ data: rows.map((c) => ({ businessId: business.id, contactId: c.id, ownerUserId: ag.id, status: "new" as const, source: "load" })) });
      contacts.push(...rows.map((r) => ({ id: r.id, owner: ag.id })));
    }
    const secret = crypto.randomBytes(24).toString("base64url");
    const store = await db.storeConnection.create({ data: { businessId: business.id, platform: "woocommerce", name: "Load store", publicKey: newPublicKey(), config: sealStoreConfig({ webhookSecret: secret }) } });
    const key = await withBusiness(business.id, () => createApiKey(manager.session, "load"), manager.session);
    const sample = await db.lead.findMany({ where: { businessId: business.id }, take: 3, select: { id: true, contactId: true } });
    out.push({ businessId: business.id, manager: { id: manager.id, cookie: manager.cookie }, agents: agents.map((a) => ({ id: a.id, cookie: a.cookie, email: a.email })), credentialId: cred.id, templateId: tpl.id, store: { id: store.id, secret }, apiKey: key.key, probe: { leadIds: sample.map((s) => s.id), contactIds: sample.map((s) => s.contactId) }, leads: contacts.length });
    console.error(`business ${b + 1}/${BIZ}: ${agents.length} agents, ${contacts.length} leads`);
  }
  console.log(JSON.stringify(out));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

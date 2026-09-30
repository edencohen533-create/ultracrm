import { organizationRequest } from "@/lib/auth-compat";
import { z } from "zod";
import { campaignActor } from "@/lib/campaign-auth";
import { parseContactCsv } from "@/lib/contact-csv";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
const schema = z.object({ name: z.string().trim().min(1).max(120), csv: z.string().max(1_000_000), preview: z.boolean().default(false), mapping: z.object({ name: z.string(), phone: z.string(), consentStatus: z.string().optional(), consentEvidence: z.string().optional() }).optional() });
export const POST = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "שם רשימה וקובץ CSV נדרשים (עד 1MB)" }, { status: 400 });
  let parsed: ReturnType<typeof parseContactCsv>;
  try { parsed = parseContactCsv(input.data.csv, input.data.mapping, input.data.preview); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  if (input.data.preview) return Response.json({ totalRows: parsed.totalRows, valid: parsed.contacts.length, duplicateRows: parsed.duplicateRows, errors: parsed.errors.slice(0, 100), errorCount: parsed.errors.length, samples: parsed.contacts.slice(0, 5) });
  const result = await prisma.$transaction(async (tx) => {
    // Never re-subscribe or overwrite existing contacts on import. One person = one card: a number that is already a
    // contact's primary OR additional phone joins that contact (no duplicate card).
    const businessId = requireBusinessId();
    const phones = parsed.contacts.map((c) => c.phone);
    const [primaries, extras] = await Promise.all([
      tx.contact.findMany({ where: { businessId, phoneE164: { in: phones } }, select: { id: true, phoneE164: true } }),
      tx.contactPhone.findMany({ where: { businessId, e164: { in: phones } }, select: { contactId: true, e164: true } }),
    ]);
    const known = new Map<string, string>([...extras.map((x) => [x.e164, x.contactId] as const), ...primaries.map((x) => [x.phoneE164, x.id] as const)]);
    const fresh = parsed.contacts.filter((c) => !known.has(c.phone));
    const created = await tx.contact.createMany({ data: fresh.map((contact) => ({ businessId: requireBusinessId(), fullName: contact.name, phoneE164: contact.phone, phoneRaw: contact.phone, consentStatus: contact.consentStatus, consentEvidence: contact.consentEvidence || null, source: "csv", consentSource: "csv", consentScope: "marketing", consentAt: contact.consentStatus !== "UNKNOWN" ? new Date() : null })), skipDuplicates: true });
    const contacts = [...new Set([...known.values(), ...(await tx.contact.findMany({ where: { businessId, phoneE164: { in: fresh.map((c) => c.phone) } }, select: { id: true } })).map((c) => c.id)])].map((id) => ({ id }));
    const list = await tx.distributionList.create({ data: { businessId: requireBusinessId(), name: input.data.name, members: { createMany: { data: contacts.map((c) => ({ contactId: c.id })) } } } });
    return { list, created: created.count, existing: contacts.length - created.count, duplicateRows: parsed.duplicateRows };
  }, { timeout: 30000 });
  return Response.json(result, { status: 201 });
}, ["crm.edit", "sms.draft", "email.draft", "whatsapp.campaign_draft"]);

export const maxDuration = 60;

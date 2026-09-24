import { organizationRequest } from "@/lib/auth-compat";
import { z } from "zod";
import { campaignActor } from "@/lib/campaign-auth";
import { parseContactCsv } from "@/lib/contact-csv";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
const schema = z.object({ name: z.string().trim().min(1).max(120), csv: z.string().max(1_000_000), preview: z.boolean().default(false), mapping: z.object({ name: z.string(), phone: z.string(), consentStatus: z.string().optional() }).optional() });
export const POST = organizationRequest(async function(request: Request) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const input = schema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "שם רשימה וקובץ CSV נדרשים (עד 1MB)" }, { status: 400 });
  let parsed: ReturnType<typeof parseContactCsv>;
  try { parsed = parseContactCsv(input.data.csv, input.data.mapping, input.data.preview); }
  catch (error) { return Response.json({ error: (error as Error).message }, { status: 400 }); }
  if (input.data.preview) return Response.json({ totalRows: parsed.totalRows, valid: parsed.contacts.length, duplicateRows: parsed.duplicateRows, errors: parsed.errors.slice(0, 100), errorCount: parsed.errors.length, samples: parsed.contacts.slice(0, 5) });
  const result = await prisma.$transaction(async (tx) => {
    // Never re-subscribe or overwrite existing contacts on import.
    const created = await tx.contact.createMany({ data: parsed.contacts.map((contact) => ({ businessId: requireBusinessId(), fullName: contact.name, phoneE164: contact.phone, phoneRaw: contact.phone, consentStatus: contact.consentStatus, source: "csv", consentSource: "csv", consentScope: "marketing", consentAt: contact.consentStatus !== "UNKNOWN" ? new Date() : null })), skipDuplicates: true });
    const contacts = await tx.contact.findMany({ where: { phoneE164: { in: parsed.contacts.map((c) => c.phone) } }, select: { id: true } });
    const list = await tx.distributionList.create({ data: { businessId: requireBusinessId(), name: input.data.name, members: { createMany: { data: contacts.map((c) => ({ contactId: c.id })) } } } });
    return { list, created: created.count, existing: contacts.length - created.count, duplicateRows: parsed.duplicateRows };
  }, { timeout: 30000 });
  return Response.json(result, { status: 201 });
});

export const maxDuration = 60;

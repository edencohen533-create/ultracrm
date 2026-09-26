import { withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { csvRows } from "@/lib/csv-export";

export const dynamic = "force-dynamic";

/** CSV export of the business's contacts (managers). Formula-safe cells, UTF-8 BOM. */
export const GET = withAuth(async ({ user }) => {
  const contacts = await prisma.contact.findMany({
    where: { businessId: user.businessId },
    orderBy: { createdAt: "asc" },
    take: 20000,
    include: { tags: { include: { tag: { select: { name: true } } } }, owner: { select: { fullName: true } }, phones: { select: { e164: true } }, emails: { select: { email: true } } },
  });
  const rows = [
    ["id", "fullName", "phone", "additionalPhones", "email", "additionalEmails", "company", "city", "source", "owner", "tags", "consentStatus", "isBlocked", "createdAt"],
    ...contacts.map((c) => [c.id, c.fullName, c.phoneE164, c.phones.map((p) => p.e164).join(" "), c.email ?? "", c.emails.map((e) => e.email).join(" "), c.company ?? "", c.city ?? "", c.source ?? "", c.owner?.fullName ?? "", c.tags.map((t) => t.tag.name).join(" | "), c.consentStatus, c.isBlocked ? "yes" : "no", c.createdAt.toISOString()]),
  ];
  return new Response(csvRows(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"` } });
}, { minRole: "manager", module: "crm" });

import { redirect } from "next/navigation";
import { getValidSession } from "@/lib/auth";
import { withBusiness } from "@/lib/tenant";
import { prisma } from "@/lib/db";

/** A lead has one card – the contact card, opened on that lead. Old links keep working. */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getValidSession();
  if (!session) redirect("/login");
  const lead = await withBusiness(session.businessId, () => prisma.lead.findUnique({ where: { id }, select: { contactId: true } }), session);
  redirect(lead ? `/contacts/${lead.contactId}?lead=${id}` : "/leads");
}

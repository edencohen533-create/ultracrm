import { prisma } from "@/lib/db";

export async function listTemplates() {
  return prisma.template.findMany({ where: { channel: "whatsapp", internal: false }, orderBy: { createdAt: "asc" } });
}
/**
 * For pickers: `name` = the name shown in the app (display name, editable), `metaName` = the provider's name.
 * Sending always resolves the template by id on the server, so the provider name is never taken from here.
 */
export function withDisplayName<T extends { name: string; displayName?: string | null }>(t: T): T & { metaName: string } {
  return { ...t, name: t.displayName?.trim() || t.name, metaName: t.name };
}
export async function renameTemplate(id: string, displayName: string | null) {
  const t = await prisma.template.findFirst({ where: { id, channel: "whatsapp", internal: false }, select: { id: true, name: true } });
  if (!t) return null;
  const clean = displayName?.trim() || null;
  return prisma.template.update({ where: { id: t.id }, data: { displayName: clean && clean !== t.name ? clean : null } });
}
/** WhatsApp templates that can be sent right now (Meta-approved on the connected account). */
export async function listSendableTemplates() {
  const provider = await prisma.providerCredential.findFirst({ where: { isActive: true, channel: "whatsapp" }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const config = provider?.config as Record<string, string> | undefined;
  if (provider?.provider === "meta_whatsapp_cloud_api" && !config?.businessAccountId) return [];
  return prisma.template.findMany({ where: {
    status: "APPROVED", channel: "whatsapp",
    ...(provider?.provider === "meta_whatsapp_cloud_api" ? { providerAccountId: config!.businessAccountId, providerTemplateId: { not: null } } : {}),
  }, orderBy: [{ name: "asc" }, { language: "asc" }] }).then((rows) => rows.map(withDisplayName));
}

import { prisma } from "@/lib/db";

export async function listTemplates() {
  return prisma.template.findMany({ orderBy: { createdAt: "asc" } });
}
export async function listSendableTemplates() {
  const provider = await prisma.providerCredential.findFirst({ where: { isActive: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const config = provider?.config as Record<string, string> | undefined;
  if (provider?.provider === "meta_whatsapp_cloud_api" && !config?.businessAccountId) return [];
  return prisma.template.findMany({ where: {
    status: "APPROVED",
    ...(provider?.provider === "meta_whatsapp_cloud_api" ? { providerAccountId: config!.businessAccountId, providerTemplateId: { not: null } } : {}),
  }, orderBy: [{ name: "asc" }, { language: "asc" }] });
}

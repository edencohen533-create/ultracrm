import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";

export function templateFingerprint(template: { body: string; language: string; name: string; category?: string; providerAccountId: string | null; providerTemplateId: string | null }) {
  return createHash("sha256").update(JSON.stringify([template.body, template.language, template.name, template.providerAccountId, template.providerTemplateId, template.category])).digest("hex");
}
export async function activeSenderSnapshot(credentialId?: string | null) {
  if (credentialId === null) return await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api" }, select: { id: true } }) ? "blocked:mock" : "mock";
  const active = await prisma.providerCredential.findFirst({ where: credentialId ? { id: credentialId } : { isActive: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!active) return credentialId ? "blocked:missing" : "mock";
  if (!active.isActive) return `blocked:${active.id}`;
  if (active.sendingBlocked) return `blocked:${active.id}`;
  // Changing credentials or the sending number requires a new draft.
  return `${active.id}:${createHash("sha256").update(JSON.stringify(active.config)).digest("hex")}`;
}

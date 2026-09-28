import { organizationRequest } from "@/lib/auth-compat";
import { WhatsAppTemplatesScreen, type TemplateRow } from "@/components/templates/WhatsAppTemplatesScreen";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { listTemplates } from "@/server/services/template-service";
import { campaignActor } from "@/lib/campaign-auth";
import { SyncTemplatesButton } from "@/components/templates/sync-templates-button";

/** WhatsApp message templates only (SMS / email content is written inside their campaigns). */
export default organizationRequest(async function TemplatesPage() {
  const [templates, actor, business] = await Promise.all([listTemplates(), campaignActor(), prisma.business.findUnique({ where: { id: requireBusinessId() }, select: { name: true } })]);
  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">תבניות WhatsApp</h1>
      </div>
      <WhatsAppTemplatesScreen canEdit={Boolean(actor)} businessName={business?.name ?? "העסק שלך"} actions={actor ? <SyncTemplatesButton /> : null}
        templates={templates.map((t) => ({ id: t.id, name: t.name, displayName: t.displayName, language: t.language, category: t.category, status: t.status, body: t.body, variables: t.variables, headerFormat: t.headerFormat, buttons: (t.buttons as unknown as TemplateRow["buttons"]) ?? null, components: (t.components as unknown as TemplateRow["components"]) ?? null, syncError: t.syncError, updatedAt: t.updatedAt.toISOString() }))} />
    </div>
  );
}, ["whatsapp.campaign_draft", "whatsapp.automations"]);

import { organizationRequest } from "@/lib/auth-compat";
import { WhatsAppTemplatesScreen, type TemplateRow } from "@/components/templates/WhatsAppTemplatesScreen";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { listTemplates } from "@/server/services/template-service";
import { campaignActor } from "@/lib/campaign-auth";
import { SyncTemplatesButton } from "@/components/templates/sync-templates-button";
import { serverT } from "@/lib/i18n-server";

/** WhatsApp message templates only (SMS / email content is written inside their campaigns). */
export default organizationRequest(async function TemplatesPage() {
  const t = await serverT();
  const [templates, actor, business] = await Promise.all([listTemplates(), campaignActor(), prisma.business.findUnique({ where: { id: requireBusinessId() }, select: { name: true } })]);
  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">{t("תבניות WhatsApp", "WhatsApp templates")}</h1>
      </div>
      <WhatsAppTemplatesScreen canEdit={Boolean(actor)} businessName={business?.name ?? t("העסק שלך", "Your business")} actions={actor ? <SyncTemplatesButton /> : null}
        templates={templates.map((tpl) => ({ id: tpl.id, name: tpl.name, displayName: tpl.displayName, language: tpl.language, category: tpl.category, status: tpl.status, body: tpl.body, variables: tpl.variables, headerFormat: tpl.headerFormat, buttons: (tpl.buttons as unknown as TemplateRow["buttons"]) ?? null, components: (tpl.components as unknown as TemplateRow["components"]) ?? null, syncError: tpl.syncError, updatedAt: tpl.updatedAt.toISOString() }))} />
    </div>
  );
}, ["whatsapp.campaign_draft", "whatsapp.automations"]);

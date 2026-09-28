import { organizationRequest } from "@/lib/auth-compat";
import { WhatsAppTemplatesScreen, type TemplateRow } from "@/components/templates/WhatsAppTemplatesScreen";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { listTemplates } from "@/server/services/template-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { campaignActor } from "@/lib/campaign-auth";
import { SyncTemplatesButton } from "@/components/templates/sync-templates-button";
import { DeleteTemplateButton, EmailTemplateDialog, SmsTemplateDialog, type ChannelTemplateRow } from "@/components/channels/channel-template-editor";
import { smsMetrics } from "@/lib/sms";
import Link from "next/link";

const CATEGORY_LABELS: Record<string, string> = { MARKETING: "שיווק", UTILITY: "שירות", AUTHENTICATION: "אימות" };
const TABS = [["whatsapp", "WhatsApp"], ["sms", "SMS"], ["email", "אימייל"]] as const;

export default organizationRequest(async function TemplatesPage({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const { channel: raw } = await searchParams;
  const channel = (["whatsapp", "sms", "email"].includes(raw ?? "") ? raw : "whatsapp") as "whatsapp" | "sms" | "email";
  const [templates, actor, channelTemplates, business] = await Promise.all([listTemplates(), campaignActor(), listChannelTemplates(), prisma.business.findUnique({ where: { id: requireBusinessId() }, select: { name: true } })]);
  const rows = channelTemplates.filter((t) => t.channel === channel) as unknown as ChannelTemplateRow[];

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">תבניות הודעה</h1>
        {actor && channel !== "whatsapp" && <div className="flex gap-2">{channel === "sms" ? <SmsTemplateDialog /> : <EmailTemplateDialog />}</div>}
      </div>
      <div className="mb-4 flex gap-2 border-b">{TABS.map(([k, v]) => <Link key={k} href={`/templates?channel=${k}`} className={`-mb-px border-b-2 px-3 py-2 text-sm ${channel === k ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`} data-testid={`templates-tab-${k}`}>{v}</Link>)}</div>
      {channel === "whatsapp" ? (
        <WhatsAppTemplatesScreen canEdit={Boolean(actor)} businessName={business?.name ?? "העסק שלך"} actions={actor ? <SyncTemplatesButton /> : null}
          templates={templates.map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, status: t.status, body: t.body, variables: t.variables, headerFormat: t.headerFormat, buttons: (t.buttons as unknown as TemplateRow["buttons"]) ?? null, components: (t.components as unknown as TemplateRow["components"]) ?? null, syncError: t.syncError, updatedAt: t.updatedAt.toISOString() }))} />
      ) : (
        <>
          {!rows.length && <p className="mb-4 text-muted-foreground">אין תבניות {channel === "sms" ? "SMS" : "אימייל"} עדיין. תבניות {channel === "sms" ? "SMS" : "אימייל"} אינן דורשות אישור ספק וזמינות לשליחה מיד עם השמירה.</p>}
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>שם</TableHead><TableHead>קטגוריה</TableHead><TableHead>{channel === "sms" ? "אורך / מקטעים" : "נושא"}</TableHead><TableHead>תוכן</TableHead><TableHead>קמפיינים</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((t) => {
                  const m = channel === "sms" ? smsMetrics(t.body + (t.category === "MARKETING" ? "\nלהסרה השיבו הסר" : "")) : null;
                  return (
                    <TableRow key={t.id} data-testid={`template-row-${t.id}`}>
                      <TableCell className="font-medium">{t.name}</TableCell>
                      <TableCell><Badge variant="outline">{CATEGORY_LABELS[t.category] ?? t.category}</Badge></TableCell>
                      <TableCell className="text-sm">{m ? `${m.encoding} · ${m.segments} מקטעים` : t.subject}</TableCell>
                      <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{t.body}</TableCell>
                      <TableCell className="text-sm">{t._count?.campaigns ?? 0}</TableCell>
                      <TableCell className="whitespace-nowrap">{actor && <>{channel === "sms" ? <SmsTemplateDialog existing={t} /> : <EmailTemplateDialog existing={t} />}<DeleteTemplateButton channel={channel} id={t.id} /></>}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}, ["whatsapp.campaign_draft", "whatsapp.automations"]);

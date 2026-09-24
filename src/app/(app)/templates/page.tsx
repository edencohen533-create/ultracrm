import { organizationRequest } from "@/lib/auth-compat";
import { NewTemplateDialog } from "@/components/templates/new-template-dialog";
import { listTemplates } from "@/server/services/template-service";
import { listChannelTemplates } from "@/server/services/channel-template-service";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TemplatePreviewDialog } from "@/components/templates/template-preview-dialog";
import { campaignActor } from "@/lib/campaign-auth";
import { SyncTemplatesButton } from "@/components/templates/sync-templates-button";
import { DeleteTemplateButton, EmailTemplateDialog, SmsTemplateDialog, type ChannelTemplateRow } from "@/components/channels/channel-template-editor";
import { smsMetrics } from "@/lib/sms";
import Link from "next/link";

const CATEGORY_LABELS: Record<string, string> = { MARKETING: "שיווק", UTILITY: "שירות", AUTHENTICATION: "אימות" };
const STATUS_LABELS: Record<string, string> = { DRAFT: "טיוטה", PENDING_APPROVAL: "ממתין לאישור", APPROVED: "מאושר", REJECTED: "נדחה" };
const TABS = [["whatsapp", "WhatsApp"], ["sms", "SMS"], ["email", "אימייל"]] as const;

export default organizationRequest(async function TemplatesPage({ searchParams }: { searchParams: Promise<{ channel?: string }> }) {
  const { channel: raw } = await searchParams;
  const channel = (["whatsapp", "sms", "email"].includes(raw ?? "") ? raw : "whatsapp") as "whatsapp" | "sms" | "email";
  const [templates, actor, channelTemplates] = await Promise.all([listTemplates(), campaignActor(), listChannelTemplates()]);
  const rows = channelTemplates.filter((t) => t.channel === channel) as unknown as ChannelTemplateRow[];

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">תבניות הודעה</h1>
        {actor && <div className="flex gap-2">{channel === "whatsapp" ? <><NewTemplateDialog /><SyncTemplatesButton /></> : channel === "sms" ? <SmsTemplateDialog /> : <EmailTemplateDialog />}</div>}
      </div>
      <div className="mb-4 flex gap-2 border-b">{TABS.map(([k, v]) => <Link key={k} href={`/templates?channel=${k}`} className={`-mb-px border-b-2 px-3 py-2 text-sm ${channel === k ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`} data-testid={`templates-tab-${k}`}>{v}</Link>)}</div>
      {channel === "whatsapp" ? (
        <>
          {!templates.length && <p className="mb-4 text-muted-foreground">אין תבניות עדיין. חבר את חשבון Meta וסנכרן את התבניות המאושרות.</p>}
          <div className="overflow-auto rounded-md border">
            <Table>
              <TableHeader><TableRow><TableHead>שם</TableHead><TableHead>שפה</TableHead><TableHead>קטגוריה</TableHead><TableHead>סטטוס</TableHead><TableHead>תוכן</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell className="font-medium">{template.name}{template.syncError && <p className="mt-1 max-w-xs text-xs text-amber-700">{template.syncError}</p>}</TableCell>
                    <TableCell>{template.language === "he" ? "עברית" : template.language}</TableCell>
                    <TableCell><Badge variant="outline">{CATEGORY_LABELS[template.category] ?? template.category}</Badge></TableCell>
                    <TableCell><Badge variant="secondary">{STATUS_LABELS[template.status] ?? template.status}</Badge></TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{template.body}</TableCell>
                    <TableCell><TemplatePreviewDialog name={template.name} body={template.body} variables={template.variables} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
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
});

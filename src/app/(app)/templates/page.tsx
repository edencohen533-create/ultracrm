import { organizationRequest } from "@/lib/auth-compat";
import { NewTemplateDialog } from "@/components/templates/new-template-dialog";
import { listTemplates } from "@/server/services/template-service";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { TemplatePreviewDialog } from "@/components/templates/template-preview-dialog";
import { campaignActor } from "@/lib/campaign-auth";
import { SyncTemplatesButton } from "@/components/templates/sync-templates-button";

const CATEGORY_LABELS: Record<string, string> = {
  MARKETING: "שיווק",
  UTILITY: "שירות",
  AUTHENTICATION: "אימות",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "טיוטה",
  PENDING_APPROVAL: "ממתין לאישור",
  APPROVED: "מאושר",
  REJECTED: "נדחה",
};

export default organizationRequest(async function TemplatesPage() {
  const [templates, actor] = await Promise.all([listTemplates(), campaignActor()]);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3"><h1 className="text-lg font-semibold">תבניות הודעה</h1>{actor && <div className="flex gap-2"><NewTemplateDialog /><SyncTemplatesButton /></div>}</div>
      {!templates.length && <p className="mb-4 text-muted-foreground">אין תבניות עדיין. חבר את חשבון Meta וסנכרן את התבניות המאושרות.</p>}
      <div className="overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>שם</TableHead>
              <TableHead>שפה</TableHead>
              <TableHead>קטגוריה</TableHead>
              <TableHead>סטטוס</TableHead>
              <TableHead>תוכן</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((template) => (
              <TableRow key={template.id}>
                <TableCell className="font-medium">{template.name}{template.syncError && <p className="mt-1 max-w-xs text-xs text-amber-700">{template.syncError}</p>}</TableCell>
                <TableCell>{template.language === "he" ? "עברית" : template.language}</TableCell>
                <TableCell>
                  <Badge variant="outline">{CATEGORY_LABELS[template.category] ?? template.category}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{STATUS_LABELS[template.status] ?? template.status}</Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{template.body}</TableCell>
                <TableCell>
                  <TemplatePreviewDialog name={template.name} body={template.body} variables={template.variables} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
});

import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { listRuns } from "@/server/services/automation-service";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";
import { serverT } from "@/lib/i18n-server";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  COMPLETED: "secondary",
  FAILED: "destructive",
  PENDING: "outline",
  RUNNING: "default",
};

const STATUS_LABELS: Record<string, [string, string]> = {
  COMPLETED: ["הושלם", "Completed"],
  FAILED: ["נכשל", "Failed"],
  PENDING: ["ממתין", "Pending"],
  RUNNING: ["רץ", "Running"],
};

export default organizationRequest(async function AutomationHistoryPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const runs = await listRuns();
  const t = await serverT();

  if (runs.length === 0) {
    return <EmptyState title={t("אין הרצות אוטומציה עדיין", "No automation runs yet")} />;
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">{t("היסטוריית הרצות אוטומציה", "Automation run history")}</h1>
      <div className="overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("חוק", "Rule")}</TableHead>
              <TableHead>{t("סטטוס", "Status")}</TableHead>
              <TableHead>{t("תוצאה", "Result")}</TableHead>
              <TableHead>{t("זמן", "Time")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="font-medium">{run.rule.name}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[run.status] ?? "outline"}>{STATUS_LABELS[run.status] ? t(...STATUS_LABELS[run.status]) : run.status}</Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                  {run.error ?? JSON.stringify(run.result ?? {})}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(run.createdAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}, ["whatsapp.automations", "sms.send", "email.send"]);

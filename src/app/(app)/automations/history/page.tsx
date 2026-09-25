import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import { listRuns } from "@/server/services/automation-service";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/shared/empty-state";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  COMPLETED: "secondary",
  FAILED: "destructive",
  PENDING: "outline",
  RUNNING: "default",
};

const STATUS_LABELS: Record<string, string> = {
  COMPLETED: "הושלם",
  FAILED: "נכשל",
  PENDING: "ממתין",
  RUNNING: "רץ",
};

export default organizationRequest(async function AutomationHistoryPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const runs = await listRuns();

  if (runs.length === 0) {
    return <EmptyState title="אין הרצות אוטומציה עדיין" />;
  }

  return (
    <div className="p-6">
      <h1 className="mb-4 text-lg font-semibold">היסטוריית הרצות אוטומציה</h1>
      <div className="overflow-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>חוק</TableHead>
              <TableHead>סטטוס</TableHead>
              <TableHead>תוצאה</TableHead>
              <TableHead>זמן</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="font-medium">{run.rule.name}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[run.status] ?? "outline"}>{STATUS_LABELS[run.status] ?? run.status}</Badge>
                </TableCell>
                <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                  {run.error ?? JSON.stringify(run.result ?? {})}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {new Date(run.createdAt).toLocaleString("he-IL")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
});

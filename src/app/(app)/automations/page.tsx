import { organizationRequest } from "@/lib/auth-compat";
import { withDisplayName } from "@/server/services/template-service";
import { templateParameterKeys } from "@/lib/campaigns";
import { auth } from "@/lib/auth-compat";
import { hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { AccessDenied } from "@/components/shared/access-denied";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { listRules } from "@/server/services/automation-service";
import { RuleBuilder } from "@/components/automations/rule-builder";
import { StopAutomationsButton } from "@/components/automations/stop-automations-button";
import { RuleList } from "@/components/automations/rule-list";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { UnsubscribeCard } from "@/components/automations/unsubscribe-card";
import { AutomationsTabs } from "@/components/automations/AutomationsTabs";
import { serverT } from "@/lib/i18n-server";

export default organizationRequest(async function AutomationsPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [rules, agents, cannedReplies, templates, conversations] = await Promise.all([
    listRules(),
    prisma.user.findMany({ where: { role: { in: ["agent", "manager"] }, isActive: true }, select: { id: true, fullName: true } }),
    prisma.cannedReply.findMany({ select: { id: true, title: true } }),
    prisma.template.findMany({ where: { status: "APPROVED", channel: "whatsapp", internal: false }, select: { id: true, name: true, displayName: true, body: true } }).then((r) => r.map(withDisplayName)),
    prisma.conversation.findMany({ orderBy: { lastMessageAt: "desc" }, take: 50, select: { id: true, contact: { select: { fullName: true, phoneE164: true } } } }),
  ]);
  const t = await serverT();

  const options = {
    conversations: conversations.map((c) => ({ id: c.id, label: `${c.contact.fullName} (${c.contact.phoneE164})` })),
    agents: agents.map((a) => ({ id: a.id, label: a.fullName })),
    cannedReplies: cannedReplies.map((c) => ({ id: c.id, label: c.title })),
    templates: templates.map((tpl) => ({ id: tpl.id, label: tpl.name, variables: templateParameterKeys(tpl.body) })),
  };
  return (
    <div className="p-3 sm:p-6">
      <AutomationsTabs />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold">{t("אוטומציות", "Automations")}</h1><p className="text-sm text-muted">{t("חוקים בודדים: טריגר ← פעולה. רצפים לאורך זמן נמצאים בלשונית ״מסעות לקוח״.", "Single rules: trigger → action. Sequences over time are in the \"Customer journeys\" tab.")}</p></div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" nativeButton={false} render={<Link href="/automations/history">{t("היסטוריית הרצות", "Run history")}</Link>} />
          <StopAutomationsButton />
          <RuleBuilder {...options} />
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState title={t("אין חוקי אוטומציה עדיין", "No automation rules yet")} description={t("צור חוק חדש כדי להתחיל.", "Create a new rule to get started.")} />
      ) : (
        <RuleList key={rules.map((r) => `${r.id}:${r.updatedAt.toISOString()}`).join(",")} options={options} rules={rules.map((r) => ({ ...r, triggerConfig: r.triggerConfig as Record<string, unknown>, actionConfig: r.actionConfig as Record<string, unknown> }))} />
      )}
      <UnsubscribeCard />
    </div>
  );
}, ["whatsapp.automations", "sms.send", "email.send"]);

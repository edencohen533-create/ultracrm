import { organizationRequest } from "@/lib/auth-compat";
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
import { JourneyList } from "@/components/automations/journey/journey-list";
import { UnsubscribeCard } from "@/components/automations/unsubscribe-card";
import { StatusWhatsAppCard } from "@/components/automations/status-whatsapp-card";
import { listSequences } from "@/server/services/sequence-service";

export default organizationRequest(async function AutomationsPage() {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <AccessDenied />;
  const [rules, agents, cannedReplies, templates, conversations, sequences, allTemplates, tags] = await Promise.all([
    listRules(),
    prisma.user.findMany({ where: { role: { in: ["agent", "manager"] }, isActive: true }, select: { id: true, fullName: true } }),
    prisma.cannedReply.findMany({ select: { id: true, title: true } }),
    prisma.template.findMany({ where: { status: "APPROVED", channel: "whatsapp", internal: false }, select: { id: true, name: true, body: true } }),
    prisma.conversation.findMany({ orderBy: { lastMessageAt: "desc" }, take: 50, select: { id: true, contact: { select: { fullName: true, phoneE164: true } } } }),
    listSequences(),
    prisma.template.findMany({ where: { status: "APPROVED", internal: false }, select: { id: true, name: true, channel: true }, orderBy: { name: "asc" } }),
    prisma.tag.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="p-3 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">אוטומציות</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" render={<Link href="/automations/history">היסטוריית הרצות</Link>} />
          <StopAutomationsButton />
          <RuleBuilder
            conversations={conversations.map((c) => ({ id: c.id, label: `${c.contact.fullName} (${c.contact.phoneE164})` }))}
            agents={agents.map((a) => ({ id: a.id, label: a.fullName }))}
            cannedReplies={cannedReplies.map((c) => ({ id: c.id, label: c.title }))}
            templates={templates.map((t) => ({ id: t.id, label: t.name, variables: templateParameterKeys(t.body) }))}
          />
        </div>
      </div>

      {rules.length === 0 ? (
        <EmptyState title="אין חוקי אוטומציה עדיין" description="צור חוק חדש כדי להתחיל." />
      ) : (
        <RuleList key={rules.map((r) => `${r.id}:${r.isActive}`).join(",")} rules={rules} />
      )}
      <StatusWhatsAppCard templates={templates.map((t) => ({ id: t.id, name: t.name, body: t.body }))} />
      <JourneyList journeys={JSON.parse(JSON.stringify(sequences))} />
      <UnsubscribeCard />
    </div>
  );
});

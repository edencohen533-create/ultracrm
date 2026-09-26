import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { JourneyBuilder, type Journey, type JourneyStep } from "@/components/automations/journey/journey-builder";

/** Customer-journey editor ("new" creates one). */
export default organizationRequest(async function JourneyPage({ params }: { params: Promise<{ id: string }> }) {
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <p className="p-6">האוטומציות מיועדות למנהלים.</p>;
  const { id } = await params;
  const [seq, templates, tags, lists] = await Promise.all([
    id === "new" ? null : prisma.marketingSequence.findUnique({ where: { id }, include: { steps: { orderBy: { position: "asc" } } } }),
    prisma.template.findMany({ where: { status: "APPROVED", internal: false }, select: { id: true, name: true, channel: true }, orderBy: { name: "asc" } }),
    prisma.tag.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
    prisma.distributionList.findMany({ where: { segment: { equals: Prisma.DbNull } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  ]);
  if (id !== "new" && !seq) return <p className="p-6">האוטומציה לא נמצאה.</p>;
  const initial: Journey = seq ? {
    id: seq.id, name: seq.name, isActive: seq.isActive, trigger: seq.trigger, triggerConfig: (seq.triggerConfig ?? {}) as Record<string, unknown>, stopOn: seq.stopOn.filter((s) => s !== "unsubscribe"),
    steps: seq.steps.map((s): JourneyStep => { const v = (s.variables ?? {}) as Record<string, string>; const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("__"))); return { action: s.action as JourneyStep["action"], channel: s.channel as JourneyStep["channel"], templateId: s.templateId ?? undefined, waitMinutes: s.waitMinutes, variables: rest, condition: (s.condition ?? {}) as JourneyStep["condition"], taskTitle: v.__taskTitle, taskDueHours: v.__taskDueHours ? Number(v.__taskDueHours) : undefined, actionTag: v.__tag, listId: v.__listId, webhookUrl: v.__webhook }; }),
  } : { name: "מסע לקוח חדש", isActive: false, trigger: "CONTACT_CREATED", triggerConfig: {}, stopOn: ["reply", "conversion"], steps: [] };
  return <JourneyBuilder initial={JSON.parse(JSON.stringify(initial))} templates={templates} tags={tags.map((t) => t.name)} lists={lists} />;
});

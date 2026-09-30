import { organizationRequest, auth, hasRole, ROLES_ADMIN_MANAGER } from "@/lib/auth-compat";
import { withDisplayName } from "@/server/services/template-service";
import { prisma } from "@/lib/db";
import { serverT } from "@/lib/i18n-server";
import { Prisma } from "@/generated/prisma/client";
import { JourneyBuilder, type Journey, type JourneyStep } from "@/components/automations/journey/journey-builder";

/** Customer-journey editor ("new" creates one). */
export default organizationRequest(async function JourneyPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ trigger?: string; publish?: string }> }) {
  const t = await serverT();
  if (!hasRole(await auth(), ROLES_ADMIN_MANAGER)) return <p className="p-6">{t("האוטומציות מיועדות למנהלים.", "Automations are available to managers only.")}</p>;
  const { id } = await params;
  const { trigger: wanted, publish: openPublish } = await searchParams;
  const [seq, templates, tags, lists] = await Promise.all([
    id === "new" ? null : prisma.marketingSequence.findUnique({ where: { id }, include: { steps: { orderBy: { position: "asc" } } } }),
    prisma.template.findMany({ where: { status: "APPROVED", internal: false }, select: { id: true, name: true, displayName: true, channel: true }, orderBy: { name: "asc" } }).then((r) => r.map(withDisplayName)),
    prisma.tag.findMany({ select: { name: true }, orderBy: { name: "asc" } }),
    prisma.distributionList.findMany({ where: { segment: { equals: Prisma.DbNull } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  ]);
  if (id !== "new" && !seq) return <p className="p-6">{t("האוטומציה לא נמצאה.", "Automation not found.")}</p>;
  // An unpublished draft (if any) is what the editor opens; the live version keeps running until it is published.
  const draft = seq?.draft as Omit<Journey, "id" | "status" | "version" | "hasDraft"> | null | undefined;
  const initial: Journey = seq && draft ? {
    ...draft, id: seq.id, status: seq.status as Journey["status"], version: seq.version, hasDraft: seq.status !== "draft", name: draft.name ?? seq.name, triggerConfig: draft.triggerConfig ?? {}, stopOn: (draft.stopOn ?? []).filter((s) => s !== "unsubscribe"), steps: draft.steps ?? [],
  } : seq ? {
    id: seq.id, name: seq.name, status: seq.status as Journey["status"], version: seq.version, hasDraft: false, trigger: seq.trigger, triggerConfig: (seq.triggerConfig ?? {}) as Record<string, unknown>, stopOn: seq.stopOn.filter((s) => s !== "unsubscribe"),
    steps: seq.steps.map((s): JourneyStep => { const v = (s.variables ?? {}) as Record<string, string>; const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("__"))); return { action: s.action as JourneyStep["action"], channel: s.channel as JourneyStep["channel"], templateId: s.templateId ?? undefined, waitMinutes: s.waitMinutes, variables: rest, condition: (s.condition ?? {}) as JourneyStep["condition"], taskTitle: v.__taskTitle, taskDueHours: v.__taskDueHours ? Number(v.__taskDueHours) : undefined, actionTag: v.__tag, listId: v.__listId, webhookUrl: v.__webhook }; }),
  } : { name: wanted === "CART_ABANDONED" ? t("שחזור עגלה נטושה", "Abandoned cart recovery") : t("מסע לקוח חדש", "New customer journey"), status: "draft", version: 0, hasDraft: false, trigger: wanted === "CART_ABANDONED" ? "CART_ABANDONED" : "CONTACT_CREATED", triggerConfig: {}, stopOn: ["reply", "conversion"], steps: [] };
  return <JourneyBuilder initial={JSON.parse(JSON.stringify(initial))} openPublish={openPublish === "1" && Boolean(seq)} templates={templates} tags={tags.map((tag) => tag.name)} lists={lists} />;
}, ["whatsapp.automations", "sms.send", "email.send"]);

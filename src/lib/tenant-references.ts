import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";

/** Validate foreign keys before any write; an existing ID is not tenant authorization. */
export async function assertTenantReferences(businessId: string, refs: {
  userIds?: (string | null | undefined)[];
  teamId?: string | null;
  scriptId?: string | null;
  phoneNumberId?: string | null;
}) {
  const ids = [...new Set((refs.userIds ?? []).filter((id): id is string => Boolean(id)))];
  const [users, team, script, number] = await Promise.all([
    ids.length ? prisma.user.count({ where: { businessId, id: { in: ids } } }) : 0,
    refs.teamId ? prisma.team.count({ where: { businessId, id: refs.teamId } }) : 1,
    refs.scriptId ? prisma.script.count({ where: { businessId, id: refs.scriptId } }) : 1,
    refs.phoneNumberId ? prisma.phoneNumber.count({ where: { businessId, id: refs.phoneNumberId } }) : 1,
  ]);
  if (users !== ids.length || !team || !script || !number) throw new ApiError("שיוך לא תקין לעסק", 400, "invalid_tenant_reference");
}

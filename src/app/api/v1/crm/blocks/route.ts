import { z } from "zod";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { suppressContact } from "@/lib/suppression";
import { withIntegration } from "@/server/crm-sync/public-api";

export const dynamic = "force-dynamic";

/** A block / removal request from the external system – enforced here at once (calls and messages), idempotent. */
export async function POST(req: Request) {
  return withIntegration(req, "blocks:write", async (a) => {
    const b = z.object({ contactExternalId: z.string().max(120).optional(), phone: z.string().max(40).optional(), reason: z.string().max(300).optional() }).refine((x) => x.contactExternalId || x.phone, "contactExternalId או phone נדרש").safeParse(await req.json().catch(() => ({})));
    if (!b.success) throw new ApiError("נתונים לא תקינים", 400, "validation", b.error.flatten());
    const link = b.data.contactExternalId ? await prisma.externalRecordLink.findFirst({ where: { businessId: a.business.id, connectionId: a.connection.id, recordType: "contact", externalId: b.data.contactExternalId } }) : null;
    const phone = b.data.phone ? normalizePhone(b.data.phone) : null;
    if (!link?.localId && !phone) throw new ApiError("איש הקשר לא נמצא – שלחו גם טלפון", 404, "not_found");
    const r = await suppressContact({ businessId: a.business.id, contactId: link?.localId ?? undefined, identifier: link?.localId ? undefined : phone!, scope: "all", source: `crm:${a.connection.id}`, kind: "do_not_call", reason: b.data.reason ?? "בקשת חסימה מה-CRM החיצוני", evidence: `API key ${a.keyName}` });
    return { blocked: true, contactId: r.contactId, identifiers: r.identifiers.length };
  });
}

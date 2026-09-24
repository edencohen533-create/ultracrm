import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => {
  const { contactId } = parseQuery(req, z.object({ contactId: z.string() }));
  const d = await prisma.noteDraft.findUnique({ where: { userId_contactId: { userId: user.id, contactId } } });
  return ok({ body: d?.body ?? "" });
});

export const PUT = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ contactId: z.string(), body: z.string().max(4000) }));
  const contact = await prisma.contact.findFirst({ where: { id: b.contactId, businessId: user.businessId }, select: { id: true } });
  if (!contact) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  if (!b.body.trim()) {
    await prisma.noteDraft.deleteMany({ where: { userId: user.id, contactId: b.contactId } });
    return ok({ saved: true });
  }
  await prisma.noteDraft.upsert({
    where: { userId_contactId: { userId: user.id, contactId: b.contactId } },
    create: { businessId: user.businessId, userId: user.id, contactId: b.contactId, body: b.body },
    update: { body: b.body },
  });
  return ok({ saved: true });
});

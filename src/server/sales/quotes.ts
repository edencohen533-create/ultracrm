import crypto from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma, db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { ownerScope } from "@/lib/crm/access";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
const json = (v: unknown) => v as Prisma.InputJsonValue;
export const offerSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().max(2000).default(""),
  currency: z.enum(["ILS", "USD", "EUR"]).default("ILS"),
  unitAmount: z.number().int().min(0).max(100_000_000),
  unitCost: z.number().int().min(0).max(100_000_000).nullable().default(null),
  taxBps: z.number().int().min(0).max(10000).default(0),
  maxDiscountBps: z.number().int().min(0).max(10000).default(0),
  active: z.boolean().default(true),
});
export const quoteSchema = z.object({
  leadId: z.string().min(1),
  previousId: z.string().optional(),
  title: z.string().trim().min(2).max(200),
  terms: z.string().max(5000).default(""),
  expiresAt: z.string().datetime(),
  lines: z
    .array(
      z.object({
        offerId: z.string(),
        quantity: z.number().int().min(1).max(1000),
        discountBps: z.number().int().min(0).max(10000).default(0),
      }),
    )
    .min(1)
    .max(30),
});
export type QuoteLine = {
  offerId: string;
  name: string;
  description: string;
  quantity: number;
  unitAmount: number;
  discountBps: number;
  taxBps: number;
  net: number;
  tax: number;
  total: number;
};
export function calculateLine(
  offer: {
    id: string;
    name: string;
    description: string;
    unitAmount: number;
    taxBps: number;
  },
  quantity: number,
  discountBps: number,
): QuoteLine {
  const gross = BigInt(offer.unitAmount) * BigInt(quantity);
  const net = Number(
    (gross * BigInt(10000 - discountBps) + BigInt(5000)) / BigInt(10000),
  );
  const tax = Number(
    (BigInt(net) * BigInt(offer.taxBps) + BigInt(5000)) / BigInt(10000),
  );
  if (!Number.isSafeInteger(net + tax) || net + tax > 2_000_000_000)
    throw new ApiError("סכום ההצעה גבוה מהמותר", 400, "amount_limit");
  return {
    offerId: offer.id,
    name: offer.name,
    description: offer.description,
    quantity,
    unitAmount: offer.unitAmount,
    discountBps,
    taxBps: offer.taxBps,
    net,
    tax,
    total: net + tax,
  };
}
export async function leadFor(user: SessionUser, id: string) {
  const ids = await visibleUserIds(user);
  const lead = await prisma.lead.findFirst({
    where: { id, businessId: user.businessId, ...ownerScope(ids) },
  });
  if (!lead) throw new ApiError("הליד לא נמצא", 404, "not_found");
  return lead;
}
export async function listSales(user: SessionUser, leadId?: string) {
  const ids = await visibleUserIds(user);
  if (leadId) await leadFor(user, leadId);
  const [offers, quotes] = await Promise.all([
    prisma.salesOffer.findMany({
      where: {
        businessId: user.businessId,
        ...(user.role === "agent" ? { active: true } : {}),
      },
      orderBy: { name: "asc" },
    }),
    prisma.salesQuote.findMany({
      where: {
        businessId: user.businessId,
        ...(leadId ? { leadId } : {}),
        lead: ownerScope(ids),
      },
      select: {
        id: true,
        leadId: true,
        familyId: true,
        revision: true,
        title: true,
        currency: true,
        costTotal: true,
        total: true,
        subtotal: true,
        tax: true,
        lines: true,
        terms: true,
        status: true,
        expiresAt: true,
        sharedAt: true,
        viewedAt: true,
        acceptedAt: true,
        acceptedName: true,
        participants: true,
        createdAt: true,
        lead: { select: { contact: { select: { fullName: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  return {
    offers: offers.map((o) => ({
      ...o,
      unitCost: user.role === "agent" ? undefined : o.unitCost,
    })),
    quotes: quotes.map(({ costTotal, ...q }) => ({
      ...q,
      ...(user.role !== "agent"
        ? {
            costTotal,
            margin: costTotal === null ? null : q.subtotal - costTotal,
          }
        : {}),
    })),
    payments: {
      connected: false,
      message: "ספק סליקה טרם חובר. אישור הצעה אינו תשלום.",
    },
  };
}
export async function saveOffer(
  user: SessionUser,
  input: unknown,
  id?: string,
) {
  if (user.role === "agent")
    throw new ApiError("רק מנהל רשאי לשנות את הקטלוג", 403, "forbidden");
  const data = offerSchema.parse(input);
  if (
    id &&
    !(await prisma.salesOffer.findFirst({
      where: { id, businessId: user.businessId },
    }))
  )
    throw new ApiError("הצעה מסחרית לא נמצאה", 404, "not_found");
  const r = id
    ? await prisma.salesOffer.update({ where: { id }, data })
    : await prisma.salesOffer.create({
        data: { ...data, businessId: user.businessId },
      });
  await audit(
    user.businessId,
    user.id,
    "sales_offer",
    r.id,
    "sales.offer_saved",
    { name: r.name, active: r.active },
  );
  return r;
}
export async function createQuote(user: SessionUser, input: unknown) {
  const b = quoteSchema.parse(input);
  await leadFor(user, b.leadId);
  const expiry = new Date(b.expiresAt);
  if (expiry <= new Date() || expiry.getTime() > Date.now() + 366 * 86400000)
    throw new ApiError("תוקף ההצעה צריך להיות בעתיד ועד שנה", 400, "expiry");
  return prisma.$transaction(async (tx) => {
    const offers = await tx.salesOffer.findMany({
      where: {
        businessId: user.businessId,
        id: { in: b.lines.map((l) => l.offerId) },
        active: true,
      },
    });
    if (b.lines.some((l) => !offers.some((o) => o.id === l.offerId)))
      throw new ApiError("פריט חסר או לא פעיל בקטלוג", 400, "offer_missing");
    if (new Set(offers.map((o) => o.currency)).size !== 1)
      throw new ApiError("כל הפריטים חייבים להיות באותו מטבע", 400, "currency");
    const lines = b.lines.map((l) =>
      calculateLine(
        offers.find((o) => o.id === l.offerId)!,
        l.quantity,
        l.discountBps,
      ),
    );
    const total = lines.reduce((n, l) => n + l.total, 0);
    if (total > 2_000_000_000)
      throw new ApiError("סכום גבוה מהמותר", 400, "amount_limit");
    let familyId: string = crypto.randomUUID(),
      revision = 1;
    if (b.previousId) {
      const prev = await tx.salesQuote.findFirst({
        where: {
          id: b.previousId,
          businessId: user.businessId,
          leadId: b.leadId,
        },
      });
      if (!prev) throw new ApiError("הגרסה הקודמת לא נמצאה", 404, "not_found");
      familyId = prev.familyId;
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"quote:" + familyId}))`,
      );
      const family = await tx.salesQuote.findMany({
        where: { businessId: user.businessId, familyId },
        select: { revision: true, status: true },
      });
      if (family.some((q) => q.status === "accepted"))
        throw new ApiError(
          "הצעה שאושרה אינה ניתנת להחלפה; צור הצעה נפרדת",
          409,
          "accepted",
        );
      revision = Math.max(...family.map((q) => q.revision)) + 1;
    }
    const costTotal = offers.some((o) => o.unitCost === null)
      ? null
      : b.lines.reduce(
          (sum, l) =>
            sum +
            offers.find((o) => o.id === l.offerId)!.unitCost! * l.quantity,
          0,
        );
    if (costTotal !== null && costTotal > 2_000_000_000)
      throw new ApiError("עלות ההצעה גבוהה מהמותר", 400, "amount_limit");
    const needsApproval = b.lines.some(
      (l) =>
        l.discountBps > offers.find((o) => o.id === l.offerId)!.maxDiscountBps,
    );
    const q = await tx.salesQuote.create({
      data: {
        businessId: user.businessId,
        leadId: b.leadId,
        createdById: user.id,
        familyId,
        revision,
        title: b.title,
        currency: offers[0].currency,
        costTotal,
        lines: json(lines),
        subtotal: lines.reduce((n, l) => n + l.net, 0),
        tax: lines.reduce((n, l) => n + l.tax, 0),
        total,
        terms: b.terms,
        status: needsApproval ? "pending_approval" : "approved",
        expiresAt: expiry,
      },
    });
    await audit(
      user.businessId,
      user.id,
      "sales_quote",
      q.id,
      "sales.quote_created",
      { total, revision, needsApproval },
      tx,
    );
    return { ...q, costTotal: user.role === "agent" ? undefined : q.costTotal };
  });
}
export async function quoteAction(
  user: SessionUser,
  id: string,
  action: "approve" | "share" | "revoke",
) {
  const q = await prisma.salesQuote.findFirst({
    where: { id, businessId: user.businessId },
  });
  if (!q) throw new ApiError("הצעה לא נמצאה", 404, "not_found");
  await leadFor(user, q.leadId);
  if (action === "approve" && user.role === "agent")
    throw new ApiError("הנחה חריגה דורשת אישור מנהל", 403, "forbidden");
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"quote:" + q.familyId}))`,
    );
    const current = await tx.salesQuote.findUniqueOrThrow({ where: { id } });
    let token: string | undefined;
    if (current.status === "accepted")
      throw new ApiError("ההצעה כבר אושרה על ידי הלקוח", 409, "accepted");
    if (action !== "revoke" && current.expiresAt <= new Date())
      throw new ApiError("פג תוקף ההצעה", 409, "expired");
    if (action === "approve") {
      if (current.status !== "pending_approval")
        throw new ApiError("ההצעה אינה ממתינה לאישור", 409, "state");
      await tx.salesQuote.update({
        where: { id },
        data: {
          status: "approved",
          approvedById: user.id,
          approvedAt: new Date(),
        },
      });
    }
    if (action === "revoke")
      await tx.salesQuote.update({
        where: { id },
        data: { status: "revoked", tokenHash: null },
      });
    if (action === "share") {
      if (!["approved", "shared"].includes(current.status))
        throw new ApiError("ההצעה טרם אושרה לשיתוף", 409, "state");
      const newer = await tx.salesQuote.findFirst({
        where: {
          businessId: user.businessId,
          familyId: q.familyId,
          revision: { gt: current.revision },
        },
      });
      if (newer) throw new ApiError("קיימת גרסה חדשה יותר", 409, "superseded");
      if (
        await tx.salesQuote.findFirst({
          where: {
            businessId: user.businessId,
            familyId: q.familyId,
            status: "accepted",
          },
        })
      )
        throw new ApiError("גרסה אחרת כבר אושרה", 409, "accepted");
      await tx.salesQuote.updateMany({
        where: {
          businessId: user.businessId,
          familyId: q.familyId,
          id: { not: id },
          status: { not: "revoked" },
        },
        data: { status: "revoked", tokenHash: null },
      });
      token = crypto.randomBytes(32).toString("base64url");
      await tx.salesQuote.update({
        where: { id },
        data: {
          status: "shared",
          tokenHash: hash(token),
          sharedAt: new Date(),
        },
      });
    }
    await audit(
      user.businessId,
      user.id,
      "sales_quote",
      id,
      "sales.quote_" + action,
      {},
      tx,
    );
    return { id, ...(token ? { path: "/offer/" + token } : {}), action };
  });
}
const hash = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");
async function tenantForToken(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError("הקישור אינו זמין", 404, "not_found");
  const q = await db.salesQuote.findUnique({
    where: { tokenHash: hash(token) },
    select: { businessId: true, id: true },
  });
  if (!q) throw new ApiError("הקישור אינו זמין", 404, "not_found");
  return q;
}
export async function publicQuote(token: string) {
  const t = await tenantForToken(token);
  return withBusiness(t.businessId, async () => {
    const q = await prisma.salesQuote.findUniqueOrThrow({
      where: { id: t.id },
    });
    if (
      q.tokenHash !== hash(token) ||
      !["shared", "accepted"].includes(q.status) ||
      q.expiresAt <= new Date()
    )
      throw new ApiError("ההצעה בוטלה או פג תוקפה", 410, "expired");
    await prisma.salesQuote.updateMany({
      where: { id: q.id, viewedAt: null },
      data: { viewedAt: new Date() },
    });
    const business = await prisma.business.findUnique({
      where: { id: t.businessId },
      select: { name: true },
    });
    return {
      title: q.title,
      revision: q.revision,
      businessName: business?.name,
      currency: q.currency,
      lines: q.lines,
      subtotal: q.subtotal,
      tax: q.tax,
      total: q.total,
      terms: q.terms,
      expiresAt: q.expiresAt,
      status: q.status,
      acceptedAt: q.acceptedAt,
      payment: {
        available: false,
        message: "תשלום מקוון עדיין אינו זמין. אישור ההצעה אינו חיוב.",
      },
    };
  });
}
export const acceptanceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  revision: z.number().int().positive(),
  agree: z.literal(true),
  role: z.enum(["buyer", "decision_maker"]).default("buyer"),
});
export async function acceptQuote(token: string, input: unknown) {
  const b = acceptanceSchema.parse(input),
    t = await tenantForToken(token);
  return withBusiness(t.businessId, () =>
    prisma.$transaction(async (tx) => {
      const q = await tx.salesQuote.findUniqueOrThrow({ where: { id: t.id } });
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${"quote:" + q.familyId}))`,
      );
      const changed = await tx.salesQuote.updateMany({
        where: {
          id: t.id,
          businessId: t.businessId,
          tokenHash: hash(token),
          status: "shared",
          revision: b.revision,
          expiresAt: { gt: new Date() },
        },
        data: {
          status: "accepted",
          acceptedAt: new Date(),
          acceptedName: b.name,
          participants: json([
            {
              name: b.name,
              role: b.role,
              consent: true,
              at: new Date().toISOString(),
            },
          ]),
        },
      });
      if (!changed.count)
        throw new ApiError(
          "ההצעה השתנתה, פגה או כבר אושרה. רענן את הדף.",
          409,
          "state",
        );
      await audit(
        t.businessId,
        null,
        "sales_quote",
        t.id,
        "sales.quote_accepted",
        { revision: b.revision, role: b.role },
        tx,
      );
      return { accepted: true, paid: false };
    }),
  );
}

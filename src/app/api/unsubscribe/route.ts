import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { suppressContact } from "@/lib/suppression";
import { maskIdentifier, verifyUnsubscribeToken } from "@/lib/unsubscribe-token";

export const dynamic = "force-dynamic";

/**
 * Public unsubscribe (no login). Accepts the signed token from the link (JSON { token }) or the
 * RFC 8058 one-click POST (form field `List-Unsubscribe=One-Click` on /u/{token}). Idempotent.
 * The token is bound to one business + contact + identifier; nothing else can be affected.
 */
export async function POST(request: Request) {
  let token: string | null = null;
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) token = ((await request.json().catch(() => ({}))) as { token?: string }).token ?? null;
  else { const form = await request.formData().catch(() => null); token = (form?.get("token") as string | null) ?? null; }
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });
  const p = verifyUnsubscribeToken(token);
  if (!p) return NextResponse.json({ error: "הקישור אינו תקף או שפג תוקפו" }, { status: 400 });
  const business = await db.business.findFirst({ where: { id: p.b, isActive: true }, select: { id: true, name: true } });
  const contact = await db.contact.findFirst({ where: { id: p.c, businessId: p.b }, select: { id: true } });
  if (!business || !contact) return NextResponse.json({ error: "הקישור אינו תקף" }, { status: 400 });
  const result = await withBusiness(p.b, () => suppressContact({ businessId: p.b, contactId: p.c, identifier: p.i, scope: "marketing", source: p.ch, reason: p.ch === "email" ? "קישור הסרה באימייל" : "קישור הסרה ב-SMS", evidence: p.m ? `message:${p.m}` : "unsubscribe-link" }));
  { const { applyUnsubscribeAutomation } = await import("@/lib/unsubscribe-automation"); await withBusiness(p.b, () => applyUnsubscribeAutomation(p.b, p.c)); }
  if (p.m) await db.suppression.updateMany({ where: { businessId: p.b, contactId: p.c, revokedAt: null, messageId: null, source: p.ch }, data: { messageId: p.m } });
  return NextResponse.json({ ok: true, business: business.name, identifier: maskIdentifier(p.i), blocked: result.identifiers.length });
}

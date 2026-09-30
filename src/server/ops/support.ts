/**
 * "דווח על תקלה": an incident code the user can quote, plus the technical context support needs – route, browser,
 * recent API error codes and paths (no query strings, no bodies), app version, business / user ids. Secrets, tokens,
 * message contents and payment data are never collected; anything that looks like a secret is dropped.
 */
import crypto from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { raiseAlert } from "./alerts";

const SECRETISH = /(token|secret|password|authorization|apikey|api_key|cvv|card|uk_live_|whsec_|cbsec_|bearer)/i;
const clean = (v: unknown, max = 300): string => String(v ?? "").replace(/\?.*$/, "").slice(0, max);
export const ticketSchema = z.object({
  message: z.string().trim().min(3).max(4000),
  context: z.object({
    route: z.string().max(300).optional(), userAgent: z.string().max(400).optional(), lang: z.string().max(10).optional(), appVersion: z.string().max(60).optional(),
    online: z.boolean().optional(), telephony: z.string().max(60).optional(),
    errors: z.array(z.object({ at: z.string().max(40), status: z.number().int().optional(), code: z.string().max(80).optional(), path: z.string().max(300).optional(), message: z.string().max(300).optional() })).max(20).optional(),
  }).default({}),
});

export async function createTicket(user: SessionUser, input: unknown) {
  const b = ticketSchema.parse(input);
  const ctx = b.context;
  const errors = (ctx.errors ?? []).filter((e) => !SECRETISH.test(`${e.path ?? ""} ${e.message ?? ""}`)).map((e) => ({ at: clean(e.at, 40), status: e.status ?? null, code: clean(e.code, 80), path: clean(e.path), message: clean(e.message) }));
  const code = `UC-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const t = await db.supportTicket.create({ data: { code, businessId: user.businessId, userId: user.id, message: SECRETISH.test(b.message) ? b.message.replace(/\S{24,}/g, "[הוסר]") : b.message, context: { route: clean(ctx.route), userAgent: clean(ctx.userAgent, 400), lang: ctx.lang ?? null, appVersion: ctx.appVersion ?? process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null, online: ctx.online ?? null, telephony: ctx.telephony ?? null, errors, role: user.role, support: Boolean(user.supportSessionId) } as Prisma.InputJsonValue } });
  await raiseAlert({ fingerprint: `support:ticket:${t.id}`, severity: "info", category: "support", businessId: user.businessId, title: `פנייה ${code} מתוך המערכת`, details: { code, route: clean(ctx.route) } });
  return { code: t.code, createdAt: t.createdAt };
}

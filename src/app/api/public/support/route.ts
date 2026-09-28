import crypto from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
const schema = z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(200), businessName: z.string().trim().max(200).optional(), topic: z.enum(["support", "privacy", "deletion", "billing", "other"]), message: z.string().trim().min(5).max(5000), lang: z.enum(["he", "en"]).default("he"), website: z.string().max(0).optional() });

/** Public contact form (no login). Stored for the platform team; 5 per hour per sender IP. */
export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "invalid" }, { status: 400 });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  const ipHash = crypto.createHash("sha256").update(`${process.env.JWT_SECRET ?? ""}:${ip}`).digest("hex").slice(0, 32);
  if ((await db.supportRequest.count({ where: { ipHash, createdAt: { gte: new Date(Date.now() - 3600_000) } } })) >= 5) return Response.json({ error: "too many requests" }, { status: 429 });
  const { website: _hp, ...data } = parsed.data; void _hp;
  const r = await db.supportRequest.create({ data: { ...data, businessName: data.businessName || null, ipHash } });
  return Response.json({ id: r.id }, { status: 201 });
}

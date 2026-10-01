import { Prisma } from "@/generated/prisma/client";
/**
 * Adding people to a business by invitation – an owner never chooses (or learns) someone else's password.
 *
 *   invite  → membership created INACTIVE with a one-time link (only its SHA-256 is stored, 7-day expiry). The owner
 *             hands the link to the person. The response is the same whether or not the email already has an account.
 *   accept  → account nobody has claimed (created by an invite): the link holder sets the password → the account is
 *             claimed and any older session is revoked. Claimed account: the link holder must enter that account's
 *             password. Then the membership is activated.
 * This closes the takeover where business A pre-created an account for someone's email with a password A knows and
 * business B later added that email: B's link lets the real person set their own password, A's password stops working.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db, prisma, dbSchema, type Db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import { consumeQuota } from "@/lib/modules";
import { audit } from "@/lib/audit";
import { assertTenantReferences } from "@/lib/tenant-references";

const INVITE_TTL_MS = 7 * 24 * 3600_000;
const hashToken = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const appUrl = () => (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

function newToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
}

export interface InviteInput { fullName: string; email: string; role: "owner" | "manager" | "agent"; teamId?: string | null }

export async function inviteUser(businessId: string, actorId: string, input: InviteInput) {
  await assertTenantReferences(businessId, { teamId: input.teamId });
  const email = input.email.toLowerCase().trim();
  if (await prisma.user.findUnique({ where: { businessId_email: { businessId, email } } })) throw new ApiError("אימייל זה כבר קיים בעסק", 409, "duplicate_email");
  await consumeQuota(businessId, "users");
  // Identity level (may belong to other businesses) → outside the tenant scope. A new account gets an unusable
  // random password and stays unclaimed until its first invite is accepted.
  let account = await withoutBusiness(() => db.account.findUnique({ where: { email } }));
  if (!account) {
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
    account = await withoutBusiness(() => db.account.create({ data: { email, fullName: input.fullName.trim(), passwordHash, claimedAt: null } }));
  }
  const inv = newToken();
  const u = await prisma.user.create({
    data: { businessId, accountId: account.id, email, fullName: input.fullName.trim(), role: input.role, teamId: input.teamId ?? null, isActive: false, inviteTokenHash: inv.hash, inviteExpiresAt: inv.expiresAt, invitedAt: new Date() },
    select: { id: true, fullName: true, email: true, role: true, isActive: true, teamId: true },
  });
  await audit(businessId, actorId, "user", u.id, "user.invited", { email, role: input.role });
  return { ...u, pendingInvite: true, inviteUrl: `${appUrl()}/invite/${inv.token}`, inviteExpiresAt: inv.expiresAt };
}

/** A fresh link for a membership that was never accepted (the old link stops working). */
export async function reissueInvite(businessId: string, actorId: string, userId: string) {
  const u = await prisma.user.findFirst({ where: { id: userId, businessId }, select: { id: true, isActive: true, invitedAt: true, inviteTokenHash: true } });
  if (!u) throw new ApiError("משתמש לא נמצא", 404, "not_found");
  if (!u.inviteTokenHash && !u.invitedAt) throw new ApiError("למשתמש זה אין הזמנה ממתינה", 409, "no_pending_invite");
  if (u.isActive) throw new ApiError("ההזמנה כבר התקבלה", 409, "invite_accepted");
  const inv = newToken();
  await prisma.user.update({ where: { id: u.id }, data: { inviteTokenHash: inv.hash, inviteExpiresAt: inv.expiresAt } });
  await audit(businessId, actorId, "user", u.id, "user.invite_reissued", {});
  return { inviteUrl: `${appUrl()}/invite/${inv.token}`, inviteExpiresAt: inv.expiresAt };
}

async function findInvite(token: string, client: Db = db) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const u = await withoutBusiness(() => client.user.findUnique({ where: { inviteTokenHash: hashToken(token) }, include: { account: true, business: { select: { id: true, name: true, isActive: true } } } }));
  if (!u || !u.inviteExpiresAt || u.inviteExpiresAt < new Date() || !u.business.isActive || !u.account.isActive) return null;
  return u;
}

/** What the invite page shows. Only the link holder can ask; nothing about other businesses is revealed. */
export async function inviteInfo(token: string) {
  const u = await findInvite(token);
  if (!u) throw new ApiError("ההזמנה אינה בתוקף – בקש מבעל העסק קישור חדש", 404, "invite_invalid");
  return { businessName: u.business.name, email: u.email, fullName: u.fullName, mode: u.account.claimedAt ? "confirm_password" as const : "set_password" as const };
}

/** Accept: set the password of an unclaimed account, or prove the password of a claimed one. Activates the membership. */
export async function acceptInvite(token: string, password: string) {
  const u = await findInvite(token);
  if (!u) throw new ApiError("ההזמנה אינה בתוקף – בקש מבעל העסק קישור חדש", 404, "invite_invalid");
  return withoutBusiness(() => db.$transaction(async tx => {
    // Lock the identity, not just the invitation: two businesses can invite the same unclaimed account.
    const table = Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."accounts"`);
    await tx.$queryRaw`SELECT id FROM ${table} WHERE id = ${u.accountId} FOR UPDATE`;
    const current = await findInvite(token, tx);
    if (!current) throw new ApiError("ההזמנה כבר נוצלה או אינה בתוקף", 409, "invite_used");
    let sessionVersion = current.account.sessionVersion;
    if (!current.account.claimedAt) {
      if (password.length < 8) throw new ApiError("סיסמה של 8 תווים לפחות", 400, "weak_password");
      const passwordHash = await bcrypt.hash(password, 12);
      const acc = await tx.account.update({ where: { id: current.accountId }, data: { passwordHash, claimedAt: new Date(), sessionVersion: { increment: 1 } }, select: { sessionVersion: true } });
      sessionVersion = acc.sessionVersion;
    } else if (!(await bcrypt.compare(password, current.account.passwordHash))) {
      throw new ApiError("הסיסמה שגויה – הזן את הסיסמה של החשבון הקיים שלך", 403, "bad_password");
    }
    // Password claim and token consumption commit together; a lost/reissued token rolls everything back.
    const done = await tx.user.updateMany({ where: { id: current.id, inviteTokenHash: current.inviteTokenHash, inviteExpiresAt: { gt: new Date() } }, data: { isActive: true, inviteTokenHash: null, inviteExpiresAt: null } });
    if (!done.count) throw new ApiError("ההזמנה כבר נוצלה", 409, "invite_used");
    await tx.auditLog.create({ data: { businessId: current.businessId, actorId: current.id, entityType: "user", entityId: current.id, action: "user.invite_accepted", payload: { claimedAccount: !current.account.claimedAt } } });
    return { userId: current.id, accountId: current.accountId, businessId: current.businessId, sessionVersion };
  })).catch(async error => {
    if (error instanceof ApiError && error.code === "bad_password") await audit(u.businessId, null, "user", u.id, "user.invite_rejected", { reason: "wrong_password" });
    throw error;
  });
}

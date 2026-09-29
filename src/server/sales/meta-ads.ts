import { z } from "zod";
import { prisma } from "@/lib/db";
import { graph } from "@/lib/meta/graph";
import { sealSecret, openSecret, encryptionConfigured } from "@/lib/crypto";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { leadFor } from "./quotes";
const owner = (u: SessionUser) => {
  if (u.role !== "owner")
    throw new ApiError("רק בעל העסק יכול לשנות חיבור פרסום", 403, "forbidden");
};
export async function metaAdStatus(user: SessionUser) {
  const c = await prisma.metaAdConnection.findUnique({
    where: { businessId: user.businessId },
    select: { accountId: true, accountName: true, verifiedAt: true },
  });
  return {
    connection: c,
    canManage: user.role === "owner",
    encryptionReady: encryptionConfigured(),
  };
}
export async function connectMetaAds(user: SessionUser, input: unknown) {
  owner(user);
  const b = z
    .object({
      accountId: z.string().regex(/^(act_)?\d{3,30}$/),
      accessToken: z.string().min(10).max(4096),
    })
    .parse(input);
  if (!encryptionConfigured())
    throw new ApiError(
      "יש להגדיר הצפנת חיבורים בשרת לפני חיבור חשבון",
      409,
      "encryption_missing",
    );
  const accountId = b.accountId.replace(/^act_/, "");
  let account: { account_id: string; name: string };
  try {
    account = await graph(`act_${accountId}`, {
      token: b.accessToken,
      query: { fields: "account_id,name" },
    });
  } catch {
    throw new ApiError(
      "Meta לא אישרה גישה לחשבון. בדוק מזהה חשבון, תוקף אסימון והרשאת ads_read.",
      400,
      "meta_access",
    );
  }
  if (account.account_id !== accountId)
    throw new ApiError("החשבון שהוחזר אינו תואם", 400, "account_mismatch");
  const data = {
    accountId,
    accountName: String(account.name ?? accountId).slice(0, 200),
    tokenSealed: sealSecret(b.accessToken),
    verifiedAt: new Date(),
  };
  await prisma.metaAdConnection.upsert({
    where: { businessId: user.businessId },
    create: { businessId: user.businessId, ...data },
    update: data,
  });
  await audit(
    user.businessId,
    user.id,
    "business",
    user.businessId,
    "sales.meta_connected",
    { accountId },
  );
  return metaAdStatus(user);
}
export async function disconnectMetaAds(user: SessionUser) {
  owner(user);
  await prisma.metaAdConnection.deleteMany({
    where: { businessId: user.businessId },
  });
  await audit(
    user.businessId,
    user.id,
    "business",
    user.businessId,
    "sales.meta_disconnected",
    {},
  );
  return { disconnected: true };
}
function imageUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      (u.hostname.endsWith(".fbcdn.net") ||
        u.hostname.endsWith(".facebook.com") ||
        u.hostname.endsWith(".fbsbx.com"))
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export async function leadAdvertisement(user: SessionUser, leadId: string) {
  const lead = await leadFor(user, leadId);
  const fields = (lead.sourceAttribution ?? {}) as Record<string, unknown>;
  const raw = fields.adId;
  const id = typeof raw === "string" && /^\d{3,30}$/.test(raw) ? raw : null;
  if (!id)
    return {
      status: "missing_attribution",
      message:
        "לא נשמר מזהה מודעה בליד. שם קמפיין או UTM לבדם אינם מזהים בוודאות מודעה.",
    };
  const conn = await prisma.metaAdConnection.findUnique({
    where: { businessId: user.businessId },
  });
  if (!conn)
    return {
      status: "not_connected",
      message: "מזהה מודעה נשמר, אך חשבון Facebook Ads טרם חובר.",
    };
  try {
    const ad = await graph<{
      id: string;
      name?: string;
      account_id: string;
      creative?: {
        title?: string;
        body?: string;
        image_url?: string;
        thumbnail_url?: string;
        video_id?: string;
      };
    }>(id, {
      token: openSecret(conn.tokenSealed),
      query: {
        fields:
          "id,name,account_id,creative{title,body,image_url,thumbnail_url,video_id}",
      },
    });
    if (ad.account_id !== conn.accountId || ad.id !== id)
      return {
        status: "account_mismatch",
        message: "המודעה אינה שייכת לחשבון הפרסום שחובר לעסק.",
      };
    let video: string | null = null;
    const videoId = ad.creative?.video_id;
    if (videoId && /^\d{3,30}$/.test(videoId)) {
      try {
        const v = await graph<{ source?: string }>(videoId, {
          token: openSecret(conn.tokenSealed),
          query: { fields: "source" },
        });
        video = imageUrl(v.source);
      } catch {
        /* Ad metadata remains useful when video permissions differ. */
      }
    }
    return {
      status: "available",
      ad: {
        id,
        video,
        name: String(ad.name ?? "").slice(0, 300),
        title: String(ad.creative?.title ?? "").slice(0, 500),
        body: String(ad.creative?.body ?? "").slice(0, 5000),
        image: imageUrl(ad.creative?.image_url ?? ad.creative?.thumbnail_url),
        hasVideo: Boolean(ad.creative?.video_id),
      },
      message:
        "פרטי המודעה לפי המזהה שנשמר בליד. במודעה דינמית או לאחר עריכה, התוכן עשוי להיות שונה מהגרסה שהלקוח ראה. תמונת וידאו היא תצוגה מקדימה בלבד.",
    };
  } catch {
    return {
      status: "unavailable",
      message:
        "Meta לא החזירה את המודעה. ייתכן שחסרה הרשאה, שהחיבור פג או שהמודעה אינה זמינה.",
    };
  }
}

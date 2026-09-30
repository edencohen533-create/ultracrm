import { prisma } from "@/lib/db";
import { graph } from "@/lib/meta/graph";
import { openSecret, encryptionConfigured } from "@/lib/crypto";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { leadFor } from "./quotes";
/** Legacy endpoints (/api/sales/meta) – now served by the Meta Ads connection of the marketing report. */
export async function metaAdStatus(user: SessionUser) {
  const { connectionStatus } = await import("@/server/marketing/meta-connection");
  const st = await connectionStatus(user);
  const first = st.accounts.find((a) => a.status !== "disconnected") ?? null;
  return {
    connection: st.connection ? { accountId: first?.accountId ?? st.connection.accountId, accountName: first?.name ?? st.connection.accountName, verifiedAt: st.connection.verifiedAt, status: st.connection.status } : null,
    canManage: st.canManage,
    encryptionReady: encryptionConfigured(),
  };
}
export async function connectMetaAds(user: SessionUser, input: unknown) {
  const { connectManualToken } = await import("@/server/marketing/meta-connection");
  await connectManualToken(user, input);
  return metaAdStatus(user);
}
export async function disconnectMetaAds(user: SessionUser) {
  const { disconnect } = await import("@/server/marketing/meta-connection");
  return disconnect(user);
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
  const accountIds = new Set((await prisma.metaAdAccount.findMany({ where: { businessId: user.businessId, status: { not: "disconnected" } }, select: { accountId: true } })).map((x) => x.accountId));
  if (conn?.accountId) accountIds.add(conn.accountId);
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
    if (!accountIds.has(ad.account_id) || ad.id !== id)
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

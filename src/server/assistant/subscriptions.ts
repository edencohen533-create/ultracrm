/**
 * Agents "on the line" (connected to the dialer) + personal subscriptions asked for in free text:
 *  • agentsOnline – per agent for a period: first connection, last activity, time online / paused / active,
 *    sessions, talk time, calls, answered, and who is connected right now. Computed from dialer sessions
 *    (a session ends at its last heartbeat when the tab went away – never counted until "ended" was noticed) and
 *    the pause / resume audit entries.
 *  • subscriptions – "תודיע לי כשנציגים עולים לקו", "כשדנה מתנתקת", "כל יום ב-18:00 כמה כל נציג היה בקו":
 *    stored per user in settings.assistant.subscriptions, delivered to that user's verified WhatsApp link.
 * Everything is scoped by the requesting user's visibility; nothing is ever sent about agents they may not see.
 */
import crypto from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings, type AssistantSubscription } from "@/lib/settings";
import { ToolError, resolveAgent, type ToolCtx } from "./tools";
import { periodRange, PERIODS, clockIn, localParts, type PeriodKey, type Range } from "./periods";

const HEARTBEAT_GRACE_MS = 60_000;
const ONLINE_NOW_MS = 2 * 60_000;

export interface OnlineRow { agent: string; agentId: string; status: "online" | "paused" | "offline"; firstOnline: Date | null; lastSeen: Date | null; sessions: number; onlineMinutes: number; pausedMinutes: number; activeMinutes: number; talkMinutes: number; calls: number; answered: number }

/** Time on the line per agent in the period (only agents the context may see). */
export async function agentsOnline(ctx: ToolCtx, r: Range, agentId?: string | null): Promise<{ period: Range; agents: OnlineRow[]; onlineNow: string[] }> {
  const now = ctx.now ?? new Date();
  const base = ctx.scope === "own" ? [ctx.userId] : ctx.visibleIds;
  if (agentId && base && !base.includes(agentId)) throw new ToolError("אין הרשאה לנתונים של הנציג הזה", "forbidden");
  const ids = agentId ? [agentId] : base;
  const users = await prisma.user.findMany({ where: { businessId: ctx.businessId, isActive: true, role: { in: ["agent", "manager", "owner"] }, ...(ids ? { id: { in: ids } } : {}) }, select: { id: true, fullName: true, role: true } });
  const userIds = users.map((u) => u.id);
  const sessions = await prisma.dialerSession.findMany({ where: { businessId: ctx.businessId, userId: { in: userIds }, startedAt: { lt: r.to }, OR: [{ endedAt: null }, { endedAt: { gt: r.from } }] }, orderBy: { startedAt: "asc" }, select: { id: true, userId: true, status: true, startedAt: true, endedAt: true, lastHeartbeatAt: true } });
  const pauses = sessions.length ? await prisma.auditLog.findMany({ where: { businessId: ctx.businessId, entityType: "session", entityId: { in: sessions.map((s) => s.id) }, action: { in: ["session.paused", "session.resumed"] } }, orderBy: { createdAt: "asc" }, select: { entityId: true, action: true, createdAt: true } }) : [];
  const calls = await prisma.call.groupBy({ by: ["userId"], where: { businessId: ctx.businessId, userId: { in: userIds }, direction: "outbound", createdAt: { gte: r.from, lt: r.to } }, _count: { _all: true, answeredAt: true }, _sum: { talkSeconds: true } });
  const clip = (d: Date) => new Date(Math.min(Math.max(d.getTime(), r.from.getTime()), Math.min(r.to.getTime(), now.getTime())));
  const rows: OnlineRow[] = users.map((u) => {
    const mine = sessions.filter((s) => s.userId === u.id);
    let online = 0, paused = 0; let first: Date | null = null, last: Date | null = null;
    for (const s of mine) {
      const endRaw = new Date(Math.min((s.endedAt ?? now).getTime(), s.lastHeartbeatAt.getTime() + HEARTBEAT_GRACE_MS, now.getTime()));
      const start = clip(s.startedAt), end = clip(endRaw);
      if (end <= start) continue;
      online += end.getTime() - start.getTime();
      if (!first || start < first) first = start; if (!last || end > last) last = end;
      // Pause intervals (paused → resumed, or paused until the session ended).
      const ev = pauses.filter((p) => p.entityId === s.id); let pausedAt: Date | null = null;
      for (const p of ev) { if (p.action === "session.paused") pausedAt = p.createdAt; else if (pausedAt) { paused += Math.max(0, clip(p.createdAt).getTime() - clip(pausedAt).getTime()); pausedAt = null; } }
      if (pausedAt) paused += Math.max(0, end.getTime() - clip(pausedAt).getTime());
    }
    const live = mine.find((s) => s.status !== "ended" && now.getTime() - s.lastHeartbeatAt.getTime() < ONLINE_NOW_MS);
    const c = calls.find((x) => x.userId === u.id);
    const m = (ms: number) => Math.round(ms / 60_000);
    return { agent: u.fullName, agentId: u.id, status: live ? (live.status === "paused" ? "paused" : "online") : "offline", firstOnline: first, lastSeen: live ? now : last, sessions: mine.length, onlineMinutes: m(online), pausedMinutes: m(paused), activeMinutes: m(online - paused), talkMinutes: Math.round((c?._sum.talkSeconds ?? 0) / 60), calls: c?._count._all ?? 0, answered: c?._count.answeredAt ?? 0 };
  });
  const active = rows.filter((x) => x.sessions > 0 || x.status !== "offline" || agentId).sort((a, b) => b.onlineMinutes - a.onlineMinutes);
  return { period: r, agents: active, onlineNow: rows.filter((x) => x.status !== "offline").map((x) => x.agent) };
}

const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} שע׳` : `${min} דק׳`);
export function fmtOnline(res: { period: Range; agents: OnlineRow[]; onlineNow: string[] }, tz: string) {
  const head = `🎧 זמני קו ${res.period.label} (${res.period.text}), נכון ל-${clockIn(tz)}`;
  if (!res.agents.length) return `${head}\nאף נציג לא התחבר לחייגן בתקופה הזו.`;
  const st = { online: "🟢 בקו עכשיו", paused: "⏸️ בהפסקה עכשיו", offline: "⚪ לא מחובר/ת" } as const;
  const lines = res.agents.map((a) => [`*${a.agent}* – ${st[a.status]}`, `  בקו: ${hm(a.onlineMinutes)}${a.pausedMinutes ? ` (מתוכן הפסקות ${hm(a.pausedMinutes)}, פעיל ${hm(a.activeMinutes)})` : ""}${a.firstOnline ? ` · התחבר/ה ${clockIn(tz, a.firstOnline)}` : ""}${a.status === "offline" && a.lastSeen ? ` · אחרון ${clockIn(tz, a.lastSeen)}` : ""}`, `  שיחות: ${a.calls} (נענו ${a.answered}) · זמן דיבור ${hm(a.talkMinutes)}${a.sessions > 1 ? ` · ${a.sessions} התחברויות` : ""}`].join("\n"));
  return [head, `מחוברים עכשיו: ${res.onlineNow.length ? res.onlineNow.join(", ") : "אף אחד"}`, "", ...lines].join("\n");
}

// ─── free text → subscription request ───────────────────────────────────────────────────────────────────────────
export type SubRequest =
  | { action: "subscribe"; kinds: Array<"agent_online" | "agent_offline">; agentNames: string[]; mode: "first_of_day" | "every" }
  | { action: "schedule"; time: string; days: number[]; question: string }
  | { action: "unsubscribe"; what: "online" | "report" | "all" }
  | { action: "list" }
  | { action: "clarify"; message: string };

const HOUR_WORDS: Record<string, number> = { "אחת עשרה": 11, "שתים עשרה": 12, "אחת": 1, "שתיים": 2, "שלוש": 3, "ארבע": 4, "חמש": 5, "שש": 6, "שבע": 7, "שמונה": 8, "תשע": 9, "עשר": 10 };
const ONLINE_WORDS = /(עול|עלה|עלתה|עלו|לעלות|מתחבר|התחבר|מתחברים|נכנס|נכנסו|מתחילים לעבוד|מתחיל לעבוד|אונליין|online|לחייגן|(^|\s)(לקו|בקו)(\s|$))/;
const OFFLINE_WORDS = /(יורד|יורדת|ירד|ירדה|ירדו|יורדים|מתנתק|התנתק|מתנתקים|יוצא|יצא|יצאו|מסיים|סיים|סיימו|offline)/;

export function parseSubscription(text: string, agentNames: string[]): SubRequest | null {
  const t = text.replace(/[?!.,״"]/g, " ").replace(/\s+/g, " ").trim();
  if (/^(מה|אילו|איזה|תראה לי)?\s*(ה)?(התראות|מנויים|סיכומים קבועים|דוחות קבועים)( שלי)?$|ההתראות שלי|על מה אתה מודיע לי/.test(t)) return { action: "list" };
  if (/(תפסיק|הפסק|תבטל|בטל|אל תשלח|אל תודיע|לא צריך|די עם|הסר)/.test(t) && /(התרא|להודיע|להתריע|עדכון|עדכונים|סיכום|דוח|הודעות|לשלוח)/.test(t)) {
    const what = /(סיכום|דוח)/.test(t) && !ONLINE_WORDS.test(t) ? "report" : ONLINE_WORDS.test(t) || OFFLINE_WORDS.test(t) ? "online" : "all";
    return { action: "unsubscribe", what };
  }
  const recurring = t.match(/(כל יום|בכל יום|כל בוקר|כל ערב|כל צהריים|יומי|כל יום עבודה|בימי עבודה|כל שבוע|כל יום [א-ו]׳?|בכל יום [א-ו]׳?)/);
  if (recurring && /(תשלח|שלח|תעביר|תן לי|תביא|אני רוצה|סיכום|דוח|תעדכן|תודיע)/.test(t)) {
    const words = Object.keys(HOUR_WORDS).join("|");
    const m = t.match(new RegExp(`(?:ב-?\\s*|בשעה\\s*)(\\d{1,2})(?::(\\d{2}))?(?!\\d)|(?:ב|בשעה\\s*)(${words})(?![א-ת])`));
    let h: number | null = null, mi = 0;
    if (m) { h = m[1] ? Number(m[1]) : HOUR_WORDS[m[3]]; mi = m[2] ? Number(m[2]) : 0; }
    if (h !== null && (/(בערב|אחה"צ|אחר הצהריים|בלילה)/.test(t) || (/כל ערב/.test(t))) && h < 12) h += 12;
    if (h === null || h > 23 || mi > 59) return { action: "clarify", message: "באיזו שעה לשלוח? למשל: \"כל יום ב-18:00 סיכום זמני קו\"" };
    if (!/(בערב|בבוקר|בצהריים|בלילה|:\d{2}|אחה"צ|כל ערב|כל בוקר)/.test(t) && !(m && m[2]) && h >= 1 && h <= 7) return { action: "clarify", message: `ב-${h} בבוקר או ב-${h + 12}:00? כתוב למשל "ב-${h + 12}:00".` };
    const days = /(ימי עבודה|כל יום עבודה|א-ה|א׳-ה׳)/.test(t) ? [0, 1, 2, 3, 4] : /כל שבוע/.test(t) ? [0] : [0, 1, 2, 3, 4, 5, 6];
    const question = t.replace(recurring[0], " ").replace(m?.[0] ?? "", " ").replace(/(תשלח לי|שלח לי|תעביר לי|תן לי|תביא לי|אני רוצה לקבל|אני רוצה|תעדכן אותי|תודיע לי|בערב|בבוקר|בצהריים)/g, " ").replace(/\s+/g, " ").trim();
    return { action: "schedule", time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`, days, question: question || "סיכום" };
  }
  const asksNotify = /(תודיע|תעדכן|תתריע|תשלח לי|תגיד לי|עדכן אותי|הודע לי|תכתוב לי|אני רוצה (לקבל )?(התראה|הודעה|עדכון|לדעת)|התראה|תזכיר לי)/.test(t);
  const when = /(כש|כאשר|ברגע ש|מתי ש|אם |כל פעם ש|בכל פעם ש)/.test(t);
  if (asksNotify && (when || /(התראה|התראות)/.test(t)) && (ONLINE_WORDS.test(t) || OFFLINE_WORDS.test(t))) {
    const kinds: Array<"agent_online" | "agent_offline"> = [];
    // "עולה" / "מתחבר" → online; "יורד" / "מתנתק" → offline; both words → both. "לקו" alone (no direction) → online.
    const on = /(עול|עלה|עלתה|עלו|לעלות|מתחבר|התחבר|מתחברים|נכנס|נכנסו|מתחיל|אונליין|online)/.test(t) || !OFFLINE_WORDS.test(t);
    if (on) kinds.push("agent_online");
    if (OFFLINE_WORDS.test(t)) kinds.push("agent_offline");
    if (!kinds.length) kinds.push("agent_online");
    const names: string[] = [];
    for (const full of agentNames) { const first = full.split(" ")[0]; if (t.includes(full) || new RegExp(`(^|[\\sוש])(כש|ש)?${first}(\\s|$)`).test(t)) names.push(full); }
    return { action: "subscribe", kinds, agentNames: names, mode: /(כל פעם|בכל פעם|כל התחברות|בכל התחברות|תמיד)/.test(t) ? "every" : "first_of_day" };
  }
  return null;
}

// ─── storage (settings.assistant.subscriptions, row-locked JSON merge) ──────────────────────────────────────────
async function mutate(businessId: string, fn: (subs: AssistantSubscription[]) => AssistantSubscription[]) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "businesses" WHERE id = ${businessId} FOR UPDATE`;
    const biz = await tx.business.findUniqueOrThrow({ where: { id: businessId }, select: { settings: true } });
    const raw = (biz.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
    const a = ((raw.assistant ?? {}) as Record<string, unknown>);
    const next = fn(Array.isArray(a.subscriptions) ? (a.subscriptions as AssistantSubscription[]) : []);
    await tx.business.update({ where: { id: businessId }, data: { settings: { ...raw, assistant: { ...a, subscriptions: next } } as unknown as Prisma.InputJsonValue } });
    return next;
  });
}
export async function listSubscriptions(businessId: string, userId: string) {
  return (await getBusinessSettings(businessId)).assistant.subscriptions.filter((s) => s.userId === userId);
}
const DAY = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];
export function describeSub(s: AssistantSubscription, names: Map<string, string>) {
  const who = s.agentIds?.length ? s.agentIds.map((id) => names.get(id) ?? "נציג").join(", ") : "כל הנציגים";
  if (s.kind === "agent_online") return `🟢 כש${who === "כל הנציגים" ? "נציג" : who} מתחבר/ת לחייגן${s.mode === "every" ? " (בכל התחברות)" : " (בהתחברות הראשונה ביום)"}${who === "כל הנציגים" ? " – כל הנציגים" : ""}`;
  if (s.kind === "agent_offline") return `🔴 כש${who === "כל הנציגים" ? "נציג" : who} מתנתק/ת מהחייגן${who === "כל הנציגים" ? " – כל הנציגים" : ""}`;
  return `🗓️ ${s.days?.length === 7 ? "כל יום" : `בימים ${s.days?.map((d) => DAY[d]).join(",")}`} ב-${s.time}: "${s.topic}"`;
}

/**
 * Apply a parsed request for `user` (who must have a verified WhatsApp link to receive anything – the answer says so
 * otherwise). Returns the reply text.
 */
export async function applySubscription(user: SessionUser, req: SubRequest, agentNames: Array<{ id: string; fullName: string }>, originalText: string): Promise<string> {
  const names = new Map(agentNames.map((a) => [a.id, a.fullName]));
  const link = await prisma.assistantLink.findFirst({ where: { businessId: user.businessId, userId: user.id, status: "active" }, select: { id: true } });
  const noLink = link ? "" : "\n\n⚠️ אין לך עדיין מספר וואטסאפ מאומת – ההתראות יישלחו אליו אחרי החיבור (הגדרות → העוזר האישי בוואטסאפ).";
  if (req.action === "clarify") return `🤔 ${req.message}`;
  if (req.action === "list") {
    const subs = await listSubscriptions(user.businessId, user.id);
    return subs.length ? ["🔔 ההתראות והסיכומים שלך:", ...subs.map((s) => `• ${describeSub(s, names)}`), "", "לביטול: \"תפסיק להודיע כשנציגים עולים לקו\" / \"בטל את הסיכום היומי\""].join("\n") : "אין לך התראות או סיכומים קבועים. אפשר לכתוב למשל: \"תודיע לי כשנציגים עולים לקו\" או \"כל יום ב-18:00 תשלח לי כמה כל נציג היה בקו\".";
  }
  if (req.action === "unsubscribe") {
    let removed: AssistantSubscription[] = [];
    await mutate(user.businessId, (subs) => { const keep = subs.filter((s) => !(s.userId === user.id && (req.what === "all" || (req.what === "online" ? s.kind !== "report" : s.kind === "report")))); removed = subs.filter((s) => !keep.includes(s)); return keep; });
    return removed.length ? `✅ בוטל: ${removed.map((s) => describeSub(s, names)).join(" · ")}` : "לא מצאתי התראה כזו פעילה אצלך.";
  }
  if (req.action === "subscribe") {
    if (user.role === "agent") return "⛔ התראות על נציגים אחרים זמינות למנהלים בלבד.";
    const ids = await visibleUserIds(user);
    const chosen = req.agentNames.map((n) => agentNames.find((a) => a.fullName === n)).filter(Boolean) as Array<{ id: string; fullName: string }>;
    const outOfScope = chosen.filter((a) => ids && !ids.includes(a.id));
    if (outOfScope.length) return `⛔ אין לך הרשאה לנתונים של ${outOfScope.map((a) => a.fullName).join(", ")}.`;
    const created: AssistantSubscription[] = req.kinds.map((kind) => ({ id: crypto.randomUUID(), userId: user.id, kind, agentIds: chosen.length ? chosen.map((a) => a.id) : null, mode: req.mode, text: originalText.slice(0, 300), createdAt: new Date().toISOString() }));
    await mutate(user.businessId, (subs) => [...subs.filter((s) => !(s.userId === user.id && req.kinds.includes(s.kind as never) && JSON.stringify(s.agentIds ?? null) === JSON.stringify(created[0].agentIds))), ...created]);
    return `✅ סגור. אודיע לך ${created.map((s) => describeSub(s, names).replace(/^[🟢🔴] /u, "")).join(" וגם ")}.${req.mode === "first_of_day" && req.kinds.includes("agent_online") ? "\n(רק בהתחברות הראשונה של כל נציג ביום – לכל התחברות כתוב \"בכל פעם\".)" : ""}${noLink}`;
  }
  // schedule
  const { parse } = await import("./router");
  const p = parse(req.question, agentNames.map((a) => a.fullName));
  const online = /((^|\s)(בקו|לקו)(\s|$)|מחובר|אונליין|זמני קו|זמן קו|שעות עבודה|התחבר)/.test(req.question);
  if (!p.intent && !online && req.question !== "סיכום") return `🤔 מה לשלוח ב-${req.time}? למשל: "סיכום", "כמה כל נציג היה בקו", "לידים ללא טיפול", "מכירות".`;
  const sub: AssistantSubscription = { id: crypto.randomUUID(), userId: user.id, kind: "report", agentIds: null, time: req.time, days: req.days, topic: req.question, period: "today", text: originalText.slice(0, 300), createdAt: new Date().toISOString() };
  await mutate(user.businessId, (subs) => [...subs.filter((s) => !(s.userId === user.id && s.kind === "report" && s.time === sub.time && s.topic === sub.topic)), sub]);
  return `✅ סגור. ${describeSub(sub, names).replace(/^🗓️ /u, "")} – אשלח לך את זה.${noLink}`;
}

// ─── delivery ───────────────────────────────────────────────────────────────────────────────────────────────────
async function claim(businessId: string, key: string, linkId: string, kind: string) {
  try { return await prisma.assistantDelivery.create({ data: { businessId, key, linkId, kind, status: "pending" } }); }
  catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null; throw e; }
}
async function sendTo(businessId: string, userId: string, key: string, kind: string, title: string, text: string) {
  const link = await prisma.assistantLink.findFirst({ where: { businessId, userId, status: "active" } });
  if (!link) return false;
  const d = await claim(businessId, key, link.id, kind);
  if (!d) return false;
  const { sendToLink } = await import("./transport");
  let status = "failed", detail: string | undefined;
  try { const r = await sendToLink(link, text, { title }); status = r.status; detail = r.detail; if (r.status === "skipped") await prisma.assistantLink.update({ where: { id: link.id }, data: { pendingReport: text.slice(0, 8000) } }); }
  catch (e) { detail = (e as Error).message.slice(0, 200); }
  await prisma.assistantDelivery.update({ where: { id: d.id }, data: { status, detail: detail ?? null } });
  await prisma.assistantMessage.create({ data: { businessId, linkId: link.id, direction: "out", text: text.slice(0, 4000), intent: kind, tools: [], status: status === "sent" ? "ok" : status, error: detail ?? null } });
  return status === "sent" || status === "template";
}

/** agent.online / agent.offline → WhatsApp to every subscribed user who may see that agent. */
export async function deliverPresence(businessId: string, kind: "agent_online" | "agent_offline", payload: { userId: string; sessionId: string; listId?: string | null; mode?: string; reason?: string }, at: Date) {
  const settings = await getBusinessSettings(businessId);
  if (!settings.assistant.enabled || settings.assistant.paused) return { sent: 0, skipped: "assistant off" };
  const subs = settings.assistant.subscriptions.filter((s) => s.kind === kind && (!s.agentIds || s.agentIds.includes(payload.userId)) && s.userId !== payload.userId);
  if (!subs.length) return { sent: 0 };
  const agent = await prisma.user.findFirst({ where: { id: payload.userId, businessId }, select: { fullName: true } });
  if (!agent) return { sent: 0 };
  const tz = settings.timezone;
  const dayStart = periodRange(tz, "today", at).from;
  // "First of the day" = no earlier session of this agent today.
  const earlier = kind === "agent_online" ? await prisma.dialerSession.count({ where: { businessId, userId: payload.userId, startedAt: { gte: dayStart, lt: at }, NOT: { id: payload.sessionId } } }) : 0;
  let text: string;
  if (kind === "agent_online") {
    const list = payload.listId ? await prisma.dialList.findFirst({ where: { id: payload.listId, businessId }, select: { name: true } }) : null;
    text = `🟢 ${agent.fullName} התחבר/ה לחייגן (${clockIn(tz, at)})${list ? ` · קמפיין ${list.name}` : ""}${payload.mode ? ` · ${payload.mode === "power" ? "Power" : payload.mode === "preview" ? "Preview" : "ידני"}` : ""}${earlier ? ` · התחברות ${earlier + 1} היום` : ""}`;
  } else {
    const ctx: ToolCtx = { businessId, userId: payload.userId, role: "manager", scope: "business", tz, visibleIds: [payload.userId], now: at };
    const o = await agentsOnline(ctx, periodRange(tz, "today", at), payload.userId);
    const row = o.agents[0];
    text = `🔴 ${agent.fullName} ${payload.reason === "disconnected" ? "התנתק/ה (החלון נסגר או אבד חיבור)" : "סיים/ה את הסשן"} (${clockIn(tz, at)})${row ? ` · היום בקו ${hm(row.onlineMinutes)}, ${row.calls} שיחות` : ""}`;
  }
  let sent = 0;
  for (const s of subs) {
    if (kind === "agent_online" && s.mode !== "every" && earlier > 0) continue;
    const u = await prisma.user.findFirst({ where: { id: s.userId, businessId, isActive: true }, select: { id: true, role: true, teamId: true, email: true, fullName: true, accountId: true } });
    if (!u || u.role === "agent") continue;
    const ids = await visibleUserIds({ ...u, businessId });
    if (ids && !ids.includes(payload.userId)) continue; // never about an agent this user may not see
    if (await sendTo(businessId, u.id, `${kind}:${payload.sessionId}:${s.id}`, kind, kind === "agent_online" ? "נציג התחבר" : "נציג התנתק", text)) sent++;
  }
  return { sent };
}

/** Recurring reports asked for in free text (runs with the assistant scheduler, inside the business scope). */
export async function deliverScheduledReports(businessId: string, now = new Date()) {
  const settings = await getBusinessSettings(businessId);
  if (!settings.assistant.enabled || settings.assistant.paused) return 0;
  const tz = settings.timezone; const p = localParts(tz, now);
  const nowMin = p.h * 60 + p.mi; const date = `${p.y}-${p.m}-${p.d}`;
  let n = 0;
  for (const s of settings.assistant.subscriptions.filter((x) => x.kind === "report" && x.time && x.days?.includes(p.wd))) {
    const [hh, mm] = s.time!.split(":").map(Number); const at = hh * 60 + mm;
    if (nowMin < at || nowMin >= at + 180) continue;
    const link = await prisma.assistantLink.findFirst({ where: { businessId, userId: s.userId, status: "active" } });
    if (!link) continue;
    const { toolCtxFor } = await import("./inbound");
    const ctx = await toolCtxFor(link, tz); if (!ctx) continue; ctx.now = now;
    // Claim first (no double send), then answer the stored question exactly as if it was asked now.
    const d = await claim(businessId, `report:${s.id}:${date}`, link.id, "custom_report"); if (!d) continue;
    const text = await answerQuestion(ctx, s.topic ?? "סיכום");
    const { sendToLink } = await import("./transport");
    let status = "failed", detail: string | undefined;
    try { const r = await sendToLink(link, `🗓️ ${s.topic}\n${text}`, { title: "סיכום שביקשת" }); status = r.status; detail = r.detail; if (r.status === "skipped") await prisma.assistantLink.update({ where: { id: link.id }, data: { pendingReport: text.slice(0, 8000) } }); }
    catch (e) { detail = (e as Error).message.slice(0, 200); }
    await prisma.assistantDelivery.update({ where: { id: d.id }, data: { status, detail: detail ?? null } });
    await prisma.assistantMessage.create({ data: { businessId, linkId: link.id, direction: "out", text: text.slice(0, 4000), intent: "custom_report", tools: [], status: status === "sent" ? "ok" : status, error: detail ?? null } });
    if (status === "sent" || status === "template") n++;
  }
  return n;
}

/** Answer a stored question now (model when connected, the rule router otherwise). */
export async function answerQuestion(ctx: ToolCtx, question: string) {
  const { answer } = await import("./brain");
  return (await answer(ctx, question, {}, [])).text;
}

export function periodOf(key?: string): PeriodKey { return (PERIODS as readonly string[]).includes(key ?? "") ? (key as PeriodKey) : "today"; }
export { resolveAgent };

/** WhatsApp-friendly Hebrew formatting of tool results. Numbers come only from the tool result objects. */
import { clockIn, type Range } from "./periods";

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toLocaleString("he-IL", { maximumFractionDigits: 1 }));
const money = (list: Array<{ currency: string; amount: number }>) => (list.length ? list.map((m) => `${m.currency === "ILS" ? "₪" : `${m.currency} `}${m.amount.toLocaleString("he-IL", { maximumFractionDigits: 0 })}`).join(" + ") : "₪0");
const dur = (s: number | null) => (s === null ? "—" : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} דק׳`);
const when = (r: Range, tz: string) => (r.key === "today" ? `להיום, נכון ל-${clockIn(tz)}` : `ל${r.label} (${r.text})`);
const who = (agent: string | null) => (agent ? ` · ${agent}` : "");

type Sales = { dealsWon: number; revenueRecorded: Array<{ currency: string; amount: number }>; paymentsReceived: number | null; paymentsNote: string; storeOrders: { count: number; amount: number } | null };
type Leads = { newLeads: number; closedFromThem: number; closeRate: number | null };
type Calls = { outbound: number; answered: number; avgTalkSeconds: number | null };

export function fmtSnapshot(r: { period: Range; agent: string | null; sales: Sales; leads: Leads; calls: Calls; untreatedLeads: number; overdueTasks: number }, tz: string) {
  const lines = [
    `📊 תמונת מצב ${when(r.period, tz)}${who(r.agent)}`,
    `💰 מכירות (הכנסות שנרשמו): ${money(r.sales.revenueRecorded)}`,
    `✅ עסקאות שנסגרו: ${n(r.sales.dealsWon)}`,
    `👥 לידים חדשים: ${n(r.leads.newLeads)}`,
    `📞 שיחות שנענו: ${n(r.calls.answered)} מתוך ${n(r.calls.outbound)}`,
    `⏳ לידים ללא טיפול: ${n(r.untreatedLeads)}`,
    ...(r.overdueTasks ? [`⚠️ משימות באיחור: ${n(r.overdueTasks)}`] : []),
    ...(r.sales.storeOrders ? [`🛒 הזמנות מהחנות: ${n(r.sales.storeOrders.count)} (₪${n(r.sales.storeOrders.amount)})`] : []),
  ];
  const insight: string[] = [];
  if (r.untreatedLeads > 0 && r.calls.outbound === 0 && r.period.key === "today") insight.push(`יש ${r.untreatedLeads} לידים שמחכים ועדיין לא יצאו שיחות היום.`);
  else if (r.calls.outbound >= 10 && r.calls.answered / r.calls.outbound < 0.2) insight.push(`שיעור מענה נמוך (${Math.round((r.calls.answered / r.calls.outbound) * 100)}%) – אולי כדאי לחייג בשעות אחרות.`);
  return [...lines, ...(insight.length ? ["", `💡 תובנה: ${insight[0]}`] : [])].join("\n");
}
export function fmtSales(r: Sales & { period: Range; agent: string | null }, tz: string) {
  return [`💰 מכירות ${when(r.period, tz)}${who(r.agent)}`, `✅ עסקאות שנסגרו: ${n(r.dealsWon)}`, `🧾 הכנסות שנרשמו: ${money(r.revenueRecorded)}`, `💳 תשלומים שהתקבלו: לא זמין – ${r.paymentsNote}`, ...(r.storeOrders ? [`🛒 הזמנות מהחנות: ${n(r.storeOrders.count)} (₪${n(r.storeOrders.amount)})`] : [])].join("\n");
}
export function fmtLeads(r: Leads & { period: Range; agent: string | null }, tz: string) {
  return [`👥 לידים ${when(r.period, tz)}${who(r.agent)}`, `נכנסו: ${n(r.newLeads)}`, `נסגרו מתוכם: ${n(r.closedFromThem)}`, `אחוז סגירה: ${r.closeRate === null ? "—" : `${n(r.closeRate)}%`}`].join("\n");
}
export function fmtAgents(r: { period: Range; agents: Array<{ agent: string; dealsWon: number; revenue: number; newLeads: number; closeRate: number | null; callsOutbound: number; callsAnswered: number }> }, tz: string, topOnly = false) {
  if (!r.agents.length) return `👤 ${when(r.period, tz)}: אין פעילות של נציגים בתקופה הזו.`;
  if (topOnly) { const t = r.agents[0]; return t.dealsWon === 0 ? `🏆 ${when(r.period, tz)}: אף נציג עוד לא סגר עסקה.` : `🏆 הנציג שמכר הכי הרבה ${when(r.period, tz)}: ${t.agent} – ${n(t.dealsWon)} עסקאות, ₪${n(t.revenue)}`; }
  return [`👤 ביצועי נציגים ${when(r.period, tz)}`, ...r.agents.map((a) => `• ${a.agent}: ${n(a.dealsWon)} עסקאות · ₪${n(a.revenue)} · אחוז סגירה ${a.closeRate === null ? "—" : `${n(a.closeRate)}%`} (${n(a.newLeads)} לידים) · שיחות ${n(a.callsAnswered)}/${n(a.callsOutbound)}`)].join("\n");
}
export function fmtCalls(r: Calls & { period: Range; agent: string | null }, tz: string) {
  return [`📞 שיחות ${when(r.period, tz)}${who(r.agent)}`, `יצאו: ${n(r.outbound)}`, `נענו: ${n(r.answered)}${r.outbound ? ` (${Math.round((r.answered / r.outbound) * 100)}%)` : ""}`, `משך שיחה ממוצע: ${dur(r.avgTalkSeconds)}`].join("\n");
}
export function fmtUntreated(r: { count: number; agent: string | null; oldest: Array<{ name: string; owner: string; waitingMinutes: number }> }) {
  const age = (m: number) => (m >= 1440 ? `${Math.round(m / 1440)} ימים` : m >= 60 ? `${Math.round(m / 60)} שע׳` : `${m} דק׳`);
  return [`⏳ לידים ללא טיפול${who(r.agent)}: ${n(r.count)}`, ...r.oldest.map((l) => `• ${l.name} – ממתין ${age(l.waitingMinutes)} (${l.owner})`)].join("\n");
}
export function fmtOverdue(r: { count: number; agent: string | null; items: Array<{ title: string; assignee: string; contact: string | null; due: Date | string }> }, tz: string) {
  if (!r.count) return `✅ אין משימות מעקב באיחור${who(r.agent)}.`;
  const d = (x: Date | string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(x));
  return [`⚠️ משימות באיחור${who(r.agent)}: ${n(r.count)}`, ...r.items.map((t) => `• ${t.title}${t.contact ? ` – ${t.contact}` : ""} (${t.assignee}, היה ל-${d(t.due)})`)].join("\n");
}
export function fmtCompare(r: { agent: string | null; note: string | null; current: { period: Range; sales: Sales; leads: Leads; calls: Calls }; previous: { period: Range; sales: Sales; leads: Leads; calls: Calls } }) {
  const c = r.current; const p = r.previous;
  const rev = (s: Sales) => s.revenueRecorded.reduce((a, x) => a + x.amount, 0);
  const delta = (a: number, b: number) => (b === 0 ? (a === 0 ? "ללא שינוי" : "חדש") : `${a >= b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%`);
  return [`📈 ${c.period.label} (${c.period.text}) מול ${p.period.label} (${p.period.text})${who(r.agent)}`,
    `💰 הכנסות: ₪${n(rev(c.sales))} מול ₪${n(rev(p.sales))} (${delta(rev(c.sales), rev(p.sales))})`,
    `✅ עסקאות: ${n(c.sales.dealsWon)} מול ${n(p.sales.dealsWon)} (${delta(c.sales.dealsWon, p.sales.dealsWon)})`,
    `👥 לידים: ${n(c.leads.newLeads)} מול ${n(p.leads.newLeads)} (${delta(c.leads.newLeads, p.leads.newLeads)})`,
    `🎯 אחוז סגירה: ${c.leads.closeRate === null ? "—" : `${n(c.leads.closeRate)}%`} מול ${p.leads.closeRate === null ? "—" : `${n(p.leads.closeRate)}%`}`,
    `📞 שיחות שנענו: ${n(c.calls.answered)} מול ${n(p.calls.answered)}`,
    ...(r.note ? [`ℹ️ ${r.note}`] : [])].join("\n");
}
export function fmtContact(c: { name: string; phoneLast4: string; email: string | null; city: string | null; source: string | null; owner: string | null; consent: string; leads: Array<{ status: string; title: string | null }>; deals: Array<{ title: string; stage: string; amount: number }>; lastCalls: Array<{ at: Date | string; answered: boolean; outcome: string | null }>; openTasks: Array<{ title: string }> }, tz: string) {
  const d = (x: Date | string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "numeric", month: "numeric" }).format(new Date(x));
  return [`👤 ${c.name} (…${c.phoneLast4})${c.city ? ` · ${c.city}` : ""}`, `אחראי: ${c.owner ?? "ללא"} · מקור: ${c.source ?? "—"} · דיוור: ${c.consent === "OPTED_IN" ? "הסכים" : c.consent === "OPTED_OUT" ? "הוסר" : "לא ידוע"}`,
    c.leads.length ? `לידים: ${c.leads.map((l) => l.status).join(", ")}` : "אין לידים",
    c.deals.length ? `עסקאות: ${c.deals.map((x) => `${x.title} (${x.stage}, ₪${n(x.amount)})`).join("; ")}` : "אין עסקאות",
    c.lastCalls.length ? `שיחות אחרונות: ${c.lastCalls.map((x) => `${d(x.at)} ${x.answered ? (x.outcome ?? "נענתה") : "לא נענתה"}`).join(" · ")}` : "לא היו שיחות",
    ...(c.openTasks.length ? [`משימות פתוחות: ${c.openTasks.map((t) => t.title).join(", ")}`] : [])].join("\n");
}
export function fmtFocus(r: { untreatedOver1h: number; oldestUntreated: Array<{ name: string; waitingMinutes: number }>; overdueTasks: number; callbacksDueToday: number; dealsInNegotiation: { count: number; amount: number }; agentsWithoutCallsToday: string[] }) {
  const facts = [`📌 עובדות (עכשיו):`, `• לידים שממתינים מעל שעה ללא טיפול: ${n(r.untreatedOver1h)}`, `• משימות באיחור: ${n(r.overdueTasks)}`, `• חזרות מתוכננות להיום: ${n(r.callbacksDueToday)}`, `• עסקאות בהצעה/מו״מ: ${n(r.dealsInNegotiation.count)} (₪${n(r.dealsInNegotiation.amount)})`, ...(r.agentsWithoutCallsToday.length ? [`• נציגים בלי שיחות היום: ${r.agentsWithoutCallsToday.join(", ")}`] : [])];
  const recs: string[] = [];
  if (r.untreatedOver1h) recs.push(`לטפל קודם בלידים שממתינים (הוותיק: ${r.oldestUntreated[0]?.name ?? ""}) – ליד חם מתקרר מהר.`);
  if (r.overdueTasks) recs.push("לסגור את המשימות שבאיחור לפני לידים חדשים.");
  if (r.dealsInNegotiation.count) recs.push(`לדחוף את ${r.dealsInNegotiation.count} העסקאות שבמו״מ – הן הכי קרובות לכסף.`);
  if (r.agentsWithoutCallsToday.length) recs.push(`לבדוק עם ${r.agentsWithoutCallsToday.slice(0, 3).join(", ")} למה אין שיחות היום.`);
  return [...facts, "", "🎯 המלצה (פרשנות שלי, לא נתון):", ...(recs.length ? recs.map((x) => `• ${x}`) : ["• אין כרגע נקודות חריגות – אפשר להתמקד בלידים החדשים."])].join("\n");
}
export const HELP = ["אני העוזר העסקי שלך 🤖 אפשר לשאול למשל:", "• איך הולך היום?", "• כמה מכרנו השבוע?", "• כמה לידים נכנסו החודש וכמה נסגרו?", "• מה אחוז הסגירה של כל נציג?", "• מי מכר הכי הרבה היום?", "• כמה שיחות יצאו היום?", "• כמה לידים עוד לא קיבלו טיפול?", "• אילו משימות באיחור?", "• תשווה את השבוע לשבוע הקודם", "• תן לי סיכום של הלקוח [שם]", "• על מה להתמקד היום?", "• מי בקו עכשיו? כמה זמן כל נציג היה בקו היום?", "• תודיע לי כשנציגים עולים לקו (או: כשדנה מתנתקת)", "• כל יום ב-18:00 תשלח לי כמה כל נציג היה בקו", "• מה ההתראות שלי? / תפסיק להודיע"].join("\n");

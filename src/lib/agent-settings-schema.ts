import { uiLang } from "@/lib/i18n-labels";
import { z } from "zod";
const stage = z.object({ through: z.number().int().min(1).max(50), delay: z.number().int().min(1).max(168), unit: z.enum(["hours", "days"]) });
const schedule = z.array(stage).min(1).max(10).refine(rows => rows.every((r, i) => i === 0 || r.through > rows[i - 1].through), "טווחי הניסיונות חייבים לעלות ללא חפיפה");
export const agentSettingsSchema = z.object({
  assignFollowUps: z.boolean(), takeFollowUps: z.boolean(),
  numbers: z.array(z.object({ id: z.string().min(1), enabled: z.boolean() })).max(100).refine(rows => new Set(rows.map(r => r.id)).size === rows.length, "מספר כפול"),
  rotateAfter: z.number().int().min(1).max(20), randomRotation: z.boolean(),
  maxDailyUnanswered: z.number().int().min(1).max(20),
  newLead: schedule, followUp: schedule,
  strategy: z.enum(["business", "hot", "oldest", "attempts", "new_first"]),
  /** Personal override of "unanswered attempts before לא רלוונטי" (null/absent = campaign or business setting, 0 = off). */
  unansweredToIrrelevant: z.number().int().min(0).max(50).nullable().optional(),
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  assignFollowUps: false, takeFollowUps: false, numbers: [], rotateAfter: 2, randomRotation: true,
  maxDailyUnanswered: 3, newLead: [{ through: 5, delay: 2, unit: "hours" }, { through: 10, delay: 1, unit: "days" }],
  followUp: [{ through: 2, delay: 2, unit: "hours" }, { through: 10, delay: 1, unit: "days" }], strategy: "business",
};
const STRATEGIES_HE = [
  { id: "business", title: "לפי הגדרות העסק", text: "סדר העדיפויות הקיים של העסק, כולל מועד החזרה, עדיפות הליד ובעלות." },
  { id: "hot", title: "פולואפים לפני לידים חדשים", text: "פולואפים שהגיע מועדם קודמים (הוותיק ביותר ראשון), אחריהם לידים חדשים שטרם חויגו ואז ניסיונות חוזרים. פולואפ לא מחויג לפני המועד שנקבע." },
  { id: "oldest", title: "לידים חמים – סידור שיחות מהישן לחדש", text: "פולו־אפים שהגיע זמנם, ואז לידים לפי מספר ניסיונות מהנמוך לגבוה. בניקוד זהה הליד הישן קודם." },
  { id: "attempts", title: "לידים חמים – דגש על ניסיונות חיוג", text: "פולו־אפים שהגיע זמנם, ואז לידים עם פחות ניסיונות. בניקוד זהה הליד החדש קודם." },
  { id: "new_first", title: "לידים חדשים לפני פולואפים", text: "לידים שטרם חויגו קודמים; אחריהם פולואפים שהגיע מועדם (הוותיק ביותר ראשון) ואז ניסיונות חוזרים. פולואפ לא מחויג לפני המועד שנקבע." },
] as const;
const STRATEGY_EN: Record<string, { title: string; text: string }> = {"business": {"title": "By business settings", "text": "The business's existing priority order, including callback time, lead priority and ownership."}, "hot": {"title": "Follow-ups before new leads", "text": "Due follow-ups first (oldest first), then leads never dialed, then retries. A follow-up is never dialed before its time."}, "oldest": {"title": "Hot leads – oldest calls first", "text": "Due follow-ups, then leads by number of attempts from lowest to highest. On a tie the older lead comes first."}, "attempts": {"title": "Hot leads – focus on dial attempts", "text": "Due follow-ups, then leads with fewer attempts. On a tie the newer lead comes first."}, "new_first": {"title": "New leads before follow-ups", "text": "Leads never dialed come first; then due follow-ups (oldest first), then retries. A follow-up is never dialed before its time."}};
/** Dialing strategies – title/text follow the interface language (English UI in the browser). */
export const STRATEGIES = STRATEGIES_HE.map((s) => ({ id: s.id, get title() { return uiLang() === "en" ? STRATEGY_EN[s.id].title : s.title; }, get text() { return uiLang() === "en" ? STRATEGY_EN[s.id].text : s.text; } }));
export function retryRule(settings: AgentSettings, followUp: boolean, attempts: number) {
  const stages = followUp ? settings.followUp : settings.newLead;
  const current = stages.find(s => attempts < s.through) ?? stages[stages.length - 1];
  return { maxAttempts: stages[stages.length - 1].through, minutes: current.delay * (current.unit === "days" ? 1440 : 60) };
}

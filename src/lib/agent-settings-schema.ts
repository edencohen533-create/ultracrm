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
});
export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  assignFollowUps: false, takeFollowUps: false, numbers: [], rotateAfter: 2, randomRotation: true,
  maxDailyUnanswered: 3, newLead: [{ through: 5, delay: 2, unit: "hours" }, { through: 10, delay: 1, unit: "days" }],
  followUp: [{ through: 2, delay: 2, unit: "hours" }, { through: 10, delay: 1, unit: "days" }], strategy: "business",
};
export const STRATEGIES = [
  { id: "business", title: "לפי הגדרות העסק", text: "סדר העדיפויות הקיים של העסק, כולל מועד החזרה, עדיפות הליד ובעלות." },
  { id: "hot", title: "לידים חמים", text: "פולו־אפים שהגיע זמנם, אחריהם לידים שטרם חויגו ואז ניסיונות חוזרים. בכל קבוצה הלידים החדשים יותר קודמים." },
  { id: "oldest", title: "לידים חמים – סידור שיחות מהישן לחדש", text: "פולו־אפים שהגיע זמנם, ואז לידים לפי מספר ניסיונות מהנמוך לגבוה. בניקוד זהה הליד הישן קודם." },
  { id: "attempts", title: "לידים חמים – דגש על ניסיונות חיוג", text: "פולו־אפים שהגיע זמנם, ואז לידים עם פחות ניסיונות. בניקוד זהה הליד החדש קודם." },
  { id: "new_first", title: "לידים חמים – תעדוף לידים חדשים לפני פולו־אפ", text: "לידים שטרם חויגו קודמים לפולו־אפים ולניסיונות חוזרים. אפשרות זו עלולה לעכב חזרות שנקבעו." },
] as const;
export function retryRule(settings: AgentSettings, followUp: boolean, attempts: number) {
  const stages = followUp ? settings.followUp : settings.newLead;
  const current = stages.find(s => attempts < s.through) ?? stages[stages.length - 1];
  return { maxAttempts: stages[stages.length - 1].through, minutes: current.delay * (current.unit === "days" ? 1440 : 60) };
}

import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { agentDecision, parseAgentAnswer } from "@/server/ops/engine";

const schema = z.union([z.object({ answer: z.enum(["yes", "no"]), count: z.number().int().min(1).max(100).optional() }), z.object({ text: z.string().trim().min(1).max(300) })]);

/** Agent answers in the app: yes (all / N) or no – or free text, parsed like a WhatsApp reply. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const ans = "text" in b ? parseAgentAnswer(b.text) : b.answer === "no" ? { kind: "no" as const } : { kind: "yes" as const, count: b.count ?? null };
  return ok(await agentDecision(user, params.id, ans, "app", "text" in b ? b.text : undefined));
}, { module: "crm" });

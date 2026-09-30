import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { interpret, type DraftDef } from "@/server/automations/translate";

export const dynamic = "force-dynamic";
/** Free text (+ the current draft, to correct it) → a draft definition, questions, unsupported parts. Nothing runs. */
const schema = z.object({ text: z.string().trim().min(3).max(2000), mode: z.enum(["journey", "rule"]).default("journey"), current: z.record(z.string(), z.unknown()).nullish() });
export const POST = withAuth(async ({ req }) => { const b = await parseBody(req, schema); return ok(await interpret(b.text, b.mode, (b.current ?? null) as DraftDef | null)); }, { minRole: "manager", perm: ["whatsapp.automations", "sms.send", "email.send"] });

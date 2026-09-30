import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { interpretRule } from "@/server/ops/rules";

/** Free text → a structured rule proposal (nothing is saved). */
export const POST = withAuth(async ({ req }) => {
  const { text } = await parseBody(req, z.object({ text: z.string().trim().min(5).max(1000) }));
  const r = await interpretRule(text);
  // A distribution rule is the owner's – created in CRM → חלוקת לידים (draft → owner approval), not here.
  if (r.kind === "performance_bonus") return ok({ ...r, kind: null, summary: null, questions: [], note: "זה כלל חלוקת לידים – בעל העסק יוצר ומאשר אותו במסך CRM ← חלוקת לידים. כאן לא נשמר דבר." });
  return ok(r);
}, { minRole: "manager", module: "crm" });

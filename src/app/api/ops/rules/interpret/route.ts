import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { interpretRule } from "@/server/ops/rules";

/** Free text → a structured rule proposal (nothing is saved). */
export const POST = withAuth(async ({ req }) => {
  const { text } = await parseBody(req, z.object({ text: z.string().trim().min(5).max(1000) }));
  return ok(await interpretRule(text));
}, { minRole: "manager", module: "crm" });

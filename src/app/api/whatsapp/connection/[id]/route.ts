import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { normalizePhone } from "@/lib/phone";
import { checkConnection, disconnectConnection, runSetupSteps, sendTestMessage, updateConnectionSettings } from "@/server/services/embedded-signup-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  action: z.enum(["check", "retry_setup", "disconnect", "test_send", "settings"]),
  testRecipients: z.array(z.string().trim().min(3).max(30)).max(10).optional(),
  unitPrice: z.number().min(0).max(100).nullable().optional(),
  unitPriceCurrency: z.string().trim().length(3).toUpperCase().nullable().optional(),
  pin: z.string().regex(/^\d{6}$/).optional(),
  reason: z.string().max(300).optional(),
  to: z.string().min(5).max(30).optional(),
  confirm: z.boolean().optional(),
});

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  switch (b.action) {
    case "check":
      return ok(await checkConnection(user, params.id));
    case "settings":
      return ok(await updateConnectionSettings(user, params.id, { testRecipients: b.testRecipients, unitPrice: b.unitPrice, unitPriceCurrency: b.unitPriceCurrency }));
    case "retry_setup":
      return ok(await runSetupSteps(user, params.id, undefined, b.pin));
    case "disconnect":
      if (!b.confirm) throw new ApiError("ניתוק דורש אישור מפורש", 400, "confirm_required");
      return ok(await disconnectConnection(user, params.id, b.reason));
    case "test_send": {
      const e164 = b.to ? normalizePhone(b.to) : null;
      if (!e164) throw new ApiError("מספר יעד לבדיקה לא תקין", 400, "invalid_phone");
      return ok(await sendTestMessage(user, params.id, e164));
    }
  }
}, { minRole: "manager", module: "messaging" });

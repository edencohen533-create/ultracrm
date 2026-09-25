import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { checkChannelCredential, connectSendingDomain, disconnectChannelCredential, verifySendingDomain } from "@/server/services/channel-credential-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({ action: z.enum(["check", "disconnect", "connect_domain", "verify_domain"]), domain: z.string().max(253).optional(), confirm: z.boolean().optional() });

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  switch (b.action) {
    case "check": return ok(await checkChannelCredential(user, params.id));
    case "disconnect":
      if (user.role !== "owner") throw new ApiError("ניתוק ספק – לבעל העסק בלבד", 403, "forbidden");
      if (!b.confirm) throw new ApiError("ניתוק דורש אישור מפורש", 400, "confirm_required");
      return ok(await disconnectChannelCredential(user, params.id));
    case "connect_domain":
      if (user.role !== "owner") throw new ApiError("חיבור דומיין – לבעל העסק בלבד", 403, "forbidden");
      if (!b.domain) throw new ApiError("נדרש שם דומיין", 400, "domain_required");
      return ok(await connectSendingDomain(user, params.id, b.domain));
    case "verify_domain": return ok(await verifySendingDomain(user, params.id));
  }
}, { minRole: "manager", module: "messaging" });

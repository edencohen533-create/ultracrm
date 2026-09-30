import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { onboardingChecklist, setOnboardingPath } from "@/server/onboarding/checklist";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => { if (user.role === "agent") throw new ApiError("למנהלים בלבד", 403, "forbidden"); return ok(await onboardingChecklist(user)); });
export const PUT = withAuth(async ({ req, user }) => { if (user.role !== "owner") throw new ApiError("לבעל העסק בלבד", 403, "forbidden"); const b = await parseBody(req, z.object({ path: z.enum(["own_crm", "external_crm"]) })); return ok(await setOnboardingPath(user, b.path)); });

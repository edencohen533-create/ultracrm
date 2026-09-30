import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { offboardingOverview } from "@/server/offboarding/offboarding";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user }) => ok(await offboardingOverview(user)));

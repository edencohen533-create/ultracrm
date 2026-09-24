import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { telephonyStatus } from "@/lib/telephony";

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => ok(telephonyStatus()));

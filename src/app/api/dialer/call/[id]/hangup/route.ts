import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { hangupCall } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ user, params }) => ok(await hangupCall(user, params.id)));

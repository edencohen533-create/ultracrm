import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import {
  assistanceCandidates,
  assistanceInbox,
  requestAssistance,
} from "@/server/sales/assistance";
export const GET = withAuth(
  async ({ user, req }) => {
    const id = req.nextUrl.searchParams.get("callId");
    return ok(
      id ? await assistanceCandidates(user, id) : await assistanceInbox(user),
    );
  },
  { perm: "telephony.use" },
);
export const POST = withAuth(
  async ({ user, req }) => ok(await requestAssistance(user, await req.json())),
  { perm: "telephony.use" },
);

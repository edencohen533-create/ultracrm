import { z } from "zod";
import { cookies } from "next/headers";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { deleteMyUser } from "@/server/services/account-deletion-service";

/** Any user: erase my personal details (typed confirmation) and sign out. */
export const POST = withAuth(async ({ req, user }) => {
  await parseBody(req, z.object({ confirm: z.enum(["מחק", "DELETE"]) }));
  await deleteMyUser(user);
  (await cookies()).delete("ultracrm_session");
  return ok({ deleted: true });
});

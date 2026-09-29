import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import {
  listSales,
  saveOffer,
  createQuote,
  quoteAction,
} from "@/server/sales/quotes";
export const GET = withAuth(
  async ({ req, user }) =>
    ok({
      ...(await listSales(
        user,
        req.nextUrl.searchParams.get("leadId") ?? undefined,
      )),
      canManage: user.role !== "agent",
    }),
  { perm: "crm.view" },
);
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("offer"),
    id: z.string().optional(),
    data: z.unknown(),
  }),
  z.object({ action: z.literal("quote"), data: z.unknown() }),
  z.object({ action: z.enum(["approve", "share", "revoke"]), id: z.string() }),
]);
export const POST = withAuth(
  async ({ req, user }) => {
    const b = await parseBody(req, schema);
    return ok(
      b.action === "offer"
        ? await saveOffer(user, b.data, b.id)
        : b.action === "quote"
          ? await createQuote(user, b.data)
          : await quoteAction(user, b.id, b.action),
    );
  },
  { perm: "crm.edit" },
);

import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { chatTurn } from "@/server/ai/engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const schema = z.object({ conversationId: z.string().min(1).max(60).nullable().optional(), text: z.string().trim().min(1).max(2000) });
export const POST = withAuth(async ({ req, user }) => ok(await chatTurn(user, { ...(await parseBody(req, schema)), channel: "app" })));

import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { createAppointment, createSchema, listAppointments } from "@/server/services/appointments";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ req, user }) => ok({ items: await listAppointments(user, parseQuery(req, z.object({ contactId: z.string().min(1) })).contactId) }), { perm: "crm.view" });
export const POST = withAuth(async ({ req, user }) => ok(await createAppointment(user, await parseBody(req, createSchema)), 201), { perm: "crm.edit" });

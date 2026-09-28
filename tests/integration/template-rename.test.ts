/**
 * WhatsApp template rename: the display name changes everywhere in the app (pickers get it as `name`), the provider
 * (Meta) name stays and is what sending uses; empty = back to the Meta name; agents cannot rename; business isolation.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { listSendableTemplates } from "@/server/services/template-service";
import { PATCH } from "@/app/api/templates/[id]/route";

let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let agent: SessionUser;
const accounts: string[] = [];
const patch = async (u: SessionUser, id: string, displayName: string | null) => PATCH(new NextRequest(`http://localhost/api/templates/${id}`, { method: "PATCH", headers: { cookie: `ultracrm_session=${await signSession(u)}`, "Content-Type": "application/json" }, body: JSON.stringify({ displayName }) }), { params: Promise.resolve({ id }) });

describe("WhatsApp template display name", { timeout: 600_000 }, () => {
  beforeAll(async () => {
    a = await createBusiness("tpl-rename", { modules: { crm: true, whatsapp: true } });
    b = await createBusiness("tpl-rename-b", { modules: { crm: true, whatsapp: true } });
    accounts.push(a.account.id, b.account.id);
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "נציג", passwordHash: "x" } }); accounts.push(acc.id);
    const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: "נציג", role: "agent" } });
    agent = { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: "נציג", role: "agent", teamId: null };
  }, 300_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("rename → pickers show the new name, Meta name kept for sending; empty resets; agent / other business refused", async () => {
    const t = await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "welcome_offer_v2", language: "he", category: "MARKETING", body: "שלום {{1}}", variables: ["1"], status: "APPROVED" } });
    const r = await patch(a.session, t.id, "  הצעת פתיחה  ");
    expect(r.status).toBe(200);
    expect((await r.json()).template).toMatchObject({ name: "הצעת פתיחה", metaName: "welcome_offer_v2" });
    expect(await db.template.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ name: "welcome_offer_v2", displayName: "הצעת פתיחה" });
    const picker = await withBusiness(a.business.id, () => listSendableTemplates(), a.session);
    expect(picker.find((x) => x.id === t.id)).toMatchObject({ name: "הצעת פתיחה", metaName: "welcome_offer_v2" });
    // empty → back to the Meta name
    await patch(a.session, t.id, "");
    expect((await db.template.findUniqueOrThrow({ where: { id: t.id } })).displayName).toBeNull();
    // agents cannot rename; another business cannot even see it
    expect((await patch(agent, t.id, "x")).status).toBe(403);
    expect((await patch(b.session, t.id, "x")).status).toBe(404);
    expect((await db.template.findUniqueOrThrow({ where: { id: t.id } })).displayName).toBeNull();
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "template.renamed", entityId: t.id } })).toBe(2);
  });
});

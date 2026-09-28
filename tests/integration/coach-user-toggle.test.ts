import { afterAll, beforeAll, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { signSession } from "@/lib/auth";
import { withBusiness } from "@/lib/tenant";
import { coachStatus } from "@/server/coach/session";
import { PATCH } from "@/app/api/users/[id]/route";
import { createBusiness, destroyBusiness } from "./helpers";

let tenant: Awaited<ReturnType<typeof createBusiness>>;
beforeAll(async () => {
  tenant = await createBusiness("coach-toggle", { modules: { telephony: true } });
  await db.business.update({ where: { id: tenant.business.id }, data: { settings: { coach: { enabled: true } } } });
});
afterAll(async () => { if (tenant) await destroyBusiness(tenant.business.id, [tenant.account.id]); });

it("persists disabling and re-enabling coaching through the user API", async () => {
  const cookie = `ultracrm_session=${await signSession(tenant.session)}`;
  for (const enabled of [false, true]) {
    const response = await PATCH(new NextRequest(`http://localhost/api/users/${tenant.user.id}`, {
      method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ coachEnabled: enabled }),
    }), { params: Promise.resolve({ id: tenant.user.id }) });
    expect(response.status).toBe(200);
    expect((await response.json()).data.coachEnabled).toBe(enabled);
    expect((await db.user.findUniqueOrThrow({ where: { id: tenant.user.id } })).coachEnabled).toBe(enabled);
    expect((await withBusiness(tenant.business.id, () => coachStatus(tenant.user.id))).enabled).toBe(enabled);
  }
});

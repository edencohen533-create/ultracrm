import crypto from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession } from "@/lib/auth";
import { addLeadsToList } from "@/lib/lists";
import { resolvedContactWhere } from "@/lib/crm/contact-filter";
import { GET as exportContacts } from "@/app/api/contacts/export/route";
import { createBusiness, destroyBusiness } from "./helpers";

describe("contact actions preserve the selected audience", () => {
  let biz: Awaited<ReturnType<typeof createBusiness>>, other: Awaited<ReturnType<typeof createBusiness>>;
  let chosen: string, excluded: string, listId: string, segmentId: string, staticId: string;
  const run = <T,>(fn: () => Promise<T>) => withBusiness(biz.business.id, fn, biz.session);
  beforeAll(async () => {
    biz = await createBusiness("filter-actions", { modules: { crm: true, telephony: true } });
    other = await createBusiness("foreign-audience");
    for (const [name, consentStatus] of [["chosen", "OPTED_IN"], ["excluded", "UNKNOWN"]] as const) {
      const phone = `+9725${crypto.randomInt(10000000, 99999999)}`;
      const c = await db.contact.create({ data: { businessId: biz.business.id, fullName: name, phoneE164: phone, phoneRaw: phone, source: name, consentStatus } });
      if (name === "chosen") chosen = c.id; else excluded = c.id;
    }
    listId = (await db.dialList.create({ data: { businessId: biz.business.id, name: "filtered dial list" } })).id;
    segmentId = (await db.distributionList.create({ data: { businessId: biz.business.id, name: "chosen only", segment: { operator: "AND", conditions: [{ field: "source", operator: "equals", value: "chosen" }] } } })).id;
    staticId = (await db.distributionList.create({ data: { businessId: biz.business.id, name: "static chosen", members: { create: { contactId: chosen } } } })).id;
  });
  afterAll(async () => { for (const b of [biz, other]) if (b) await destroyBusiness(b.business.id, [b.account.id]); });
  it("static audience adds only its members; other filters still intersect", async () => {
    expect(await run(() => addLeadsToList(biz.business.id, listId, { segmentId: staticId, consent: "UNKNOWN" }))).toBe(0);
    expect(await run(() => addLeadsToList(biz.business.id, listId, { segmentId: staticId, consent: "OPTED_IN" }))).toBe(1);
    expect((await db.listLead.findMany({ where: { listId } })).map(r => r.contactId)).toEqual([chosen]);
  });
  it("dynamic audience matches the same contacts as the screen", async () => {
    const where = await run(() => resolvedContactWhere(biz.business.id, { segmentId }));
    expect((await db.contact.findMany({ where })).map(c => c.id)).toEqual([chosen]);
  });
  it("export respects the selected static audience and consent filter", async () => {
    const req = new NextRequest(`http://localhost/api/contacts/export?segmentId=${staticId}&consent=OPTED_IN`, { headers: { cookie: `ultracrm_session=${await signSession(biz.session)}` } });
    const response = await exportContacts(req, { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    const csv = await response.text(); expect(csv).toContain(chosen); expect(csv).not.toContain(excluded);
  });
  it("missing and foreign audiences fail closed", async () => {
    const foreign = await db.distributionList.create({ data: { businessId: other.business.id, name: "foreign" } });
    for (const id of ["missing", foreign.id]) await expect(run(() => resolvedContactWhere(biz.business.id, { segmentId: id }))).rejects.toMatchObject({ code: "not_found" });
  });
});

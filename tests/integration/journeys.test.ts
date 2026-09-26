/**
 * Customer journeys (visual builder actions on the sequence engine): tag add/remove, list add/remove, webhook
 * (stubbed fetch, SSRF-guarded), task/notification, condition gate that exits, and validation.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { saveSequence, sequenceSchema, processDueSequenceRuns, isPublicHttps } = await import("@/server/services/sequence-service");
const { createContact } = await import("@/lib/crm/contacts");

describe("customer journeys", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let contactId: string; let listId: string; let dynListId: string;
  const run = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn, a.session);
  beforeAll(async () => {
    a = await createBusiness("journey", { modules: { messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } } });
    contactId = (await run(() => createContact(a.session, { fullName: "מסע", phone: "0503000001", email: "j@example.test" }))).id;
    listId = (await db.distributionList.create({ data: { businessId: a.business.id, name: "חמים" } })).id;
    dynListId = (await db.distributionList.create({ data: { businessId: a.business.id, name: "דינמי", segment: { operator: "AND", conditions: [{ field: "consent", operator: "is", value: "OPTED_IN" }] } } })).id;
  });
  afterAll(async () => { vi.restoreAllMocks(); await destroyBusiness(a.business.id, [a.account.id]); });
  const drain = async (runId: string) => { for (let i = 0; i < 12; i++) { await db.sequenceRun.updateMany({ where: { id: runId, status: "PENDING" }, data: { nextAt: new Date(0) } }); await run(() => processDueSequenceRuns()); const r = await db.sequenceRun.findUniqueOrThrow({ where: { id: runId } }); if (r.status !== "PENDING") return r; } return db.sequenceRun.findUniqueOrThrow({ where: { id: runId } }); };

  it("validation: webhook must be public https; lists must be static; each action needs its setting", async () => {
    expect(isPublicHttps("https://hooks.example.com/x")).toBe(true);
    for (const bad of ["http://example.com", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/", "ftp://x"]) expect(isPublicHttps(bad)).toBe(false);
    expect(sequenceSchema.safeParse({ name: "x", trigger: "CONTACT_CREATED", steps: [{ action: "add_tag", channel: "email", waitMinutes: 0 }] }).success).toBe(false);
    expect(sequenceSchema.safeParse({ name: "x", trigger: "CONTACT_CREATED", steps: [{ action: "wait", channel: "email", waitMinutes: 0 }] }).success).toBe(false);
    const dyn = sequenceSchema.parse({ name: "x", trigger: "CONTACT_CREATED", steps: [{ action: "add_to_list", channel: "email", waitMinutes: 0, listId: dynListId }] });
    await expect(run(() => saveSequence(a.session, dyn))).rejects.toThrow(/קהל דינמי/);
  });

  it("runs tag → list → webhook → notification in order, passes a satisfied condition, and exits at an unsatisfied one", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => { calls.push({ url: String(url), body: String(init?.body ?? "") }); return new Response("ok", { status: 200 }); });
    const seq = await run(() => saveSequence(a.session, sequenceSchema.parse({ name: "מסע בדיקה", trigger: "CONTACT_CREATED", stopOn: [], steps: [
      { action: "add_tag", channel: "email", waitMinutes: 0, actionTag: "חם" },
      { action: "condition", channel: "email", waitMinutes: 0, condition: { requireNoReply: false, tagName: "חם" } },
      { action: "add_to_list", channel: "email", waitMinutes: 0, listId },
      { action: "wait", channel: "email", waitMinutes: 5 },
      { action: "webhook", channel: "email", waitMinutes: 0, webhookUrl: "https://hooks.example.com/journey" },
      { action: "task", channel: "email", waitMinutes: 0, taskTitle: "לחזור ללקוח" },
      { action: "remove_tag", channel: "email", waitMinutes: 0, actionTag: "חם" },
      { action: "condition", channel: "email", waitMinutes: 0, condition: { requireNoReply: false, tagName: "חם" } },
      { action: "remove_from_list", channel: "email", waitMinutes: 0, listId },
    ] })));
    const r0 = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId, sourceKey: "qa-journey", nextAt: new Date(0) } });
    const r = await drain(r0.id);
    expect(r.status).toBe("STOPPED");
    expect(r.stopReason).toMatch(/תנאי לא התקיים/);
    expect(await db.distributionListMember.count({ where: { listId, contactId } })).toBe(1); // step after the failed gate did not run
    expect(await db.contactTag.count({ where: { contactId, tag: { name: "חם" } } })).toBe(0); // added then removed
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "journey.step", contact: { id: contactId } });
    expect(await db.task.count({ where: { businessId: a.business.id, contactId, title: { contains: "לחזור ללקוח" } } })).toBe(1);
  });
});

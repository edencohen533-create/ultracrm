/**
 * The RLS wrapper (src/lib/db-rls.ts) runs a tenant read in its own BEGIN … COMMIT and doesn't make the caller wait for
 * the COMMIT. The next statement on the same connection must wait for it – pg must never be handed a query while
 * another one is executing ("Calling client.query() when the client is already executing a query" – deprecated in
 * pg 8, removed in pg 9). Real database connection.
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { patchClient, rlsEnabled } from "@/lib/db-rls";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

describe("RLS wrapper: back-to-back tenant reads on one connection", () => {
  it("no concurrent query on the client; results correct; nothing left open", async () => {
    if (!rlsEnabled()) return;
    const biz = await createBusiness("rls-commit");
    const warnings: string[] = [];
    const onWarn = (w: Error) => { if (/already executing a query/.test(w.message)) warnings.push(w.message); };
    process.on("warning", onWarn);
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.delete("schema");
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect(); patchClient(client);
    try {
      const out = await withBusiness(biz.business.id, async () => {
        const rs: number[] = [];
        for (let i = 0; i < 5; i++) rs.push(Number((await client.query("SELECT $1::int AS n", [i])).rows[0].n)); // each read: BEGIN; SET; SELECT; COMMIT(not awaited)
        const tx = (await client.query("SELECT current_setting('app.business_id', true) AS b")).rows[0].b;
        // Right after a read (its COMMIT still in flight) two statements arrive together – like a transaction start.
        // Before the fix they piled up behind the COMMIT in pg's internal queue.
        await client.query("SELECT 1");
        const [, pair] = await Promise.all([client.query("SELECT 2 AS a"), client.query("SELECT 3 AS b")]);
        rs.push(Number(pair.rows[0].b));
        return { rs, tx };
      }, biz.session);
      await new Promise((r) => setTimeout(r, 50)); // let process warnings flush
      expect(out.rs).toEqual([0, 1, 2, 3, 4, 3]);
      expect(out.tx).toBe(biz.business.id); // the tenant setting applies to the statement
      expect(warnings).toEqual([]);
      // Nothing left in a transaction / under the runtime role outside a business context
      const after = await client.query("SELECT current_user AS u, current_setting('app.business_id', true) AS b");
      expect(after.rows[0].b ?? "").toBe("");
    } finally {
      process.off("warning", onWarn);
      await client.end(); await destroyBusiness(biz.business.id, [biz.account.id]);
    }
  });
});

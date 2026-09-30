import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { openConfig } from "@/server/channels/registry";
import { connectorFor } from "@/server/crm-sync/registry";
import { parseSettings } from "@/server/crm-sync/settings";
import { applyChange } from "@/server/crm-sync/ingest";
import { connForIngest } from "@/server/crm-sync/connections";

export const dynamic = "force-dynamic";

/**
 * Inbound webhook of an external CRM connection. Verified with the connector's own signature scheme (with a replay
 * window) BEFORE anything is read; each event is deduped by its id. A disconnected / erroring connection answers 503
 * so the sender retries later (the gap is filled after reconnecting) – nothing is applied meanwhile.
 */
export async function POST(req: Request, { params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  const raw = await req.text();
  if (raw.length > 1_000_000) return Response.json({ error: "too large" }, { status: 413 });
  const conn = await db.crmConnection.findUnique({ where: { id: connectionId } });
  const def = conn ? connectorFor(conn.connectorKey) : null;
  if (!conn || !def?.verifyWebhook || !def.parseWebhook) return Response.json({ error: "not found" }, { status: 404 });
  const ctx = { connectionId: conn.id, businessId: conn.businessId, auth: openConfig(conn.authConfig) as Record<string, string>, settings: parseSettings(conn.settings) };
  if (!def.verifyWebhook(ctx, req.headers, raw)) return Response.json({ error: "invalid signature" }, { status: 401 });
  if (conn.status !== "active") return Response.json({ error: "connection not active" }, { status: 503 });
  let body: unknown; try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
  const changes = def.parseWebhook(ctx, body);
  const results = await withBusiness(conn.businessId, async () => { const out = []; for (const ch of changes) out.push((await applyChange(connForIngest(conn), ch, { kind: "webhook" })).status); return out; });
  return Response.json({ received: changes.length, results });
}

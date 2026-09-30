import { upsertRecord } from "@/server/crm-sync/public-api";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ externalId: string }> };
/** Create / update a contact by the external system's id (scope contacts:write). */
export async function PUT(req: Request, { params }: P) { return upsertRecord(req, "contact", decodeURIComponent((await params).externalId)); }
/** Deleted in the external system: future work stops here; calls / messages / history are kept. */
export async function DELETE(req: Request, { params }: P) { return upsertRecord(req, "contact", decodeURIComponent((await params).externalId), true); }

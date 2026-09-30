import { upsertRecord } from "@/server/crm-sync/public-api";

export const dynamic = "force-dynamic";
type P = { params: Promise<{ externalId: string }> };
/** Create / update an opportunity (lead) by external id – assignment, status, follow-up (scope leads:write). */
export async function PUT(req: Request, { params }: P) { return upsertRecord(req, "lead", decodeURIComponent((await params).externalId)); }
export async function DELETE(req: Request, { params }: P) { return upsertRecord(req, "lead", decodeURIComponent((await params).externalId), true); }

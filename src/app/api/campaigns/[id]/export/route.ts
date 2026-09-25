import { csvCell } from "@/lib/csv-export";
import { organizationRequest } from "@/lib/auth-compat";
import { campaignActor } from "@/lib/campaign-auth";
import { prisma } from "@/lib/db";
import { deliveryStatusLabels, recipientStatusLabels } from "@/lib/campaigns";

/** CSV export of a campaign's recipients with delivery outcome, timestamps and errors (managers). */
export const GET = organizationRequest(async function(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!await campaignActor()) return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const { id } = await params;
  const campaign = await prisma.campaign.findUnique({ where: { id }, select: { name: true } });
  if (!campaign) return Response.json({ error: "הקמפיין לא נמצא" }, { status: 404 });
  const rows = await prisma.campaignRecipient.findMany({ where: { campaignId: id }, orderBy: { id: "asc" }, take: 20000, include: { contact: { select: { fullName: true, phoneE164: true, email: true } }, message: { select: { status: true, errorReason: true, errorCode: true, acceptedAt: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true, openedAt: true, clickedAt: true } } } });
  const esc = csvCell; // quotes + spreadsheet-formula guard (names/error text are attacker-controlled)
  const header = ["contact", "identifier", "recipient_status", "delivery_status", "attempts", "accepted_at", "sent_at", "delivered_at", "read_at", "failed_at", "opened_at", "clicked_at", "error_code", "error"].join(",");
  const lines = rows.map((r) => [r.contact.fullName, r.identifier ?? r.contact.phoneE164, recipientStatusLabels[r.status] ?? r.status, r.message ? (deliveryStatusLabels[r.message.status] ?? r.message.status) : "", r.attempts, r.message?.acceptedAt?.toISOString() ?? "", r.message?.sentAt?.toISOString() ?? "", r.message?.deliveredAt?.toISOString() ?? "", r.message?.readAt?.toISOString() ?? "", r.message?.failedAt?.toISOString() ?? "", r.message?.openedAt?.toISOString() ?? "", r.message?.clickedAt?.toISOString() ?? "", r.message?.errorCode ?? "", r.message?.errorReason ?? r.error ?? ""].map(esc).join(","));
  const csv = "﻿" + [header, ...lines].join("\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="campaign-${id}.csv"` } });
});

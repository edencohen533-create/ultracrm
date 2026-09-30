import { withAuth } from "@/lib/api";
import { exportBusiness } from "@/server/offboarding/export";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** ZIP of the business's data (owner only, audited). Recordings / files: authenticated links in the manifest. */
export const GET = withAuth(async ({ user }) => {
  const r = await exportBusiness(user);
  return new Response(r.zip as unknown as BodyInit, { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`, "Cache-Control": "private, no-store" } });
});

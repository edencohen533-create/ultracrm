import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { salesDiagnostics } from "@/server/sales/diagnostics";
export const GET = withAuth(
  async ({ user }) => ok(await salesDiagnostics(user)),
  { minRole: "manager", module: "telephony" },
);

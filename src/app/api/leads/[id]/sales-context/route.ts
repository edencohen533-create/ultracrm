import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { leadFor } from "@/server/sales/quotes";
import { leadAdvertisement } from "@/server/sales/meta-ads";
import { qualificationAnswers } from "@/server/ai/qualification";
export const GET = withAuth(
  async ({ user, params }) => {
    const lead = await leadFor(user, params.id);
    const [advertisement, qualification] = await Promise.all([
      leadAdvertisement(user, lead.id),
      qualificationAnswers(lead.contactId),
    ]);
    return ok({ advertisement, qualification });
  },
  { perm: "crm.view" },
);

import { redirect } from "next/navigation";

/** Campaigns are split per channel now; the old combined page opens the WhatsApp one. */
export default function CampaignsPage() {
  redirect("/campaigns/whatsapp");
}

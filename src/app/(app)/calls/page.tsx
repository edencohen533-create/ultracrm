import { redirect } from "next/navigation";

/** "שיחות" is WhatsApp only now; call history lives in the lead card and the managers' reports. */
export default function CallsPage() {
  redirect("/inbox");
}

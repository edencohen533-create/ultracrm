import { redirect } from "next/navigation";

/** The deals list was removed; deals are created and managed from the lead / contact card (and /deals/[id] stays). */
export default function DealsPage() {
  redirect("/leads");
}

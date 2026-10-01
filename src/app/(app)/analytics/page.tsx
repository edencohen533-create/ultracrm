import { redirect } from "next/navigation";

/**
 * The old "אנליטיקה" tab was merged into דוחות ← ביצועי נציגים (WhatsApp view); its per-number delivery table moved to
 * שיווק ומכירות ← ביצועי דיוור. Old links land on the WhatsApp view of the merged report.
 */
export default function AnalyticsPage() {
  redirect("/reports?channel=whatsapp");
}

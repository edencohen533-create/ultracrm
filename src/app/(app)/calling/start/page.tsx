import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { DialerScreen } from "@/components/dialer/DialerScreen";

/** "חייגן ← הפעלת חייגן" (the area's main tab): pick a campaign and start the dialer; "הביצועים שלי" on the side. */
export default function CallingStartPage() { return <Suspense fallback={<div className="p-10"><Spinner /></div>}><DialerScreen inHub /></Suspense>; }

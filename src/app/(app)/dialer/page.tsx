import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { DialerScreen } from "@/components/dialer/DialerScreen";

/** The dialer as a full, separate screen ("הפעל חייגן" from the leads page lands here). */
export default function DialerPage() { return <Suspense fallback={<div className="p-10"><Spinner /></div>}><DialerScreen /></Suspense>; }

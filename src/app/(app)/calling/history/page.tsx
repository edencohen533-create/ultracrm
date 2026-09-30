import { Suspense } from "react";
import { Spinner } from "@/components/ui";
import { CallHistory } from "@/components/calling/CallHistory";

export default function CallHistoryPage() { return <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><CallHistory /></Suspense>; }

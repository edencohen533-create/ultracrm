"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Headphones, Mic, Phone, X } from "lucide-react";
import { toast } from "sonner";
import { useDialer } from "@/components/telephony/DialerProvider";
import { MonitorPanel } from "@/components/manager/MonitorPanel";
import { formatDuration, formatPhone } from "@/lib/client/format";
export interface LiveAgent { id: string; fullName: string; status: string; sinceAt: string; call: { id: string; status: string; toE164: string; createdAt: string; answeredAt: string | null; canMonitor: boolean; campaign: string | null; contact: { id: string; fullName: string } | null } | null }
export const LIVE_LABEL: Record<string,string> = { available:"זמין",dialing:"מחייג",ringing:"מצלצל",in_call:"בשיחה",wrap_up:"בתיעוד",break:"בהפסקה",idle:"מחובר",offline:"לא פעיל",unknown:"לא ידוע",on_hold:"בהמתנה" };
export function AgentCallDrawer({ agent, stale, onClose }: { agent: LiveAgent; stale: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { supervisor, phone } = useDialer();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [joinedCall, setJoinedCall] = useState<string | null>(null);
  const stop = useRef(supervisor.stop);
  useEffect(() => { stop.current = supervisor.stop; }, [supervisor.stop]);
  const joined = useRef(false);
  useEffect(() => { dialog.current?.showModal(); const before = document.body.style.overflow; document.body.style.overflow = "hidden"; const t = setInterval(() => setNow(Date.now()),1000); return () => { clearInterval(t); document.body.style.overflow = before; if(joined.current) void stop.current().catch(() => undefined); }; }, []);
  async function close() { if(busy) return; setBusy(true); try { if(joined.current) await supervisor.stop(); joined.current=false;onClose(); } catch(e){toast.error((e as Error).message);} finally{setBusy(false);} }
  async function listen() { if(!agent.call?.canMonitor || stale) return;setBusy(true);try{await supervisor.start(agent.call.id);joined.current=true;setJoinedCall(agent.call.id);}catch(e){toast.error((e as Error).message);}finally{setBusy(false);} }
  const call = agent.call;
  return <dialog ref={dialog} className="lead-details-dialog agent-call-dialog" aria-label="נתוני שיחה" onCancel={e=>{e.preventDefault();void close();}} onClick={e=>{if(e.target===e.currentTarget)void close();}}><div className="lead-details-panel"><header><h2>נתוני שיחה</h2><button aria-label="סגור נתוני שיחה" disabled={busy} onClick={close}><X size={23}/></button></header><div className="agent-call-body">
    {stale && <p role="alert" className="lead-error">החיבור נותק — הנתונים אינם עדכניים</p>}
    <section className="agent-live-card"><header><strong>{agent.fullName}</strong><div><button title={call?.canMonitor ? "האזנה לשיחה" : "האזנה זמינה בשיחה פעילה של נציג אחר"} aria-label="האזנה לשיחה" disabled={!call?.canMonitor || stale || busy || Boolean(joinedCall)} onClick={listen}><Headphones size={21}/></button><button title="התחבר להאזנה כדי ללחוש לנציג בלחיצה ממושכת" aria-label="פתח אפשרות לחישה" disabled={!call?.canMonitor || stale || busy || Boolean(joinedCall)} onClick={listen}><Mic size={19}/></button></div></header><dl><div><dt>שם לקוח/ה</dt><dd>{call?.contact ? <Link href={`/contacts/${call.contact.id}`}>{call.contact.fullName}</Link> : "—"}</dd></div><div><dt>טלפון</dt><dd dir="ltr">{call ? formatPhone(call.toE164) : "—"}</dd></div><div><dt>קמפיין</dt><dd>{call?.campaign ?? "—"}</dd></div></dl></section>
    <section className="agent-call-workspace">{joinedCall && supervisor.monitor ? <MonitorPanel embedded agentName={agent.fullName} contactName={call?.contact?.fullName ?? call?.toE164 ?? "לקוח"} callAnsweredAt={call?.answeredAt ?? supervisor.monitor.call?.answeredAt ?? null} callEnded={!call || call.id!==joinedCall} onClose={()=>{joined.current=false;setJoinedCall(null);}}/> : <div className="agent-call-idle"><Phone size={30}/><strong>{stale ? "המצב אינו עדכני" : LIVE_LABEL[agent.status] ?? "לא ידוע"}</strong>{call ? <><span>משך {call.answeredAt ? "השיחה" : "החיוג"}</span><b dir="ltr">{formatDuration(Math.max(0,Math.floor((now-new Date(call.answeredAt??call.createdAt).getTime())/1000)))}</b><p>{call.canMonitor ? "לחץ על האוזניות כדי להצטרף להאזנה בלבד" : "האזנה זמינה לאחר מענה, בשיחה של נציג אחר"}</p></> : <p>אין שיחה פעילה כרגע. פרטי השיחה יופיעו כאן בזמן אמת.</p>}{phone.status==="simulation"&&<small>מצב הדמיה — אין אודיו אמיתי</small>}</div>}</section>
  </div></div></dialog>;
}

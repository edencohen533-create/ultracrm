"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Headphones, Mic, Phone, X } from "lucide-react";
import { toast } from "sonner";
import { useDialer } from "@/components/telephony/DialerProvider";
import { MonitorPanel } from "@/components/manager/MonitorPanel";
import { formatDuration, formatPhone } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";
export interface LiveAgent { id: string; fullName: string; status: string; sinceAt: string; call: { id: string; status: string; toE164: string; createdAt: string; answeredAt: string | null; canMonitor: boolean; campaign: string | null; contact: { id: string; fullName: string } | null } | null }
export const LIVE_LABEL: Record<string,string> = { available:"זמין",dialing:"מחייג",ringing:"מצלצל",in_call:"בשיחה",wrap_up:"בתיעוד",break:"בהפסקה",idle:"מחובר",offline:"לא פעיל",unknown:"לא ידוע",on_hold:"בהמתנה" };
export const LIVE_LABEL_EN: Record<string,string> = { available:"Available",dialing:"Dialing",ringing:"Ringing",in_call:"On a call",wrap_up:"Wrap-up",break:"On break",idle:"Online",offline:"Offline",unknown:"Unknown",on_hold:"On hold" };
export function AgentCallDrawer({ agent, stale, onClose }: { agent: LiveAgent; stale: boolean; onClose: () => void }) {
  const t = useT();
  const dialog = useRef<HTMLDialogElement>(null);
  const { supervisor, phone } = useDialer();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [joinedCall, setJoinedCall] = useState<string | null>(null);
  const stop = useRef(supervisor.stop);
  useEffect(() => { stop.current = supervisor.stop; }, [supervisor.stop]);
  const joined = useRef(false);
  useEffect(() => { dialog.current?.showModal(); const before = document.body.style.overflow; document.body.style.overflow = "hidden"; const iv = setInterval(() => setNow(Date.now()),1000); return () => { clearInterval(iv); document.body.style.overflow = before; if(joined.current) void stop.current().catch(() => undefined); }; }, []);
  async function close() { if(busy) return; setBusy(true); try { if(joined.current) await supervisor.stop(); joined.current=false;onClose(); } catch(e){toast.error((e as Error).message);} finally{setBusy(false);} }
  async function listen() { if(!agent.call?.canMonitor || stale) return;setBusy(true);try{await supervisor.start(agent.call.id);joined.current=true;setJoinedCall(agent.call.id);}catch(e){toast.error((e as Error).message);}finally{setBusy(false);} }
  const call = agent.call;
  return <dialog ref={dialog} className="lead-details-dialog agent-call-dialog" aria-label={t("נתוני שיחה", "Call details")} onCancel={e=>{e.preventDefault();void close();}} onClick={e=>{if(e.target===e.currentTarget)void close();}}><div className="lead-details-panel"><header><h2>{t("נתוני שיחה", "Call details")}</h2><button aria-label={t("סגור נתוני שיחה", "Close call details")} disabled={busy} onClick={close}><X size={23}/></button></header><div className="agent-call-body">
    {stale && <p role="alert" className="lead-error">{t("החיבור נותק — הנתונים אינם עדכניים", "Connection lost — data is not up to date")}</p>}
    <section className="agent-live-card"><header><strong>{agent.fullName}</strong><div><button title={call?.canMonitor ? t("האזנה לשיחה", "Listen to call") : t("האזנה זמינה בשיחה פעילה של נציג אחר", "Listening is available on another agent's active call")} aria-label={t("האזנה לשיחה", "Listen to call")} disabled={!call?.canMonitor || stale || busy || Boolean(joinedCall)} onClick={listen}><Headphones size={21}/></button><button title={t("התחבר להאזנה כדי ללחוש לנציג בלחיצה ממושכת", "Join listening to whisper to the agent with a long press")} aria-label={t("פתח אפשרות לחישה", "Open whisper option")} disabled={!call?.canMonitor || stale || busy || Boolean(joinedCall)} onClick={listen}><Mic size={19}/></button></div></header><dl><div><dt>{t("שם לקוח/ה", "Customer name")}</dt><dd>{call?.contact ? <Link href={`/contacts/${call.contact.id}`}>{call.contact.fullName}</Link> : "—"}</dd></div><div><dt>{t("טלפון", "Phone")}</dt><dd dir="ltr">{call ? formatPhone(call.toE164) : "—"}</dd></div><div><dt>{t("קמפיין", "Campaign")}</dt><dd>{call?.campaign ?? "—"}</dd></div></dl></section>
    <section className="agent-call-workspace">{joinedCall && supervisor.monitor ? <MonitorPanel embedded agentName={agent.fullName} contactName={call?.contact?.fullName ?? call?.toE164 ?? t("לקוח", "Customer")} callAnsweredAt={call?.answeredAt ?? supervisor.monitor.call?.answeredAt ?? null} callEnded={!call || call.id!==joinedCall} onClose={()=>{joined.current=false;setJoinedCall(null);}}/> : <div className="agent-call-idle"><Phone size={30}/><strong>{stale ? t("המצב אינו עדכני", "Status not up to date") : LIVE_LABEL[agent.status] ? t(LIVE_LABEL[agent.status], LIVE_LABEL_EN[agent.status] ?? LIVE_LABEL[agent.status]) : t("לא ידוע", "Unknown")}</strong>{call ? <><span>{call.answeredAt ? t("משך השיחה", "Call duration") : t("משך החיוג", "Dialing duration")}</span><b dir="ltr">{formatDuration(Math.max(0,Math.floor((now-new Date(call.answeredAt??call.createdAt).getTime())/1000)))}</b><p>{call.canMonitor ? t("לחץ על האוזניות כדי להצטרף להאזנה בלבד", "Click the headphones to join in listen-only mode") : t("האזנה זמינה לאחר מענה, בשיחה של נציג אחר", "Listening is available after answer, on another agent's call")}</p></> : <p>{t("אין שיחה פעילה כרגע. פרטי השיחה יופיעו כאן בזמן אמת.", "No active call right now. Call details will appear here in real time.")}</p>}{phone.status==="simulation"&&<small>{t("מצב הדמיה — אין אודיו אמיתי", "Simulation mode — no real audio")}</small>}</div>}</section>
  </div></div></dialog>;
}

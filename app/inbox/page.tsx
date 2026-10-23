"use client";

import { useCallback, useEffect, useState } from "react";
import { pilotImport, pilotInbox, pilotTaskAction, type InboxCase } from "@/lib/pilot-client";

type Channel = "new-business" | "policy-change";
const available = process.env.NEXT_PUBLIC_BROKERDESK_MODE !== "broker";
export default function PilotInbox() {
  const [newBusiness,setNewBusiness] = useState<InboxCase[]>([]);
  const [changes,setChanges] = useState<InboxCase[]>([]);
  const [channel,setChannel] = useState<Channel>("new-business");
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const refresh=useCallback(async()=>{
    const [a,b]=await Promise.all([pilotInbox("new-business"),pilotInbox("policy-change")]);
    setNewBusiness(a);setChanges(b);
  },[]);
  useEffect(()=>{if(available)void refresh().catch(e=>setMessage(e instanceof Error?e.message:"Inbox unavailable."));},[refresh]);
  async function importFile(file:File|undefined) {
    if(!file)return;
    setBusy(true);setMessage("");
    try {const result=await pilotImport(file);
      setMessage(result.duplicate?`Already imported; existing Case ${result.case_id}. No duplicate was created.`:
        `Imported ${result.package_id}. Routed into ${result.system}.`);
      await refresh();setChannel(result.system as Channel);
    }catch(e){setMessage(e instanceof Error?e.message:"Package import failed.");}
    finally{setBusy(false);}
  }
  async function takeAction(id:string,action:"claim"|"release"|"complete") {
    setBusy(true);setMessage("");
    try {await pilotTaskAction(id,action);await refresh();setMessage(`Task ${action} completed.`);}
    catch(e){setMessage(e instanceof Error?e.message:"Task action failed.");}
    finally{setBusy(false);}
  }
  function openCase(id:string){window.localStorage.setItem("brokerdesk.lastCaseId",id);window.location.assign("/");}
  const rows=channel==="new-business"?newBusiness:changes;
  if(!available)return <main className="pilot-inbox"><p>Auditor Inbox is unavailable in Broker mode.</p><a href="/">Back to BrokerDesk</a></main>;
  return <main className="pilot-inbox">
    <header className="pilot-inbox-head">
      <div><p className="eyebrow">BrokerDesk · Local Auditor Pilot</p><h1>Authoritative submission inbox</h1>
        <p>Single Auditor active · second Auditor disabled · loopback only (LAN server rollout later).</p></div>
      <a href="/">Return to Case review</a>
    </header>
    <section className="pilot-import">
      <h2>Import broker attachment</h2>
      <p>Select the original <code>.bdzip</code> downloaded from email. The local Auditor engine checks every SHA-256, Broker ID, and intake blocker.</p>
      <label>Choose BDZIP package
        <input aria-label="Import BDZIP package" type="file" accept=".bdzip,.zip"
          disabled={busy} onChange={e=>{const file=e.currentTarget.files?.[0];void importFile(file);e.currentTarget.value="";}}/>
      </label>
      <small>Allowed trial IDs: PILOT-BROKER-1 / PILOT-BROKER-2. Broker identity is self-reported during this pilot, not digitally signed.</small>
      {message&&<p role="status" className="pilot-inbox-result">{message}</p>}
    </section>
    <nav className="pilot-channels" aria-label="Submission channels">
      <button aria-current={channel==="new-business"?"page":undefined} onClick={()=>setChannel("new-business")}>
        Remarket / New Business ({newBusiness.filter(item=>item.status!=="completed").length})
      </button>
      <button aria-current={channel==="policy-change"?"page":undefined} onClick={()=>setChannel("policy-change")}>
        Policy Change ({changes.filter(item=>item.status!=="completed").length})
      </button>
      <button type="button" disabled={busy} onClick={()=>void refresh().catch(e=>setMessage(String(e)))}>Refresh</button>
    </nav>
    <section aria-live="polite" className="pilot-tasks">
      <h2>{channel==="new-business"?"New Business":"Policy Change"} queue</h2>
      {!rows.length&&<p>No packages in this channel.</p>}
      {rows.map(task=><article className="pilot-task" key={task.package_id}>
        <div><strong>{task.label || task.insured_name || task.source_case_id}</strong>
          <p>{task.carrier} · {task.broker_name} ({task.broker_id}) · Revision {task.revision}</p>
          <p>Submitted {task.submitted_at?.slice(0,16)} · Effective {task.effective_date || "not specified"}</p>
          {task.warnings?.length>0&&<div className="pilot-warning-list" aria-label={"Intake warnings for "+task.package_id}>
            <strong>Warnings ({task.warnings.length}) · package accepted for review</strong>
            {task.warnings.map((warning,index)=><p key={warning.code+"-"+index}><span>⚠</span> {warning.message}</p>)}
          </div>}
          <small>Case {task.case_id} · Package {task.package_id}</small>
        </div>
        <div><p><strong>{task.status}</strong>{task.assignee?` · ${task.assignee}`:""}</p>
          <div className="pilot-task-actions">
            {task.status==="pending"&&<button disabled={busy} onClick={()=>void takeAction(task.package_id,"claim")}>Take Case</button>}
            {task.status==="in_progress"&&<>
              <button onClick={()=>openCase(task.case_id)}>Open Case</button>
              <button disabled={busy} onClick={()=>void takeAction(task.package_id,"release")}>Release</button>
              <button disabled={busy} onClick={()=>{if(window.confirm("Mark completed only after you manually submitted to the insurer or finalized the intended action."))void takeAction(task.package_id,"complete");}}>Mark completed</button>
            </>}
            {task.status==="completed"&&<button onClick={()=>openCase(task.case_id)}>Review completed Case</button>}
          </div>
        </div>
      </article>)}
    </section>
    <footer>All source documents and package records are stored on this Auditor computer. Nothing is submitted automatically to an insurer.</footer>
  </main>;
}

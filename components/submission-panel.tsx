"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InsuranceCase } from "@/lib/insurance-types";
import type { UploadedDocumentRecord } from "@/lib/extraction-types";
import type { IntakeResult } from "@/lib/intake-profile";
import { primaryTransactionType } from "@/lib/intake-profile";
import { isPolicyChange } from "@/lib/policy-change";
import { pilotAuthorize, pilotDownload, pilotPreflight } from "@/lib/pilot-client";

type Props = {
  data: InsuranceCase;
  records: UploadedDocumentRecord[];
  saveState: string;
  onCaseSaved: (item: InsuranceCase) => void;
  onNavigate: (field: string) => void;
};
export function SubmissionPanel({data,records,saveState,onCaseSaved,onNavigate}:Props) {
  const [brokerId,setBrokerId] = useState("PILOT-BROKER-1");
  const [brokerName,setBrokerName] = useState("Pilot Broker 1");
  const [preflight,setPreflight] = useState<IntakeResult|null>(null);
  const [message,setMessage] = useState("");
  const [busy,setBusy] = useState(false);
  const [evidenceChoice,setEvidenceChoice] = useState("");
  useEffect(() => {setPreflight(null);setMessage("");},[data,records]);
  const change = isPolicyChange(data);
  const transaction = primaryTransactionType(data);
  const options=useMemo(() => {
    const accepted = transaction === "CANCELLATION" ? ["CANCELLATION_REQUEST"] :
      transaction === "NAME_CHANGE" ? ["POLICY_CHANGE","OPCF_FORM"] :
      transaction === "PAYMENT_CHANGE" ? ["PAYMENT_AUTHORIZATION","POLICY_CHANGE"] :
      ["POLICY_CHANGE","OPCF_FORM"];
    return records.filter(r => !r.staleExtraction && r.sourceHash &&
      (!r.currentSourceHash || r.currentSourceHash === r.sourceHash)).flatMap(r =>
      (r.logicalDocuments === undefined ?
        [{id:undefined,documentType:r.documentType,presenceStatus:"FOUND" as const,
          startPage:undefined as number|undefined,endPage:undefined as number|undefined}] :
        r.logicalDocuments).filter(section=>section.presenceStatus==="FOUND" && accepted.includes(section.documentType))
        .filter(section => !(r.withdrawnSectionRanges??[]).some(w =>
          (section.startPage??1)<=w.endPage && (section.endPage??section.startPage??1)>=w.startPage))
        .map(s=>({id:`${r.id}::${s.id??""}`,
          documentId:r.id,logicalId:s.id,
          label:`${r.fileName} — ${s.documentType}${s.startPage?` p.${s.startPage}–${s.endPage??s.startPage}`:""}`}))
    );
  },[records,transaction]);
  async function runPreflight() {
    if(saveState!=="saved"){setMessage("Wait until the current Case is saved, then run Preflight.");return;}
    setBusy(true);setMessage("");
    try { const result=await pilotPreflight(data.case_id);setPreflight(result); }
    catch(e){setMessage(e instanceof Error?e.message:"Preflight unavailable.");}
    finally{setBusy(false);}
  }
  async function exportPackage() {
    if (!preflight?.passed || !brokerId.trim() || !brokerName.trim()) return;
    if (saveState !== "saved") {setMessage("Wait for Case autosave before generating a package.");return;}
    setBusy(true);
    try {const name=await pilotDownload(data.case_id,{id:brokerId.trim(),name:brokerName.trim()});
      setMessage(`${name} generated. Manually attach the .bdzip file to your email. Nothing was sent automatically.`);
    } catch(e){setMessage(e instanceof Error?e.message:"Could not generate submission package.");setPreflight(null);}
    finally{setBusy(false);}
  }
  async function confirmAuthorization(verified:boolean) {
    const selected=options.find(o=>o.id===evidenceChoice)??options[0];
    if(verified&&!selected){setMessage("Upload and classify an authorized, signed change form first.");return;}
    if(verified&&!window.confirm("Have you opened the source and visually verified the client's authorization for this exact policy change?"))
      return;
    setBusy(true);
    try { const next=await pilotAuthorize(data.case_id,{verified,documentId:selected?.documentId,logicalDocumentId:selected?.logicalId});
      onCaseSaved(next);setMessage(verified?"Change authorization recorded with the original evidence hash.":"Change authorization revoked.");
    } catch(e){setMessage(e instanceof Error?e.message:"Could not verify change authorization.");}
    finally{setBusy(false);}
  }
  return <section className="pilot-submission-panel" aria-label="Broker submission preflight">
    <div className="pilot-section-header">
      <strong>Broker submission · Pilot</strong>
      <small>Intake profile v1 · Manual email attachment</small>
    </div>
    {change && <div className="pilot-auth-control">
      <p><strong>Policy Change authorization</strong> (separate from a New Business Signed Application)</p>
      {data.transaction_authorization?.verified ?
        <><p>Verified: {data.transaction_authorization.authorization_type} · {data.transaction_authorization.verified_by}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={()=>void confirmAuthorization(false)}>Revoke verification</Button></> :
        <><label>Signed change document
          <select aria-label="Signed policy change authorization" value={evidenceChoice||options[0]?.id||""}
            onChange={e=>setEvidenceChoice(e.target.value)}>
            {options.length===0&&<option value="">No eligible authorization found</option>}
            {options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
          </select></label>
          {options.length>0&&<a target="_blank" rel="noreferrer" href={
            (process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL??"http://127.0.0.1:47831")+
              "/documents/"+encodeURIComponent((options.find(o=>o.id===evidenceChoice)??options[0]).documentId)+"/file"
          }>Open source before confirming</a>}
          <Button variant="outline" size="sm" disabled={busy||!options.length} onClick={()=>void confirmAuthorization(true)}>Verify authorization</Button></>}
    </div>}
    <div className="pilot-preflight-control">
      <Button size="sm" variant="outline" disabled={busy||saveState!=="saved"}
        onClick={()=>void runPreflight()}>Run intake preflight</Button>
      {preflight&&<p role="status"><strong>{preflight.passed?"Passed":"Blocked"}</strong> · {preflight.blockers.length} blocker(s) · {preflight.system}</p>}
      {preflight?.blockers.map((b,i)=><div key={i} className="pilot-preflight-issue">
        <strong>{b.code}</strong> {b.message}
        {b.field&&<button type="button" onClick={()=>onNavigate(b.field!)}>Go to field / document</button>}
      </div>)}
    </div>
    <div className="pilot-identity-control">
      <label>Broker ID <input aria-label="Pilot broker ID" value={brokerId} onChange={e=>setBrokerId(e.target.value)} /></label>
      <label>Broker name <input aria-label="Pilot broker name" value={brokerName} onChange={e=>setBrokerName(e.target.value)} /></label>
      <small>Initial trial IDs: PILOT-BROKER-1 or PILOT-BROKER-2. Formal broker licenses/list approval is deferred.</small>
    </div>
    <Button disabled={busy||!preflight?.passed||saveState!=="saved"||!brokerId.trim()||!brokerName.trim()}
      onClick={()=>void exportPackage()}>Generate Submission Package (.bdzip)</Button>
    {message&&<p role="status" className="pilot-result">{message}</p>}
    <small>ZIP is stored only as a browser download. Email and insurer submission are always manual.</small>
  </section>;
}

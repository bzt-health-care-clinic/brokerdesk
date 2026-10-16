"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { IntakeSupportPanel } from "@/components/intake-support-panel";
import type { InsuranceCase } from "@/lib/insurance-types";
import type { UploadedDocumentRecord } from "@/lib/extraction-types";
import type { IntakeResult } from "@/lib/intake-profile";
import { primaryTransactionType } from "@/lib/intake-profile";
import { isPolicyChange } from "@/lib/policy-change";
import { pilotAuthorize, pilotCompareInsuredNames, pilotDownload, pilotPreflight } from "@/lib/pilot-client";
import { appendSuggestedPolicyholder, parsedPolicyholderSuggestions } from "@/lib/intake-name-suggestions";

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
  const [applicationChoice,setApplicationChoice] = useState("");
  const [quoteChoice,setQuoteChoice] = useState("");
  const [applicationNames,setApplicationNames] = useState("");
  const [quoteNames,setQuoteNames] = useState("");
  const [signerEvidence,setSignerEvidence] = useState<Record<string,string>>({});
  const [signaturePages,setSignaturePages] = useState<Record<string,string>>({});
  const [signerConfirmed,setSignerConfirmed] = useState<Record<string,boolean>>({});
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
  const newBusinessOptions=useMemo(()=>{
    const accepted=data.case_type==="new_auto"?["AUTO_APPLICATION","AUTO_QUOTE"]:["HAB_APPLICATION","HAB_QUOTE"];
    return records.filter(r=>r.sourceHash&&!r.staleExtraction&&
      (!r.currentSourceHash||r.currentSourceHash===r.sourceHash)).flatMap(r=>
      (r.logicalDocuments===undefined?[{id:undefined,documentType:r.documentType,presenceStatus:"FOUND" as const,startPage:1,endPage:r.pageCount}]:r.logicalDocuments)
        .filter(sec=>sec.presenceStatus==="FOUND"&&accepted.includes(sec.documentType)&&!(r.withdrawnSectionRanges??[]).some(w=>(sec.startPage??1)<=w.endPage&&(sec.endPage??sec.startPage??1)>=w.startPage))
        .map(sec=>({id:r.id+"::"+(sec.id??""),documentId:r.id,logicalId:sec.id,type:sec.documentType,
          label:r.fileName+" — "+sec.documentType+" p."+(sec.startPage??1)+"–"+(sec.endPage??sec.startPage??1)})));
  },[data.case_type,records]);
  const applicationDocs=newBusinessOptions.filter(o=>o.type.endsWith("_APPLICATION"));
  const quoteDocs=newBusinessOptions.filter(o=>o.type.endsWith("_QUOTE"));
  const chosenApplication=applicationDocs.find(o=>o.id===applicationChoice) ??
    applicationDocs.find(o=>o.documentId===data.signed_document_id &&
      o.logicalId===data.signed_logical_document_id);
  const chosenQuote=quoteDocs.find(o=>o.id===quoteChoice)??quoteDocs[0];
  const applicationSuggestions=useMemo(()=>
    parsedPolicyholderSuggestions(records,chosenApplication?.documentId,
      chosenApplication?.logicalId,chosenApplication?.type),
    [records,chosenApplication?.documentId,chosenApplication?.logicalId,chosenApplication?.type]);
  const quoteSuggestions=useMemo(()=>
    parsedPolicyholderSuggestions(records,chosenQuote?.documentId,
      chosenQuote?.logicalId,chosenQuote?.type),
    [records,chosenQuote?.documentId,chosenQuote?.logicalId,chosenQuote?.type]);
  const policyholders=[data.insured.name,...(data.insured.co_insured??[]).map(person=>person.name)].filter(Boolean);
  const mustConfirmSigners=change&&(policyholders.length>1||transaction==="CANCELLATION");
  const parseNames=(text:string)=>text.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  async function confirmNames(verified:boolean){
    const application=chosenApplication;
    const quote=chosenQuote;
    if(verified&&(!application||!quote||!applicationNames.trim()||!quoteNames.trim())){setMessage("Select the signed Application and Quote and enter each document's named insureds, one per line.");return;}
    if(verified&&!window.confirm("Have you visually checked ALL named insured names in both active documents, including joint applicants?"))return;
    setBusy(true);
    try{
      const next=await pilotCompareInsuredNames(data.case_id,{verified,applicationDocumentId:application?.documentId,
        applicationLogicalDocumentId:application?.logicalId,quoteDocumentId:quote?.documentId,
        quoteLogicalDocumentId:quote?.logicalId,applicationNames:parseNames(applicationNames),quoteNames:parseNames(quoteNames)});
      onCaseSaved(next);setMessage(verified?"Document-linked insured names recorded. Run preflight to check matches.":"Insured-name comparison revoked.");
    }catch(e){setMessage(e instanceof Error?e.message:"Could not confirm document names.");}
    finally{setBusy(false);}
  }
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
    const signers=verified&&mustConfirmSigners?policyholders.map(name=>{
      const selectedSigner=options.find(o=>o.id===signerEvidence[name])??selected;
      return {name,documentId:selectedSigner?.documentId??"",logicalDocumentId:selectedSigner?.logicalId,
        signaturePage:Number(signaturePages[name]),verified:signerConfirmed[name]===true};
    }):undefined;
    if(verified&&mustConfirmSigners&&(!signers?.length||signers.some(s=>!s.verified||!Number.isInteger(s.signaturePage)||s.signaturePage<1))){
      setMessage("Confirm each policyholder's actual signature and enter the exact document page for each signer.");return;
    }
    setBusy(true);
    try { const next=await pilotAuthorize(data.case_id,{verified,documentId:selected?.documentId,logicalDocumentId:selected?.logicalId,signers});
      onCaseSaved(next);setMessage(verified?"Change authorization recorded with the original evidence hash.":"Change authorization revoked.");
    } catch(e){setMessage(e instanceof Error?e.message:"Could not verify change authorization.");}
    finally{setBusy(false);}
  }
  return <section className="pilot-submission-panel" aria-label="Broker submission preflight">
    <div className="pilot-section-header">
      <strong>Broker submission · Pilot</strong>
      <small>Intake profile v1 · Manual email attachment</small>
    </div>
    {!change && <div className="pilot-auth-control">
      <p><strong>Signed Application vs Quote — named policyholders</strong></p>
      {data.named_insured_comparison ?
        <><p>Compared at {data.named_insured_comparison.confirmed_at}. Application: {data.named_insured_comparison.application_names.join(", ")}. Quote: {data.named_insured_comparison.quote_names.join(", ")}.</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={()=>void confirmNames(false)}>Revoke name comparison</Button></> :
        <><p>Open both original documents and enter each named policyholder on a separate line. Do not infer names from the Case summary.</p>
          <label>Signed Application
            <select aria-label="Document for signed insured-name comparison" value={applicationChoice||applicationDocs.find(o=>o.documentId===data.signed_document_id&&o.logicalId===data.signed_logical_document_id)?.id||""} onChange={e=>setApplicationChoice(e.target.value)}>
              <option value="">Choose signed application</option>{applicationDocs.map(o=><option value={o.id} key={o.id}>{o.label}</option>)}
            </select></label>
          <label>Quote
            <select aria-label="Quote for insured-name comparison" value={quoteChoice||quoteDocs[0]?.id||""} onChange={e=>setQuoteChoice(e.target.value)}>
              <option value="">Choose quote</option>{quoteDocs.map(o=><option value={o.id} key={o.id}>{o.label}</option>)}
            </select></label>
          <label>Names on signed Application — one per line<textarea aria-label="Named insureds on signed application" value={applicationNames} onChange={e=>setApplicationNames(e.target.value)}/></label>
          <div className="pilot-name-suggestions" aria-label="Application document extracted policyholders">
            <small>Application 文件解析出的被保人姓名（OCR 可能识别错误，需核对原件）：</small>
            {!applicationSuggestions.length&&<small>未解析出姓名，可直接手工填写。</small>}
            {applicationSuggestions.map((suggestion,index)=><div className="pilot-name-suggestion" key={suggestion.name+"-"+index}>
              <span>{suggestion.role}: {suggestion.name}</span>
              <Button type="button" size="sm" variant="outline"
                aria-label={"填入 Application "+suggestion.name}
                onClick={()=>setApplicationNames(previous=>appendSuggestedPolicyholder(previous,suggestion.name))}>填入</Button>
            </div>)}
          </div>
          <label>Names on Quote — one per line<textarea aria-label="Named insureds on quote" value={quoteNames} onChange={e=>setQuoteNames(e.target.value)}/></label>
          <div className="pilot-name-suggestions" aria-label="Quote document extracted policyholders">
            <small>Quote 文件解析出的被保人姓名（OCR 可能识别错误，需核对原件）：</small>
            {!quoteSuggestions.length&&<small>未解析出姓名，可直接手工填写。</small>}
            {quoteSuggestions.map((suggestion,index)=><div className="pilot-name-suggestion" key={suggestion.name+"-"+index}>
              <span>{suggestion.role}: {suggestion.name}</span>
              <Button type="button" size="sm" variant="outline"
                aria-label={"填入 Quote "+suggestion.name}
                onClick={()=>setQuoteNames(previous=>appendSuggestedPolicyholder(previous,suggestion.name))}>填入</Button>
            </div>)}
          </div>
          <Button variant="outline" size="sm" disabled={busy||!data.signed||!applicationDocs.length||!quoteDocs.length}
            onClick={()=>void confirmNames(true)}>Record manual name comparison</Button></>}
    </div>}
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
          {mustConfirmSigners&&<div className="pilot-signer-evidence">
            <p>Each distinct policyholder must sign. Open the original source and manually verify the actual signature on the indicated page.</p>
            {policyholders.map(name=><div key={name}>
              <strong>{name}</strong>
              <label>Signed document section
                <select aria-label={"Signature evidence for "+name} value={signerEvidence[name]||evidenceChoice||options[0]?.id||""}
                  onChange={e=>setSignerEvidence(previous=>({...previous,[name]:e.target.value}))}>
                  {options.map(o=><option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
              </label>
              <label>Signature page <input aria-label={"Signature page for "+name} type="number" min="1"
                value={signaturePages[name]??""} onChange={e=>setSignaturePages(previous=>({...previous,[name]:e.target.value}))}/></label>
              <label><input type="checkbox" checked={signerConfirmed[name]===true}
                onChange={e=>setSignerConfirmed(previous=>({...previous,[name]:e.target.checked}))}/>
                I visually verified {name}'s distinct signature on that page.</label>
            </div>)}
          </div>}
          <Button variant="outline" size="sm" disabled={busy||!options.length} onClick={()=>void confirmAuthorization(true)}>Verify authorization</Button></>}
    </div>}
    <IntakeSupportPanel data={data} records={records} onCaseSaved={onCaseSaved}/>
    <div className="pilot-preflight-control">
      <Button size="sm" variant="outline" disabled={busy||saveState!=="saved"}
        onClick={()=>void runPreflight()}>Run intake preflight</Button>
      {preflight&&<p role="status"><strong>{preflight.passed?"Passed":"Blocked"}</strong> · {preflight.blockers.length} blocker(s) · {preflight.system}</p>}
      {(preflight?.warnings?.length ?? 0)>0&&<p className="pilot-warning-head">Warnings ({preflight?.warnings?.length ?? 0}) · submission is allowed if blockers are zero.</p>}
      {preflight?.warnings?.map((warning,i)=><div key={warning.code+"-"+i} className="pilot-preflight-warning" role="status"><strong>{warning.code}</strong> {warning.message}</div>)}
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

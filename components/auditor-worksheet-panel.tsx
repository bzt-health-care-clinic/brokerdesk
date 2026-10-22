"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InsuranceCase } from "@/lib/insurance-types";
import type { UploadedDocumentRecord } from "@/lib/extraction-types";
import { buildAuditorWorksheet, auditorWorksheetText, type WorksheetStatus } from "@/lib/auditor-worksheet";
import { localRepositories } from "@/lib/local-repositories";
import { fetchAuditorReviewedKeyin, type ReviewedKeyinResponse } from "@/lib/auditor-reviewed-client";
import { AuditorReviewedKeyinPanel } from "@/components/auditor-reviewed-keyin-panel"; // STEP3_AUDITOR_SHEET

const STYLES:Record<WorksheetStatus,string>={
  "extracted":"extracted","confirmed":"confirmed","missing":"missing",
  "conflict":"conflict","case-only":"case-only",
};
const STATUS:Record<WorksheetStatus,string>={
  "extracted":"Source extracted · verify","confirmed":"Manually resolved",
  "missing":"NOT FOUND / CONFIRM","conflict":"SOURCE CONFLICT",
  "case-only":"Case entry · no source",
};
export function AuditorWorksheetPanel({data,records}:{data:InsuranceCase;records:UploadedDocumentRecord[]}){
  const sheet=useMemo(()=>buildAuditorWorksheet(data,records),[data,records]);
  const [filter,setFilter]=useState<"all"|"attention">("all");
  const [search,setSearch]=useState("");
  const [copied,setCopied]=useState(false);
  const hasContent=sheet.sections.some(section=>section.rows.some(row=>row.status!=="missing"));
  type ReviewState = {caseId:string;kind:"loading"|"legacy"} |
    {caseId:string;kind:"ready";data:ReviewedKeyinResponse} |
    {caseId:string;kind:"error";message:string};
  const [reviewedState,setReviewedState]=useState<ReviewState>({caseId:data.case_id,kind:"loading"});
  useEffect(()=>{
    let active=true;
    if(process.env.NEXT_PUBLIC_BROKERDESK_MODE==="broker"){
      setReviewedState({caseId:data.case_id,kind:"legacy"});
      return ()=>{active=false;};
    }
    setReviewedState({caseId:data.case_id,kind:"loading"});
    void fetchAuditorReviewedKeyin(data.case_id).then(result=>{
      if(active)setReviewedState(result?{caseId:data.case_id,kind:"ready",data:result}:
        {caseId:data.case_id,kind:"legacy"});
    }).catch(error=>{
      if(active)setReviewedState({caseId:data.case_id,kind:"error",
        message:error instanceof Error?error.message:"Imported worksheet unavailable."});
    });
    return ()=>{active=false;};
  },[data.case_id]);
  if(reviewedState.caseId!==data.case_id||reviewedState.kind==="loading")
    return <p role="status">Loading imported Auditor worksheet...</p>;
  if(reviewedState.kind==="ready")
    return <AuditorReviewedKeyinPanel review={reviewedState.data}/>;
  if(reviewedState.kind==="error")
    return <p role="alert">Unable to verify imported Broker worksheet: {reviewedState.message}</p>;

  async function copy(){
    try{await navigator.clipboard.writeText(auditorWorksheetText(sheet));setCopied(true);}
    catch{setCopied(false);}
  }
  return <div className="auditor-worksheet" aria-label="Auditor key-in worksheet">
    <header className="auditor-worksheet-head">
      <div>
        <p className="eyebrow">Auditor only · Source-to-field worksheet</p>
        <h2>{sheet.kind==="new-auto"?"New Auto":sheet.kind==="new-home"?"New Home":
          sheet.kind==="auto-change"?"Auto Policy Change":"Home Policy Change"} — Key-in data</h2>
        <p>Values are organized from imported Case data and active parsed source sections.
          This is not an insurer portal, and no value is assumed verified merely because OCR found it.</p>
      </div>
      <Button variant="outline" size="sm" onClick={()=>void copy()}>{copied?"Copied":"Copy key-in worksheet"}</Button>
    </header>
    <div className="auditor-worksheet-stats" aria-label="Worksheet extraction status">
      <span><strong>{sheet.documentCount}</strong> Source files</span>
      <span><strong>{sheet.extracted}</strong> Sourced values</span>
      <span><strong>{sheet.conflicts}</strong> Source conflicts</span>
      <span><strong>{sheet.missing}</strong> Required fields to confirm</span>
    </div>
    <p className="auditor-worksheet-disclaimer">
      The absence of a claim, conviction or coverage row is not proof that no history or coverage exists.
      Open the original PDF wherever a value is disputed or marked NOT FOUND.
    </p>
    {sheet.unparsedDocuments.length>0&&<aside className="auditor-worksheet-unparsed">
      <strong>Unparsed / unassigned source files ({sheet.unparsedDocuments.length})</strong>
      <p>These documents are in the package, but no active structured extraction was available.
        Use the Documents panel to review accepted sections, OCR or reparse locally.</p>
      <ul>{sheet.unparsedDocuments.map((name,i)=><li key={name+"-"+i}>{name}</li>)}</ul>
    </aside>}
    <div className="auditor-worksheet-tools">
      <label>Find key-in field <input type="search" aria-label="Search key-in worksheet"
        value={search} onChange={e=>setSearch(e.target.value)}
        placeholder="VIN, prior insurer, MVR, garage, transaction…"/></label>
      <div className="auditor-worksheet-filter" aria-label="Worksheet row filter">
        <Button size="sm" variant={filter==="all"?"default":"outline"} onClick={()=>setFilter("all")}>All data</Button>
        <Button size="sm" variant={filter==="attention"?"default":"outline"}
          onClick={()=>setFilter("attention")}>Missing / conflicts / unverified</Button>
      </div>
    </div>
    {!hasContent&&<p className="auditor-worksheet-unparsed">No structured data yet. Confirm document types/sections and
      run local text extraction or configured OCR in the Documents panel.</p>}
    {sheet.sections.map(section=>{
      const matching=section.rows.filter(row=>
        (filter==="all"||row.status==="missing"||row.status==="conflict"||row.status==="case-only")&&
        (!search||[row.label,row.value,...row.evidence.map(e=>e.fileName)].join(" ")
          .toLowerCase().includes(search.toLowerCase())));
      if(!matching.length)return null;
      return <section className="auditor-worksheet-section" key={section.id}
        aria-label={section.title}>
        <h3>{section.title} <small>{matching.length} fields</small></h3>
        <div className="auditor-worksheet-rows">
          {matching.map(row=><article key={row.id} className={"auditor-worksheet-row status-"+STYLES[row.status]}>
            <div className="auditor-worksheet-main">
              <strong>{row.label}{row.required?" *":""}</strong>
              <span className="auditor-worksheet-value">{row.value}</span>
              <span className={"auditor-worksheet-state "+STYLES[row.status]}>{STATUS[row.status]}</span>
            </div>
            {row.note&&<p className="auditor-worksheet-note">{row.note}</p>}
            {row.evidence.length>0&&<details className="auditor-worksheet-evidence">
              <summary>Sources ({row.evidence.length}) · show original extracted values</summary>
              {row.evidence.map((proof,i)=><div className="auditor-evidence-source"
                key={proof.documentId+"-"+proof.field+"-"+i}>
                <strong>{proof.fileName} · {proof.documentType}</strong>
                <p>{proof.field}: {proof.sourceValue}</p>
                <small>{proof.page?"Page "+proof.page+" · ":""}{proof.logicalDocumentId?
                  "Section "+proof.logicalDocumentId+" · ":""}
                  {proof.confidence==null?"Confidence unknown":
                    "Confidence "+Math.round(proof.confidence*100)+"%"}</small>
                <a href={localRepositories.documents.openUrl(proof.documentId)+
                  (proof.page?"#page="+proof.page:"")}
                  target="_blank" rel="noreferrer">Open original file</a>
              </div>)}
            </details>}
          </article>)}
        </div>
      </section>;
    })}
  </div>;
}

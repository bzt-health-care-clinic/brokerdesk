"use client";
import { useState } from "react";
import type { ReviewedKeyinResponse, ReviewedSheetSection } from "@/lib/auditor-reviewed-client";

const sectionText=(section:ReviewedSheetSection)=>
  [section.title,...section.rows.map(row=>`${row.label}: ${row.value}`)].join("\n");

export function AuditorReviewedKeyinPanel({review}:{review:ReviewedKeyinResponse}){
  const [copied,setCopied]=useState("");
  const sheet=review.sheet;
  async function copy(name:string,text:string){
    try{await navigator.clipboard.writeText(text);setCopied(name);}
    catch{setCopied("Clipboard unavailable");}
  }
  return <div className="auditor-worksheet" aria-label="Broker-confirmed Auditor key-in worksheet">
    <header className="auditor-worksheet-head">
      <div>
        <p className="eyebrow">Auditor · Imported Broker review</p>
        <h2>Key-in data — Broker confirmed</h2>
        <p>Broker {review.brokerId} confirmed the submitted worksheet.
          Copy the final values to the insurer portal. No second field-by-field confirmation is required.</p>
        <small>Confirmed {review.finalizedAt?.slice(0,16)} · Package {review.packageId}</small>
      </div>
      <button type="button" onClick={()=>void copy("all",
        sheet.sections.map(sectionText).join("\n\n"))}>
        {copied==="all"?"Copied":"Copy all Key-in data"}
      </button>
    </header>
    <div className="auditor-worksheet-stats">
      <span><strong>{sheet.sections.length}</strong> Broker-confirmed sections</span>
      <span><strong>{sheet.sections.reduce((n,s)=>n+s.rows.length,0)}</strong> Key-in fields</span>
    </div>
    {sheet.sections.map(section=><section className="auditor-worksheet-section" key={section.id}
      aria-label={section.title}>
      <header className="auditor-worksheet-head">
        <h3>{section.title}</h3>
        <button type="button" onClick={()=>void copy(section.id,sectionText(section))}>
          {copied===section.id?"Copied":"Copy section"}
        </button>
      </header>
      <div className="auditor-worksheet-rows">
        {section.rows.map(row=><article key={row.id} className="auditor-worksheet-row status-confirmed">
          <div className="auditor-worksheet-main">
            <strong>{row.label}</strong>
            <span className="auditor-worksheet-value">{row.value}</span>
            <small>{row.evidencePresent?"Source evidence: Yes":"Source evidence: No (Broker entered/confirmed)"}</small>
          </div>
          <button type="button" aria-label={`Copy ${row.label}`}
            onClick={()=>void copy(row.id,row.value)}>
            {copied===row.id?"Copied":"Copy"}
          </button>
        </article>)}
      </div>
    </section>)}
    <p className="auditor-worksheet-disclaimer">
      This sheet is the exact Broker-confirmed submission snapshot, not a digital
      signature or an independent assessment of the original document's accuracy.
    </p>
  </div>;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { InsuranceCase } from "@/lib/insurance-types";
import type { UploadedDocumentRecord } from "@/lib/extraction-types";
import {
  DISCOUNT_TYPES, availableSubjectKeys, allowedSupportDocumentTypes, expectedDiscountSubjectType,
  proofKey, selectedOpcfCodes, vehicleKey,
  type DiscountKind, type IntakeSupportProof, type SelectedDiscount, type SupportPurpose,
} from "@/lib/intake-support-evidence";
import { pilotDiscountReview, pilotSelectOpcf43Vehicle, pilotSupportProof, pilotWarningFacts } from "@/lib/pilot-client";

type Props={data:InsuranceCase;records:UploadedDocumentRecord[];onCaseSaved:(next:InsuranceCase)=>void};
type ProofChoice={id:string;documentId:string;logicalDocumentId:string;type:string;label:string};
const proofOptions=(records:UploadedDocumentRecord[],types:readonly string[]):ProofChoice[]=>
  records.filter(r=>r.sourceHash&&!r.staleExtraction&&r.currentSourceHash!=="MISSING"&&
    (!r.currentSourceHash||r.currentSourceHash===r.sourceHash)).flatMap(r=>
    (r.logicalDocuments??[]).filter(s=>s.presenceStatus==="FOUND"&&
      types.includes(s.documentType)&&!(r.withdrawnSectionRanges??[]).some(w=>
        (s.startPage??1)<=w.endPage&&(s.endPage??s.startPage??1)>=w.startPage))
    .map(s=>({id:r.id+"::"+s.id,documentId:r.id,logicalDocumentId:s.id,type:s.documentType,
      label:r.fileName+" — "+s.documentType+" p."+(s.startPage??1)+"–"+(s.endPage??s.startPage??1)})));

function ProofEditor({data,records,purpose,code,subjectKey,label,onCaseSaved}:Props&{
  purpose:SupportPurpose;code:string;subjectKey:string;label:string;
}){
  const [choice,setChoice]=useState("");
  const [page,setPage]=useState("");
  const [signer,setSigner]=useState("");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const choices=useMemo(()=>proofOptions(records,allowedSupportDocumentTypes(purpose,code)),[records,purpose,code]);
  const existing=(data.intake_support_evidence??[]).find(p=>proofKey(p)===proofKey({
    purpose,code,subject_key:subjectKey
  }));
  const selected=choices.find(x=>x.id===choice)??choices[0];
  async function save(action:"verify"|"revoke"){
    if(!subjectKey){setMessage("Select an active vehicle or driver.");return;}
    if(action==="verify"&&!selected){setMessage("Upload and classify a valid supporting document first.");return;}
    if(action==="verify"&&purpose==="SIGNED_OPCF"&&(!signer||!Number.isInteger(Number(page))||!page.trim())){
      setMessage("Select the policyholder who signed and enter the exact signed page.");return;
    }
    if(action==="verify"&&!window.confirm("I opened this source and manually verified that it supports "+label+
      (purpose==="SIGNED_OPCF"?" and contains the named policyholder's actual signature on the recorded page.":".")))return;
    setBusy(true);setMessage("");
    try{
      const next=await pilotSupportProof(data.case_id,{
        action,purpose,code,subjectKey,
        documentId:selected?.documentId,logicalDocumentId:selected?.logicalDocumentId,
        ...(purpose==="SIGNED_OPCF"?{signaturePage:Number(page),signerName:signer}:{}),
        ...(action==="verify"?{confirmed:true}:{})
      });
      onCaseSaved(next);setMessage(action==="verify"?"Evidence linked with SHA-256.":"Evidence confirmation revoked.");
    }catch(e){setMessage(e instanceof Error?e.message:"Evidence verification failed.")}
    finally{setBusy(false);}
  }
  return <div className="pilot-proof-row">
    <p><strong>{label}</strong> · {subjectKey||"select a vehicle"}</p>
    {existing?<div>
      <small>Verified {existing.document_type}, source {existing.document_id}, {existing.verified_at.slice(0,16)}
        {existing.signature_page?" · signed p."+existing.signature_page:""}</small>
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void save("revoke")}>Revoke proof</Button>
    </div>:<div className="pilot-proof-fields">
      <label>Supporting document section
        <select aria-label={"Evidence for "+label+" "+subjectKey} value={choice||selected?.id||""}
          onChange={e=>setChoice(e.target.value)}>
          {!choices.length&&<option value="">No matching active evidence</option>}
          {choices.map(x=><option value={x.id} key={x.id}>{x.label}</option>)}
        </select></label>
      {selected&&<a target="_blank" rel="noreferrer"
        href={(process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL??"http://127.0.0.1:47831")+
          "/documents/"+encodeURIComponent(selected.documentId)+"/file"}>Open selected source</a>}
      {purpose==="SIGNED_OPCF"&&<>
        <label>Actual signer
          <select aria-label={"Signed OPCF "+code+" policyholder"} value={signer} onChange={e=>setSigner(e.target.value)}>
            <option value="">Choose signed policyholder</option>
            {[data.insured.name,...(data.insured.co_insured??[]).map(x=>x.name)].filter(Boolean).map(name=>
              <option key={name} value={name}>{name}</option>)}
          </select></label>
        <label>Signed page in selected section
          <input type="number" min="1" aria-label={"Signed OPCF "+code+" page"} value={page}
            onChange={e=>setPage(e.target.value)}/></label>
      </>}
      <Button size="sm" variant="outline" disabled={busy||!choices.length||!subjectKey}
        onClick={()=>void save("verify")}>Verify and link evidence</Button>
    </div>}
    {message&&<small role="status">{message}</small>}
  </div>;
}

export function IntakeSupportPanel({data,records,onCaseSaved}:Props){
  const [endorsementVehicle,setEndorsementVehicle]=useState<Record<string,string>>({});
  const [discountChoices,setDiscountChoices]=useState<Record<string,boolean>>({});
  const [quoteIssued,setQuoteIssued]=useState("");
  const [quoteBound,setQuoteBound]=useState("unknown");
  const [plannedBind,setPlannedBind]=useState("");
  const [damage,setDamage]=useState<Record<string,string>>({});
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const vehicles=useMemo(()=>availableSubjectKeys(data,"VEHICLE"),[data]);
  const drivers=useMemo(()=>availableSubjectKeys(data,"DRIVER"),[data]);
  const isAuto=data.case_type==="new_auto"||data.case_type==="auto_policy_change";
  const selected=useMemo(()=>selectedOpcfCodes(data),[data]);
  useEffect(()=>{
    const selectedDiscounts=data.intake_discount_review?.selections??[];
    setDiscountChoices(Object.fromEntries(selectedDiscounts.map(s=>[s.kind+"|"+s.subject_key,true])));
  },[data.case_id,data.intake_discount_review]);
  useEffect(()=>{
    const facts=data.intake_warning_facts;
    setQuoteIssued(facts?.quote_issued_date??"");
    setQuoteBound(facts?.quote_bound===true?"bound":facts?.quote_bound===false?"not-bound":"unknown");
    setPlannedBind(facts?.planned_bind_date??"");
    setDamage(Object.fromEntries((facts?.vehicle_physical_damage??[]).map(x=>[x.vehicle_key,x.selected?"yes":"no"])));
  },[data.case_id,data.intake_warning_facts]);
  const allDiscountRows=DISCOUNT_TYPES.flatMap(kind=>
    (expectedDiscountSubjectType(kind)==="VEHICLE"?vehicles:drivers)
      .map(subject_key=>({kind,subject_key,key:kind+"|"+subject_key})));
  const reviewedDiscounts=data.intake_discount_review?.selections??[];
  async function selectOpcf43Vehicle(key:string){
    setBusy(true);setMessage("");
    try{
      const next=await pilotSelectOpcf43Vehicle(data.case_id,key,Boolean(key));
      onCaseSaved(next);
      setMessage(key?"OPCF 43 target vehicle recorded; now link its own Bill of Sale or Lease Agreement.":
        "OPCF 43 target vehicle selection cleared.");
    }catch(error){setMessage(error instanceof Error?error.message:"Cannot assign OPCF 43 vehicle.");}
    finally{setBusy(false);}
  }
  async function saveDiscounts(){
    setBusy(true);setMessage("");
    try{
      const choices:SelectedDiscount[]=allDiscountRows.filter(row=>discountChoices[row.key])
        .map(row=>({kind:row.kind,subject_key:row.subject_key}));
      const next=await pilotDiscountReview(data.case_id,choices);
      onCaseSaved(next);setMessage("Recorded selected discounts; each selected discount needs its matching proof.");
    }catch(e){setMessage(e instanceof Error?e.message:"Could not record discounts.");}
    finally{setBusy(false);}
  }
  async function saveRiskFacts(){
    setBusy(true);setMessage("");
    try{
      const next=await pilotWarningFacts(data.case_id,{
        ...(quoteIssued?{quote_issued_date:quoteIssued}:{}),
        ...(plannedBind?{planned_bind_date:plannedBind}:{}),
        ...(quoteBound==="unknown"?{}:{quote_bound:quoteBound==="bound"}),
        vehicle_physical_damage:vehicles.filter(key=>damage[key]==="yes"||damage[key]==="no")
          .map(vehicle_key=>({vehicle_key,selected:damage[vehicle_key]==="yes"}))
      });
      onCaseSaved(next);setMessage("Quote and vehicle-coverage facts recorded. WARN checks do not block submission.");
    }catch(e){setMessage(e instanceof Error?e.message:"Could not record quote/coverage facts.");}
    finally{setBusy(false);}
  }
  const supportedOld=(data.intake_warning_facts?.vehicle_physical_damage??[])
    .filter(x=>x.selected&&data.vehicles.some(v=>vehicleKey(v)===x.vehicle_key));
  return <div className="pilot-intake-support" aria-label="Selected endorsements discounts and warning evidence">
    <div className="pilot-auth-control">
      <p><strong>Selected OPCF evidence — v1.0 rules 9 and 10</strong></p>
      <small>Requirements are triggered only by structured, selected Policy endorsements or Policy Change endorsement actions, never a PDF text mention.</small>
      {!selected.length&&<small>No selected OPCF 43 / 28A / 49 / 19 / 13C in structured fields.</small>}
      {selected.map((entry,index)=>{
        const is43=entry.code==="43";
        const mustSaveVehicle=is43 && !entry.subject_key && vehicles.length>1;
        const subject=entry.subject_key ??
          (vehicles.length===1?vehicles[0]:
            mustSaveVehicle?data.intake_opcf43_vehicle_target?.vehicle_key??"":
              endorsementVehicle[entry.code]??"");
        return <div key={entry.code+"-"+(entry.subject_key??"")+"-"+index}>
          {mustSaveVehicle&&<label>
            OPCF 43 — 必须确认实际投保的车辆（不能任意关联另一辆车的证明）
            <select aria-label="Save selected OPCF 43 insured vehicle" disabled={busy}
              value={data.intake_opcf43_vehicle_target?.vehicle_key??""}
              onChange={event=>void selectOpcf43Vehicle(event.target.value)}>
              <option value="">请选择并保存 OPCF 43 所属车辆</option>
              {vehicles.map(vehicle=><option value={vehicle} key={vehicle}>{vehicle}</option>)}
            </select>
          </label>}
          {!is43&&isAuto&&vehicles.length>1&&!entry.subject_key&&<label>
            Vehicle receiving OPCF {entry.code}
            <select aria-label={"Vehicle for selected OPCF "+entry.code}
              value={endorsementVehicle[entry.code]??""}
              onChange={e=>setEndorsementVehicle(p=>({...p,[entry.code]:e.target.value}))}>
              <option value="">Choose the actual endorsed vehicle</option>
              {vehicles.map(v=><option value={v} key={v}>{v}</option>)}
            </select>
          </label>}
          <ProofEditor data={data} records={records} onCaseSaved={onCaseSaved}
            purpose={is43?"OPCF43":"SIGNED_OPCF"} code={entry.code} subjectKey={subject}
            label={is43?"OPCF 43 Bill of Sale / Lease Agreement":"OPCF "+entry.code+" signed endorsement"}/>
        </div>;
      })}
    </div>
    {isAuto&&<div className="pilot-auth-control">
      <p><strong>Discounts actually selected on quote/policy — rule 12</strong></p>
      <small>Only check discounts that are applied. Vehicle tires, driver training and retiree status alone do not prove that an insurer applied a discount.</small>
      {allDiscountRows.map(row=><label className="pilot-check-label" key={row.key}>
        <input type="checkbox" checked={discountChoices[row.key]===true}
          onChange={e=>setDiscountChoices(p=>({...p,[row.key]:e.target.checked}))}/>
        {row.kind.replaceAll("_"," ")} — {row.subject_key}
      </label>)}
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void saveDiscounts()}>
        Record selected discounts (including none)
      </Button>
      {data.intake_discount_review&&<small>Reviewed {data.intake_discount_review.reviewed_at.slice(0,16)} · {reviewedDiscounts.length} selected. Re-save selections if the quote changes.</small>}
      {reviewedDiscounts.map((claim,i)=><ProofEditor key={claim.kind+claim.subject_key+i}
        data={data} records={records} onCaseSaved={onCaseSaved}
        purpose="DISCOUNT" code={claim.kind} subjectKey={claim.subject_key}
        label={claim.kind.replaceAll("_"," ")+" discount proof"}/>)}
    </div>}
    <div className="pilot-auth-control">
      <p><strong>Warning facts — non-blocking yellow checks</strong></p>
      <small>Use reliable Quote issuance and binding facts only. Leaving a field unknown never invents an age or coverage.</small>
      <label>Quote issued on <input type="date" aria-label="Quote issuance date" value={quoteIssued}
        onChange={e=>setQuoteIssued(e.target.value)}/></label>
      <label>Has this Quote been bound?
        <select aria-label="Quote binding status" value={quoteBound} onChange={e=>setQuoteBound(e.target.value)}>
          <option value="unknown">Unknown / not recorded</option>
          <option value="not-bound">Not bound</option><option value="bound">Bound</option>
        </select></label>
      <label>Planned binding date (optional) <input type="date" aria-label="Planned quote binding date"
        value={plannedBind} onChange={e=>setPlannedBind(e.target.value)}/></label>
      {isAuto&&data.vehicles.map((car,index)=>{
        const key=vehicleKey(car);if(!key)return null;
        return <label key={key}>Vehicle {index+1} · {car.year} {car.make} {car.model} ({key}) Physical Damage selected?
          <select aria-label={"Physical Damage selected for "+key} value={damage[key]??"unknown"}
            onChange={e=>setDamage(p=>({...p,[key]:e.target.value}))}>
            <option value="unknown">Unknown</option>
            <option value="yes">Yes</option><option value="no">No</option>
          </select></label>;
      })}
      <Button size="sm" variant="outline" disabled={busy} onClick={()=>void saveRiskFacts()}>
        Save warning facts
      </Button>
      {supportedOld.map((entry,i)=><ProofEditor key={entry.vehicle_key+i}
        data={data} records={records} onCaseSaved={onCaseSaved}
        purpose="OLD_VEHICLE" code="PHYSICAL_DAMAGE" subjectKey={entry.vehicle_key}
        label={"Vehicle photos / Safety inspection (old vehicle)"}/>)}
    </div>
    {message&&<p role="status" className="pilot-result">{message}</p>}
  </div>;
}

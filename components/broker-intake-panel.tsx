"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { InsuranceCase, Vehicle, Driver, PolicyChangeTransactionType } from "@/lib/insurance-types";
import type { UploadedDocumentRecord } from "@/lib/extraction-types";
import { activeParsedSources } from "@/lib/active-evidence";
import { applyDocumentPresence } from "@/lib/document-package";
import { POLICY_CHANGE_TRANSACTIONS } from "@/lib/policy-change";
import { hasOwnershipSectionForVehicle, confirmVehicleOwnership } from "@/lib/broker-file-intake";

type Props={data:InsuranceCase;records:UploadedDocumentRecord[];onChange:(next:InsuranceCase)=>void};
const isAuto=(item:InsuranceCase)=>item.case_type==="new_auto"||item.case_type==="auto_policy_change";
const isChange=(item:InsuranceCase)=>item.case_type==="auto_policy_change"||item.case_type==="home_policy_change";
function emptyVehicle():Vehicle{
  return {id:crypto.randomUUID(),year:0,make:"",model:"",vin:"",
    owned:true,leased:false,primary_use:"",annual_km:0,commute_km:0,
    business_use_percent:0,winter_tires:false,parking:"",garaging_address:"",
    ownership:{received:false,registered_owner:"",address:"",year:null,make:"",
      model:"",vin:"",leased:null,lessor:null,lienholder:null}};
}
function emptyDriver():Driver{
  return {id:crypto.randomUUID(),name:"",relationship:"",principal:false,
    percentage_use:0,licence_number:"",licence_class:"",g1_date:"",g2_date:"",
    g_date:"",mvr_received:"",driver_training:false,retired:false,
    convictions:[],demerit_points:null,telematics:{enabled:false,app:"",
      phone:"",email:"",discount_percent:0}};
}
export function BrokerIntakePanel({data,records,onChange}:Props){
  const auto=isAuto(data),change=isChange(data),presence=applyDocumentPresence(data,records);
  const updatePolicy=(key:keyof InsuranceCase["policy"],value:string)=>
    onChange({...data,policy:{...data.policy,[key]:value}});
  const patchChange=(changes:Partial<NonNullable<InsuranceCase["policy_change"]>>)=>
    onChange({...data,policy_change:{...data.policy_change!,
      ...changes}});
  const evidenceVehicles=useMemo(()=>records.flatMap(record=>activeParsedSources(record)
    .filter(source=>source.documentType==="OWNERSHIP"&&
      typeof source.data.vin==="string"&&/^[A-HJ-NPR-Z0-9]{17}$/i.test(source.data.vin))
    .map(source=>({vin:String(source.data.vin).toUpperCase(),year:Number(source.data.year)||0,
      make:String(source.data.make??""),model:String(source.data.model??""),
      owner:String(source.data.registeredOwner??""),
      address:String(source.data.ownerAddress??""),
      leased:/^(yes|true)$/i.test(String(source.data.leased??""))?true:
        /^(no|false)$/i.test(String(source.data.leased??""))?false:null,
      lessor:String(source.data.lessor??""),fileName:record.fileName}))),
    [records]);
  const missing=presence.documents.filter(d=>d.required&&!d.received);
  const supplemental=presence.documents.filter(d=>!d.required&&d.received);
  function changeVehicle(id:string,field:"year"|"make"|"model"|"vin"|"owner"|"ownerAddress"|"leaseStatus"|"lessor",value:string){
    onChange({...data,vehicles:data.vehicles.map(vehicle=>{
      if(vehicle.id!==id)return vehicle;
      const current=vehicle.ownership??{received:false,registered_owner:"",address:"",
        year:null,make:"",model:"",vin:"",leased:null,lessor:null,lienholder:null};
      const pending={...current,received:false}; // New identity facts require fresh file verification.
      if(field==="owner")return {...vehicle,ownership:{...pending,registered_owner:value}};
      if(field==="ownerAddress")return {...vehicle,ownership:{...pending,address:value}};
      if(field==="leaseStatus")return {...vehicle,leased:value==="yes",
        ownership:{...pending,leased:value==="unknown"?null:value==="yes"}};
      if(field==="lessor")return {...vehicle,ownership:{
        ...pending,lessor:value?{name:value,address:current.lessor?.address??""}:null}};
      if(field==="vin")return {...vehicle,vin:value.toUpperCase(),
        ownership:{...pending,vin:value.toUpperCase()}};
      if(field==="year")return {...vehicle,year:Number(value)||0,
        ownership:{...pending,year:Number(value)||null}};
      if(field==="make")return {...vehicle,make:value,
        ownership:{...pending,make:value}};
      if(field==="model")return {...vehicle,model:value,
        ownership:{...pending,model:value}};
      return vehicle;
    })});
  }
  function appendOwnership(candidate:(typeof evidenceVehicles)[number]){
    if(data.vehicles.some(vehicle=>vehicle.vin.toUpperCase()===candidate.vin))return;
    if(!window.confirm("Confirm this VIN against the actual Ownership document before adding the vehicle: "+
      candidate.vin+" ("+candidate.fileName+")"))return;
    const vehicle=emptyVehicle();
    vehicle.year=candidate.year;vehicle.make=candidate.make;vehicle.model=candidate.model;
    vehicle.vin=candidate.vin;vehicle.ownership!.received=true;
    vehicle.ownership!.registered_owner=candidate.owner;
    vehicle.ownership!.address=candidate.address;
    vehicle.ownership!.leased=candidate.leased;
    if(candidate.lessor)vehicle.ownership!.lessor={name:candidate.lessor,address:""};
    vehicle.ownership!.vin=candidate.vin;vehicle.ownership!.year=candidate.year||null;
    vehicle.ownership!.make=candidate.make;vehicle.ownership!.model=candidate.model;
    onChange({...data,vehicles:[...data.vehicles,vehicle]});
  }
  return <div className="broker-intake">
    <header className="broker-intake-head">
      <p className="eyebrow">Broker Side · Submission / file verification only</p>
      <h2>File intake & accuracy check</h2>
      <p>Confirm the client, submission type, document identity, VIN and signatures.
        The Auditor will extract, organize and key in detailed insurance information.
        Do not enter full MVR, coverage or payment details here.</p>
    </header>
    <section className="broker-intake-section" aria-label="Submission identity">
      <h3>1 · Identify the submission</h3>
      <div className="broker-intake-fields">
        <label>Insurance company <input aria-label="Broker insurer"
          value={data.policy.company} onChange={event=>updatePolicy("company",event.target.value)}/></label>
        <label>Client code <input aria-label="Broker client code"
          value={data.policy.client_code} onChange={event=>updatePolicy("client_code",event.target.value)}/></label>
        <label>Named insured <input aria-label="Broker named insured"
          value={data.insured.name} onChange={event=>onChange({...data,insured:{...data.insured,name:event.target.value}})}/></label>
        <label>Additional named insureds (one person per line)
          <textarea aria-label="Broker co-insured names" rows={2}
            value={(data.insured.co_insured??[]).map(p=>p.name).join("\n")}
            onChange={event=>onChange({...data,insured:{...data.insured,
              co_insured:event.target.value.split(/\r?\n/).map(name=>name.trim()).filter(Boolean)
                .map(name=>({name}))}})}/></label>
        <label>{change?"Current policy #":"Quote / submission #"} <input
          aria-label={change?"Broker existing policy number":"Broker quote number"}
          value={change?data.policy.policy_number??"":data.policy.quote_number}
          onChange={event=>updatePolicy(change?"policy_number":"quote_number",event.target.value)}/></label>
        <label>{change?"Policy / transaction effective date":"Proposed effective date"}
          <input aria-label="Broker effective date" type="date"
            value={change?data.policy_change?.change_effective_date||data.policy.effective_date:
              data.policy.effective_date}
            onChange={event=>change?patchChange({change_effective_date:event.target.value}):
              updatePolicy("effective_date",event.target.value)}/></label>
      </div>
    </section>
    {change&&<section className="broker-intake-section" aria-label="Requested policy change">
      <h3>2 · Client's requested change</h3>
      <div className="broker-intake-fields">
        <label>Transaction type
          <select aria-label="Broker policy change type"
            value={data.policy_change?.transaction_types?.[0]??""}
            onChange={event=>{
              const selected=event.target.value as PolicyChangeTransactionType;
              patchChange({transaction_types:selected?[selected]:[],
                requested_action:selected?selected.replaceAll("_"," "):""});
            }}>
            <option value="">Select from client's instruction</option>
            {POLICY_CHANGE_TRANSACTIONS.map(type=><option value={type} key={type}>
              {type.replaceAll("_"," ")}</option>)}
          </select></label>
        <label>Vehicle / property affected <input aria-label="Broker change subject"
          value={data.policy_change?.vehicle_or_property??""}
          onChange={event=>patchChange({vehicle_or_property:event.target.value})}/></label>
        <label>Changed / added vehicle VIN (when applicable)
          <input aria-label="Broker affected VIN" value={data.policy_change?.vin??""}
            onChange={event=>patchChange({vin:event.target.value.toUpperCase()})}/></label>
        <label>Requested action (client wording)
          <textarea aria-label="Broker client's requested instruction" rows={3}
            value={data.policy_change?.requested_action??""}
            onChange={event=>patchChange({requested_action:event.target.value})}/></label>
      </div>
      <p className="broker-intake-hint">Attach the original request and signed authorization.
        Auditor organizes prior/new values and portal instructions after import.</p>
    </section>}
    {auto&&<section className="broker-intake-section" aria-label="Vehicle identity for Ownership cross-check">
      <h3>{change?"3":"2"} · Vehicle and Ownership identity</h3>
      <p className="broker-intake-hint">Record only the vehicles that the submitted transaction or new quote
        actually concerns. Confirm every VIN against the uploaded Ownership. Usage and annual km are for Auditor.</p>
      {evidenceVehicles.filter(c=>!data.vehicles.some(v=>v.vin.toUpperCase()===c.vin))
        .map(candidate=><div className="broker-ownership-suggestion" key={candidate.vin}>
          <span>{candidate.year||"Year?"} {candidate.make} {candidate.model} · {candidate.vin} · {candidate.fileName}</span>
          <Button size="sm" variant="outline" onClick={()=>appendOwnership(candidate)}>
            Add vehicle after checking Ownership</Button>
        </div>)}
      {data.vehicles.map((vehicle,index)=><div key={vehicle.id??index}
        className="broker-intake-vehicle">
        <strong>Vehicle {index+1}</strong>
        <div className="broker-intake-fields">
          <label>VIN <input aria-label={"Broker vehicle "+(index+1)+" VIN"} value={vehicle.vin}
            onChange={event=>changeVehicle(vehicle.id!,"vin",event.target.value)}/></label>
          <label>Year <input aria-label={"Broker vehicle "+(index+1)+" year"}
            type="number" min="1900" max="2100" value={vehicle.year||""}
            onChange={event=>changeVehicle(vehicle.id!,"year",event.target.value)}/></label>
          <label>Make <input value={vehicle.make}
            onChange={event=>changeVehicle(vehicle.id!,"make",event.target.value)}/></label>
          <label>Model <input value={vehicle.model}
            onChange={event=>changeVehicle(vehicle.id!,"model",event.target.value)}/></label>
          <label>Registered owner <input aria-label={"Broker vehicle "+(index+1)+" owner"}
            value={vehicle.ownership?.registered_owner??""}
            onChange={event=>changeVehicle(vehicle.id!,"owner",event.target.value)}/></label>
          <label>Ownership address (from permit) <input
            aria-label={"Broker vehicle "+(index+1)+" owner address"}
            value={vehicle.ownership?.address??""}
            onChange={event=>changeVehicle(vehicle.id!,"ownerAddress",event.target.value)}/></label>
          <label>Leased according to Ownership?
            <select aria-label={"Broker vehicle "+(index+1)+" lease status"}
              value={vehicle.ownership?.leased===null||vehicle.ownership?.leased===undefined?"unknown":
                vehicle.ownership?.leased?"yes":"no"}
              onChange={event=>changeVehicle(vehicle.id!,"leaseStatus",event.target.value)}>
              <option value="unknown">Not confirmed from Ownership</option>
              <option value="no">No</option><option value="yes">Yes</option>
            </select></label>
          {vehicle.ownership?.leased&&<label>Lessor name (from permit) <input
            aria-label={"Broker vehicle "+(index+1)+" lessor"}
            value={vehicle.ownership?.lessor?.name??""}
            onChange={event=>changeVehicle(vehicle.id!,"lessor",event.target.value)}/></label>}
        </div>
        <label className="broker-ownership-verification">
          <input type="checkbox" aria-label={"Broker vehicle "+(index+1)+" ownership verified"}
            checked={vehicle.ownership?.received===true}
            disabled={!hasOwnershipSectionForVehicle(vehicle,records)}
            onChange={event=>{
              if(event.target.checked && !window.confirm(
                "I visually checked the actual Ownership, VIN, year/make/model and registered owner for this vehicle."))
                return;
              onChange(confirmVehicleOwnership(data,vehicle.id!,event.target.checked,records));
            }}/>
          I verified this vehicle against its active original Ownership section.
        </label>
        {!hasOwnershipSectionForVehicle(vehicle,records)&&
          <small>Link an active Ownership section to this vehicle in Documents → Manage sections,
            or confirm a matching VIN from parsed Ownership, before verifying.</small>}
        <Button size="sm" variant="outline" onClick={()=>{
          if(window.confirm("Remove vehicle from the submission?"))
            onChange({...data,vehicles:data.vehicles.filter(v=>v.id!==vehicle.id)});
        }}>Remove vehicle identity</Button>
      </div>)}
      <Button size="sm" variant="outline" onClick={()=>onChange({...data,
        vehicles:[...data.vehicles,emptyVehicle()]})}>Add vehicle identity</Button>
      {data.drivers?.length>0&&<p className="broker-intake-hint">Driver evidence subjects already listed:
        {" "+data.drivers.map(d=>d.name).join("; ")}</p>}
      <details><summary>Add a driver identity only when needed for evidence association</summary>
        <Button size="sm" variant="outline" onClick={()=>onChange({...data,
          drivers:[...data.drivers,emptyDriver()]})}>Add driver name</Button>
        {(data.drivers??[]).map((driver,index)=><label key={driver.id??index}>
          Driver {index+1} name <input aria-label={"Broker driver "+(index+1)+" name"}
          value={driver.name} onChange={event=>onChange({...data,
            drivers:data.drivers.map(d=>d.id===driver.id?{...d,name:event.target.value}:d)})}/>
        </label>)}
      </details>
    </section>}
    <section className="broker-intake-section" aria-label="Required document checklist">
      <h3>{auto?(change?"4":"3"):(change?"3":"2")} · Document completeness</h3>
      <p>Checklist is calculated from active classified source sections. A filename alone cannot
        prove a required document has been received.</p>
      <div className="broker-document-status">
        {presence.documents.filter(d=>d.required).map(doc=><div key={doc.id}
          className={doc.received?"received":"missing"}>
          <strong>{doc.received?"Found":"Missing"}</strong><span>{doc.name}</span>
        </div>)}
        {!presence.documents.some(doc=>doc.required)&&
          <p>Transaction-specific document checks appear in the right-side Preflight panel.</p>}
      </div>
      <p className="broker-intake-hint">{records.length} physical files uploaded.
        {missing.length?" "+missing.length+" checklist item(s) still missing.":""}
        {supplemental.length?" "+supplemental.length+" additional supporting item(s) available.":""}
      </p>
    </section>
    <footer className="broker-intake-footer">
      <strong>Final Broker step:</strong> verify actual originals/sections and signatures using the document panel,
      resolve right-side Preflight blockers, generate the .bdzip, then manually send it to Auditor.
      Detailed Key-in and underwriting review are the Auditor's responsibility.
    </footer>
  </div>;
}

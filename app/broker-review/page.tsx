"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brokerReviewClient, type BrokerReview, type BrokerReviewStatus, type ReviewField } from "@/lib/broker-review-client";

const roleOptions=[
  ["PRINCIPAL","Principal"],["SECONDARY","Secondary"],["OCCASIONAL","Occasional"],
  ["NOT_INCLUDED_IN_RATING","Not included in rating"],["EXCLUDED","Excluded"]
] as const;
const teal="#0f766e";
const fieldString=(value:unknown,type:string):string=>{
  if(value===null||value===undefined)return "";
  if(typeof value==="boolean")return String(value);
  if(type==="list"&&Array.isArray(value))return value.join(", ");
  if(typeof value==="object")return JSON.stringify(value,null,2);
  return String(value);
};
function decodeValue(field:ReviewField,text:string):unknown {
  if(text.trim()===""&&field.type!=="multiline")return null;
  if(field.type==="number") {
    const n=Number(text.replace(/,/g,""));
    if(!Number.isFinite(n))throw Error(`${field.label}: enter a valid number.`);
    return n;
  }
  if(field.type==="list")return text.split(",").map(s=>s.trim()).filter(Boolean);
  if(field.type==="record") {
    try {return JSON.parse(text);} catch {throw Error(`${field.label}: invalid JSON record.`);}
  }
  return text;
}
const readError=(error:unknown)=>error instanceof Error?error.message:"Request failed.";
export default function BrokerReviewPage() {
  const [caseId,setCaseId]=useState("");
  const [data,setData]=useState<BrokerReviewStatus|null>(null);
  const [active,setActive]=useState(0);
  const [actor,setActor]=useState("PILOT-BROKER-1");
  const [draft,setDraft]=useState<Record<string,string>>({});
  const [busy,setBusy]=useState(false);
  const [savingField,setSavingField]=useState<string|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const currentRef=useRef<BrokerReviewStatus|null>(null);
  const submitting=useRef(false);
  const setResult=useCallback((value:BrokerReviewStatus)=>{
    currentRef.current=value;setData(value);
  },[]);
  const load=useCallback(async(id:string)=>{
    setBusy(true);setError("");
    try {setResult(await brokerReviewClient.load(id));}
    catch(e){setError(readError(e));}
    finally{setBusy(false);}
  },[setResult]);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    const selected=params.get("caseId")||window.localStorage.getItem("brokerdesk.lastCaseId")||"";
    setCaseId(selected);
    if(selected)void load(selected);
  },[load]);
  const review=data?.review??null;
  const sections=review?.sections??[];
  const section=sections[active]??sections[0];
  const rows=useMemo(()=>review?.fields.filter(f=>f.section===section?.id)??[],[review,section?.id]);
  const sectionErrors=data?.fieldIssues.filter(e=>e.sectionId===section?.id)??[];
  const stale=Boolean(data?.sourceIssues.length);
  const isPending=(id:string)=>Object.prototype.hasOwnProperty.call(draft,id);
  const hasDirty=Object.keys(draft).length>0;
  function display(field:ReviewField) {return isPending(field.id)?draft[field.id]:fieldString(field.value,field.type);}
  async function create() {
    if(!caseId||busy)return;
    setBusy(true);setError("");
    try{setResult(await brokerReviewClient.create(caseId,actor));setNotice("Draft created. Review each page before confirming.");}
    catch(e){setError(readError(e));}
    finally{setBusy(false);}
  }
  async function rebuild() {
    if(!caseId||!review||busy)return;
    if(!window.confirm("Rebuild from the current Case and original files? Any manual edits in this draft will be lost."))return;
    setBusy(true);setError("");setNotice("");
    try{setResult(await brokerReviewClient.rebuild(caseId,actor,review.revision));setDraft({});setActive(0);}
    catch(e){setError(readError(e));}
    finally{setBusy(false);}
  }
  const persist=async(field:ReviewField,newValue:unknown)=>{
    if(!caseId||!currentRef.current?.review)return;
    if(submitting.current)return;
    submitting.current=true;setSavingField(field.id);setError("");
    try {
      const rev=currentRef.current.review;
      const result=await brokerReviewClient.edit(caseId,actor,rev.revision,field.id,newValue);
      setResult(result);
      setDraft(current=>{const next={...current};delete next[field.id];return next;});
      setNotice(`${field.label} saved.`);
    }catch(e){setError(readError(e));}
    finally {setSavingField(null);submitting.current=false;}
  };
  async function saveText(field:ReviewField) {
    if(!isPending(field.id)||!review||busy||stale)return;
    try{
      const text=draft[field.id];
      const value=decodeValue(field,text);
      if(JSON.stringify(value)===JSON.stringify(field.value)){
        setDraft(old=>{const copy={...old};delete copy[field.id];return copy;});return;
      }
      await persist(field,value);
    }catch(e){setError(readError(e));}
  }
  async function saveBoolean(field:ReviewField,text:string) {
    await persist(field,text===""?null:text==="true");
  }
  async function saveAssignments(field:ReviewField,items:Array<{driverId:string;role:string}>) {
    await persist(field,items);
  }
  async function confirm() {
    if(!caseId||!review||!section||busy||savingField||hasDirty||stale)return;
    setBusy(true);setError("");
    try {
      const result=await brokerReviewClient.confirm(caseId,actor,review.revision,section.id);
      setResult(result);setNotice(`${section.title} confirmed.`);
      if(active<sections.length-1)setActive(active+1);
    }catch(e){setError(readError(e));}
    finally{setBusy(false);}
  }
  async function remarksDraft() {
    if(!caseId||busy||savingField||hasDirty||!review)return;
    setBusy(true);setError("");
    try {
      const result=await brokerReviewClient.remarksPreview(caseId);
      setDraft(current=>({...current, "remarks.text":result.preview.text}));
      setNotice(result.preview.needsManualCompletion?
        "Only the safe default opening was generated. Complete and save it before confirming.":
        "Auto-generated text is a draft. Check all details and save it.");
    }catch(e){setError(readError(e));}
    finally{setBusy(false);}
  }
  const drivers=review?.fields.filter(f=>f.id.startsWith("driver:")&&f.id.endsWith(".name"))
    .map(f=>({id:f.id.slice(7,-5),name:String(f.value??f.id)}))??[];
  const principalNote="Only actual assigned drivers are shown. Select a role or add another driver.";
  const fieldInput=(field:ReviewField)=>{
    const match=field.id.match(/^(vehicle:[^.]+)\.(.+)$/);
    const prefix=match?.[1];
    if(prefix&&match?.[2]==="garagingAddress" &&
       review?.fields.find(f=>f.id===prefix+".parkingSameAsMailing")?.value===true)return null;
    if(prefix&&/^(allPerils|collision|comprehensive)\.deductible$/.test(match?.[2]??"")){
      const kind=match?.[2].split(".")[0];
      if(review?.fields.find(f=>f.id===prefix+"."+kind+".present")?.value!==true)return null;
    }
    if(field.type==="assignments"){
      const items=Array.isArray(field.value)?field.value as Array<{driverId:string;role:string}>:[];
      return <div className="space-y-2">
        <small>{principalNote}</small>
        {items.map((assigned,index)=><div className="flex gap-2" key={index}>
          <select className="rounded border p-2 flex-1" aria-label={"Driver "+(index+1)}
            disabled={busy||Boolean(savingField)||stale} value={assigned.driverId}
            onChange={e=>void saveAssignments(field,items.map((it,i)=>i===index?{...it,driverId:e.target.value}:it))}>
            <option value="">Select Driver</option>{drivers.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select className="rounded border p-2" value={assigned.role} aria-label={"Driver role "+(index+1)}
            disabled={busy||Boolean(savingField)||stale}
            onChange={e=>void saveAssignments(field,items.map((it,i)=>i===index?{...it,role:e.target.value}:it))}>
            {roleOptions.map(([value,label])=><option value={value} key={value}>{label}</option>)}
          </select>
          <button type="button" className="border rounded px-2" aria-label="Remove assignment"
            disabled={busy||Boolean(savingField)||stale}
            onClick={()=>void saveAssignments(field,items.filter((_,i)=>i!==index))}>×</button>
        </div>)}
        <button type="button" className="rounded border px-3 py-1"
          disabled={busy||Boolean(savingField)||stale||!drivers.some(d=>!items.some(it=>it.driverId===d.id))}
          onClick={()=>{
            const next=drivers.find(d=>!items.some(it=>it.driverId===d.id));
            if(next)void saveAssignments(field,[...items,{driverId:next.id,role:"OCCASIONAL"}]);
          }}>
          Add assigned driver
        </button>
      </div>;
    }
    if(field.type==="boolean")
      return <select className="w-full rounded border p-2" value={field.value===true?"true":field.value===false?"false":""}
        disabled={busy||Boolean(savingField)||stale}
        aria-label={field.label} onChange={e=>void saveBoolean(field,e.target.value)}>
        <option value="">Unknown / not reviewed</option>
        <option value="true">Yes</option><option value="false">No</option>
      </select>;
    const value=display(field);
    const multi=["record","multiline","list"].includes(field.type);
    return <div>
      {multi?
        <textarea className="w-full rounded border p-2 font-mono text-sm" rows={field.type==="multiline"?6:3}
          aria-label={field.label} value={value}
          disabled={busy||Boolean(savingField)||stale}
          onChange={e=>setDraft(old=>({...old,[field.id]:e.target.value}))}
          onBlur={()=>void saveText(field)}/>:
        <input className="w-full rounded border p-2" value={value}
          aria-label={field.label} type={field.type==="date"?"date":"text"}
          disabled={busy||Boolean(savingField)||stale}
          onChange={e=>setDraft(old=>({...old,[field.id]:e.target.value}))}
          onBlur={()=>void saveText(field)}/>}
      {field.id==="remarks.text" && <p className="text-xs text-slate-600 mt-1">
        {value.replace(/\r\n?/g,"\n").length}{/\bPEMBRIDGE\b/i.test(review?.company??"")?" / 460 characters (includes spaces/punctuation/newlines)": " characters"}
      </p>}
      {field.type==="record"&&<small>Structured claim/MVR details: edit valid JSON only when needed.</small>}
    </div>;
  };
  return <main className="mx-auto max-w-6xl p-4 md:p-8 space-y-5">
    <header className="flex flex-wrap justify-between items-center gap-4">
      <div>
        <p className="text-sm text-slate-500">BrokerDesk · Step 2 local draft</p>
        <h1 className="text-2xl font-semibold">Broker Key-in Review</h1>
        <p className="text-sm text-slate-600">Check each page, correct fields, confirm once per section.</p>
      </div>
      <a className="rounded border p-2" href="/">Return to Case</a>
    </header>
    <section className="border rounded-xl p-4 flex flex-wrap items-end gap-3">
      <label className="text-sm flex-1 min-w-48">Current Case ID
        <input className="border rounded w-full p-2 mt-1" value={caseId} readOnly aria-label="Case ID"/>
      </label>
      <label className="text-sm flex-1 min-w-48">Broker ID
        <input className="border rounded w-full p-2 mt-1" value={actor} onChange={e=>setActor(e.target.value)}
          aria-label="Broker ID" disabled={busy}/>
      </label>
      <button className="rounded border px-3 py-2" disabled={!caseId||busy} onClick={()=>void load(caseId)}>Refresh</button>
      {!review && <button style={{background:teal,color:"#fff"}} className="rounded px-4 py-2"
        disabled={!caseId||busy} onClick={()=>void create()}>Create Review Draft</button>}
    </section>
    {error&&<div role="alert" className="rounded border border-red-500 p-3 whitespace-pre-line text-red-700">{error}</div>}
    {notice&&<div role="status" className="rounded bg-slate-100 p-3">{notice}</div>}
    {data?.sourceIssues.length ? <div className="rounded border border-amber-500 p-3 space-y-2">
      <p className="font-semibold">Original Case or file source changed / unavailable</p>
      {data.sourceIssues.map((issue,i)=><p className="text-sm" key={i}>{issue}</p>)}
      {review&&<button className="rounded border px-3 py-2" onClick={()=>void rebuild()} disabled={busy}>
        Rebuild draft from current originals (manual edits will be lost)</button>}
    </div>:null}
    {review&&<div className="grid md:grid-cols-[250px_1fr] gap-4">
      <nav className="border rounded-xl p-3 h-fit space-y-1" aria-label="Broker Review pages">
        <p className="text-xs text-slate-500 px-2 mb-2">Confirmed {data?.confirmed} / {data?.total} pages · {review.review_status}</p>
        {sections.map((s,i)=><button key={s.id} type="button"
          disabled={Boolean(savingField)||busy||hasDirty}
          aria-current={active===i?"page":undefined}
          onClick={()=>setActive(i)}
          className={`w-full text-left rounded p-2 text-sm ${active===i?"bg-slate-100 font-semibold":""}`}>
          {i+1}. {s.title} {s.status==="CONFIRMED"?"✓":""}
        </button>)}
      </nav>
      <section className="border rounded-xl p-4 space-y-4" aria-live="polite">
        <div className="flex justify-between gap-3 flex-wrap">
          <div><h2 className="font-semibold text-xl">{section?.title}</h2>
            <p className="text-sm text-slate-500">{rows.length} fields · {section?.status}</p>
          </div>
          {section?.id==="remarks"&&<button type="button"
            className="border rounded px-3 py-2" disabled={busy||stale||hasDirty}
            onClick={()=>void remarksDraft()}>Generate Remarks Draft</button>}
        </div>
        {rows.map(field=><div key={field.id} className="border-b pb-3 grid md:grid-cols-[44%_1fr] gap-2">
          <div className="text-sm">
            <label className="font-medium" htmlFor={field.id}>{field.label}{field.required?" *":""}</label>
            <p className="text-xs text-slate-500">
              {field.origin??"CASE_UNVERIFIED"}{field.evidence?.length?` · ${field.evidence.length} source(s)`:""}
              {field.conflict?" · Conflict":""}
            </p>
            {field.evidence?.map((e,i)=><a key={i}
              className="text-xs underline block" target="_blank" rel="noreferrer"
              href={`${process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL??"http://127.0.0.1:47831"}/documents/${encodeURIComponent(e.documentId)}/file`}>
              Open source · page {e.page}
            </a>)}
          </div>
          {fieldInput(field)}
        </div>)}
        {sectionErrors.length>0&&<details>
          <summary className="text-sm text-amber-700 cursor-pointer">Fields needing attention ({sectionErrors.length})</summary>
          <div className="space-y-1 mt-2 text-sm text-amber-800">
            {sectionErrors.map((e,i)=><p key={i}>{e.message}</p>)}
          </div>
        </details>}
        <footer className="flex gap-2 justify-between flex-wrap pt-3">
          <button type="button" className="rounded border px-4 py-2"
            disabled={busy||hasDirty||active===0} onClick={()=>setActive(i=>i-1)}>Previous</button>
          <button type="button" className="rounded px-4 py-2"
            style={{background:teal,color:"#fff"}}
            disabled={busy||Boolean(savingField)||hasDirty||stale||section?.status==="CONFIRMED"}
            onClick={()=>void confirm()}>
            {savingField?"Saving field…":"Confirm this page"}
          </button>
        </footer>
        <p className="text-xs text-slate-500">
          Broker Review is saved locally. BDZIP uses legacy v0.3 by default.
          When BROKERDESK_REVIEWED_KEYIN_V04=1 is enabled on the Broker service,
          all required pages must be confirmed and reviewed-keyin.json is included in the v0.4 BDZIP.
          The Auditor still validates original-file hashes, signed evidence and Intake rules.
        </p>
      </section>
    </div>}
  </main>;
}

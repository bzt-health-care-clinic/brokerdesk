"use client";

import { useEffect, useState } from "react";
import {
  emptyReportRow, formToReport, reportToForm,
  type ReportForm, type ReportKind, type ReportRow
} from "@/lib/broker-review-report-form.mjs";

interface Props {
  fieldId: string;
  kind: ReportKind;
  value: unknown;
  disabled: boolean;
  onSave: (value: Record<string,unknown>) => Promise<boolean>;
  onDirtyChange: (fieldId:string, dirty:boolean) => void;
}

export default function BrokerReviewReportEditor({
  fieldId, kind, value, disabled, onSave, onDirtyChange
}: Props) {
  const [form,setForm]=useState<ReportForm>(()=>reportToForm(value,kind));
  const [dirty,setDirty]=useState(false);
  const [saving,setSaving]=useState(false);
  const [issues,setIssues]=useState<string[]>([]);

  const sourceKey=JSON.stringify(value??null);
  useEffect(()=>{
    setForm(reportToForm(JSON.parse(sourceKey),kind));
    setDirty(false);
    setIssues([]);
    onDirtyChange(fieldId,false);
  },[sourceKey,kind,fieldId,onDirtyChange]);
  useEffect(()=>()=>onDirtyChange(fieldId,false),[fieldId,onDirtyChange]);

  const update=(next:ReportForm)=>{
    setForm(next);setDirty(true);setIssues([]);
    onDirtyChange(fieldId,true);
  };
  const setPresence=(presence:ReportForm["presence"])=>{
    if(presence==="no"&&form.rows.length &&
       !window.confirm("This will remove the listed details. Continue only if the source explicitly reports none."))return;
    update({presence,rows:presence==="no"?[]:form.rows});
  };
  const setItem=(i:number,key:keyof ReportRow,text:string)=>{
    update({...form,rows:form.rows.map((r,j)=>j===i?{...r,[key]:text}:r)});
  };
  const save=async()=>{
    const result=formToReport(form,value,kind);
    if(result.issues.length){setIssues(result.issues);return;}
    if(!result.value)return;
    setSaving(true);
    try {
      const success=await onSave(result.value);
      if(success) {
        setDirty(false);
        onDirtyChange(fieldId,false);
        setIssues([]);
      }
    } finally {setSaving(false);}
  };
  const remove=(index:number)=>{
    if(!window.confirm("Remove this detail row?"))return;
    update({...form,rows:form.rows.filter((_,i)=>i!==index)});
  };
  const textField=(index:number,key:keyof ReportRow,label:string,type="text")=>
    <label className="text-xs block">
      <span className="block mb-1 text-slate-700">{label}</span>
      <input
        className="w-full rounded border px-2 py-2 text-sm"
        type={type}
        aria-label={`${kind.toUpperCase()} ${label} ${index+1}`}
        value={String(form.rows[index]?.[key]??"")}
        disabled={disabled||saving}
        onChange={e=>setItem(index,key,e.target.value)}
      />
    </label>;
  return <div className="rounded-lg border p-3 space-y-3" data-broker-report-editor={kind}>
    <div className="flex gap-4 items-end flex-wrap">
      <label className="text-sm font-medium">
        {kind==="mvr"?"Convictions":"Claims"}
        <select className="block rounded border p-2 mt-1"
          aria-label={`${kind.toUpperCase()} reported result`}
          value={form.presence} disabled={disabled||saving}
          onChange={e=>setPresence(e.target.value as ReportForm["presence"])}>
          <option value="">Unknown / needs review</option>
          <option value="yes">Yes</option>
          <option value="no">No (explicitly shown on report)</option>
        </select>
      </label>
      <p className="text-xs text-slate-600">
        Use the original report. Missing/unreadable does not mean No.
      </p>
    </div>

    {form.presence==="yes" &&
      <div className="space-y-3">
        {form.rows.map((row,i)=>
          <section key={`${row._sourceIndex??"new"}-${i}`} className="rounded border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">{kind==="mvr"?"Conviction":"Claim"} {i+1}</h4>
              <button type="button" className="rounded border px-2 py-1 text-sm"
                disabled={disabled||saving} onClick={()=>remove(i)}>Remove</button>
            </div>
            {kind==="mvr"?
              <div className="grid sm:grid-cols-2 gap-2">
                {textField(i,"offenceDate","Offence Date","date")}
                {textField(i,"classification","Classification (Minor / Major / offence type)")}
                <div className="sm:col-span-2">{textField(i,"description","Offence Description")}</div>
              </div>:
              <div className="grid sm:grid-cols-2 gap-2">
                {textField(i,"claimNumber","Claim #")}
                {textField(i,"lossDate","Loss Date","date")}
                {textField(i,"driver","Driver at time of loss")}
                {textField(i,"vehicle","Vehicle (if known)")}
                {textField(i,"atFaultPercent","At-fault %","number")}
              </div>}
          </section>)}
        <button type="button" className="rounded border px-3 py-2 text-sm"
          disabled={disabled||saving}
          onClick={()=>update({...form,rows:[...form.rows,emptyReportRow(kind)]})}>
          Add {kind==="mvr"?"Conviction":"Claim"}
        </button>
      </div>}
    {issues.length>0&&<div role="alert" className="rounded border border-amber-500 p-2 text-sm text-amber-800">
      {issues.map((issue,i)=><p key={i}>{issue}</p>)}
    </div>}
    <div className="flex gap-2 justify-end">
      <button type="button" className="rounded border px-3 py-2 text-sm"
        disabled={!dirty||saving}
        onClick={()=>{
          setForm(reportToForm(value,kind));setDirty(false);setIssues([]);
          onDirtyChange(fieldId,false);
        }}>Discard changes</button>
      <button type="button" className="rounded border px-3 py-2 text-sm font-semibold"
        disabled={!dirty||disabled||saving}
        onClick={()=>void save()}>
        {saving?"Saving…":"Save report"}
      </button>
    </div>
    <p className="text-xs text-slate-500">Report Pulled Date is edited in the separate field above. No Demerit Points are required.</p>
  </div>;
}

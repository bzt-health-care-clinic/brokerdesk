import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import {
  reportKind, reportToForm, emptyReportRow, formToReport
} from "../lib/broker-review-report-form.mjs";
import {validateReportSummary} from "../lib/reviewed-report-schema.mjs";

test("recognizes only report summary IDs",()=>{
  assert.equal(reportKind("report:mvr:doc-1.summary"),"mvr");
  assert.equal(reportKind("report:dash:doc:segment.summary"),"dash");
  assert.equal(reportKind("report:mvr:doc-1.pulledDate"),null);
  assert.equal(reportKind("vehicle:x.coverage"),null);
});

test("missing MVR stays unknown (never zero conviction)",()=>{
  const form=reportToForm(null,"mvr");
  assert.equal(form.presence,"");
  assert.deepEqual(form.rows,[]);
  const result=formToReport(form,null,"mvr");
  assert(result.issues.length>0);
});

test("an explicit No MVR is valid and matches Step 3E strict validator",()=>{
  const result=formToReport({presence:"no",rows:[]},null,"mvr");
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(result.value,{hasConvictions:false,convictions:[]});
  assert.deepEqual(validateReportSummary(result.value,"mvr"),[]);
});

test("MVR yes must contain an offence",()=>{
  assert(formToReport({presence:"yes",rows:[]},null,"mvr").issues.length>0);
});

test("MVR input requires offence date, type and description, not demerit points",()=>{
  const form={presence:"yes",rows:[{offenceDate:"2026-05-01",description:"Speeding",classification:"Minor"}]};
  const result=formToReport(form,{},"mvr");
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(validateReportSummary(result.value,"mvr"),[]);
  assert.equal(result.value.convictions[0].classification,"Minor");
  assert(!("demeritPoints" in result.value.convictions[0]));
});

test("MVR invalid dates are rejected",()=>{
  const result=formToReport({presence:"yes",rows:[{
    offenceDate:"2026-02-30",description:"Speeding",classification:"Minor"
  }]},null,"mvr");
  assert(result.issues.length>0);
});

test("DASH claim with zero percent fault does not become blank",()=>{
  const result=formToReport({presence:"yes",rows:[{
    claimNumber:"CL-88",lossDate:"2026-01-02",driver:"Driver A",vehicle:"Car 1",atFaultPercent:"0"
  }]},null,"dash");
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(validateReportSummary(result.value,"dash"),[]);
  assert.equal(result.value.claims[0].atFaultPercent,0);
});

test("DASH blank fault cannot silently become zero percent",()=>{
  const result=formToReport({presence:"yes",rows:[{
    claimNumber:"CL-88",lossDate:"2026-01-02",driver:"Driver A",atFaultPercent:""
  }]},null,"dash");
  assert(result.issues.some(e=>e.includes("at-fault")));
});

test("DASH fault outside 0..100 is rejected",()=>{
  for(const pct of ["-2","101","not a number"]){
    const result=formToReport({presence:"yes",rows:[{
      claimNumber:"CL-88",lossDate:"2026-01-02",driver:"Driver A",atFaultPercent:pct
    }]},null,"dash");
    assert(result.issues.length>0);
  }
});

test("No DASH claim cannot coexist with detailed rows",()=>{
  assert(formToReport({presence:"no",rows:[emptyReportRow("dash")]},null,"dash").issues.length>0);
});

test("existing root and per-claim extra metadata survives an edit",()=>{
  const old={subjectLicence:"X111",reportPerspective:"first-party",hasClaims:true,claims:[{
    claimNumber:"C1",lossDate:"2026-01-01",driver:"A",atFaultPercent:50,sourcePage:31,rawFault:"F.P."
  }]};
  const form=reportToForm(old,"dash");
  form.rows[0].driver="B";
  const result=formToReport(form,old,"dash");
  assert.deepEqual(result.issues,[]);
  assert.equal(result.value.subjectLicence,"X111");
  assert.equal(result.value.reportPerspective,"first-party");
  assert.equal(result.value.claims[0].sourcePage,31);
  assert.equal(result.value.claims[0].rawFault,"F.P.");
  assert.equal(result.value.claims[0].driver,"B");
});

test("deleting a claim retains metadata for the remaining claim only",()=>{
  const old={hasClaims:true,claims:[
    {claimNumber:"1",lossDate:"2026-01-01",driver:"A",atFaultPercent:0,sourcePage:1},
    {claimNumber:"2",lossDate:"2026-01-02",driver:"B",atFaultPercent:100,sourcePage:2}
  ]};
  const form=reportToForm(old,"dash");
  form.rows.shift();
  const result=formToReport(form,old,"dash");
  assert.deepEqual(result.issues,[]);
  assert.equal(result.value.claims.length,1);
  assert.equal(result.value.claims[0].claimNumber,"2");
  assert.equal(result.value.claims[0].sourcePage,2);
});

test("new claim does not inherit metadata from an old removed row",()=>{
  const old={hasClaims:true,claims:[{
    claimNumber:"1",lossDate:"2026-01-01",driver:"A",atFaultPercent:0,sourcePage:1
  }]};
  const form={presence:"yes",rows:[{
    ...emptyReportRow("dash"),claimNumber:"2",lossDate:"2026-01-02",
    driver:"B",atFaultPercent:"100"
  }]};
  const result=formToReport(form,old,"dash");
  assert.deepEqual(result.issues,[]);
  assert.equal(result.value.claims[0].sourcePage,undefined);
});

test("source perspective summaries stay separate by report ID",()=>{
  const a="report:dash:doc-first.summary";
  const b="report:dash:doc-third.summary";
  assert.notEqual(a,b);
  assert.equal(reportKind(a),"dash");
  assert.equal(reportKind(b),"dash");
});

test("the strict Step 3E validator rejects an empty JSON object",()=>{
  assert(validateReportSummary({},"mvr").length>0);
  assert(validateReportSummary({},"dash").length>0);
});

test("accepts no claims explicitly",()=>{
  const result=formToReport({presence:"no",rows:[]},{reportSource:"DASH"},"dash");
  assert.deepEqual(result.issues,[]);
  assert.deepEqual(validateReportSummary(result.value,"dash"),[]);
  assert.equal(result.value.reportSource,"DASH");
});

test("limit report to 100 rows",()=>{
  const form={presence:"yes",rows:Array.from({length:101},()=>emptyReportRow("mvr"))};
  assert(formToReport(form,null,"mvr").issues.length>0);
});

test("source form values round-trip with 100 percent fault",()=>{
  const source={hasClaims:true,claims:[{
    claimNumber:"A",lossDate:"2026-10-01",driver:"A",atFaultPercent:100
  }]};
  const result=formToReport(reportToForm(source,"dash"),source,"dash");
  assert.deepEqual(result.issues,[]);
  assert.equal(result.value.claims[0].atFaultPercent,100);
});

test("default report rows do not include invented data",()=>{
  assert.equal(emptyReportRow("mvr").offenceDate,"");
  assert.equal(emptyReportRow("dash").claimNumber,"");
});

test("install script will not touch a repository missing the expected UI anchor",()=>{
  const sandbox=mkdtempSync(join(tmpdir(),"step4a-missing-"));
  mkdirSync(join(sandbox,"app/broker-review"),{recursive:true});
  for(const f of [
    "components/broker-review-report-editor.tsx",
    "lib/broker-review-report-form.mjs","lib/broker-review-report-form.d.mts"
  ]){
    const out=join(sandbox,f);mkdirSync(dirname(out),{recursive:true});
    writeFileSync(out,readFileSync(resolve(f)));
  }
  writeFileSync(join(sandbox,"app/broker-review/page.tsx"),"export default function Page(){ return null; }");
  const script=resolve("scripts/install-broker-review-step4a.mjs");
  assert.throws(()=>execFileSync(process.execPath,[script,"--dry-run"],{
    cwd:sandbox,stdio:"pipe"
  }));
  assert.equal(readFileSync(join(sandbox,"app/broker-review/page.tsx"),"utf8"),"export default function Page(){ return null; }");
});

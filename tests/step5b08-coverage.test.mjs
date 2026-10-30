import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,copyFileSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {pathToFileURL} from "node:url";

const root=mkdtempSync(join(tmpdir(),"brokerdesk-step5b08-coverage-"));
const src=new URL("../lib/step5b08-keyin-coverage.mjs",import.meta.url);
mkdirSync(join(root,"lib"),{recursive:true});
copyFileSync(src,join(root,"lib/step5b08-keyin-coverage.mjs"));
writeFileSync(join(root,"package.json"),'{"type":"module"}');
writeFileSync(join(root,"lib/keyin-field-catalog.mjs"),`
export function buildKeyinCatalog(item,opts={}) {
  const fields=[
    {id:"policy.insurer",section:"policy",type:"text",required:true,entityId:null,value:item.policy?.company},
    {id:"quoteDiscounts.checkedAgainstQuote",section:"coverage",type:"boolean",required:true,entityId:null,value:false}
  ];
  const reports=[...(opts.reports??[])];
  if(!reports.length&&!opts.reportCategoriesPresent?.length)
    for(const doc of item.documents??[])if(doc.received&&["mvr","dash"].includes(doc.category))
      reports.push({type:doc.category,id:doc.id});
  for(const report of reports){
    for(const [suffix,type] of [["pulledDate","date"],["summary","record"]])
      fields.push({id:\`report:\${report.type}:\${report.id}.\${suffix}\`,section:"history",
        required:true,type,entityId:report.id,value:null});
  }
  return {fields,sections:[{id:"policy"},{id:"coverage"},{id:"history"}]};
}`);
const {
  assessKeyinCoverage,physicalKeyinReports,keyinPackageIntegrityIssues
}=await import(pathToFileURL(join(root,"lib/step5b08-keyin-coverage.mjs")).href);
const sha="f".repeat(64),caseData={case_id:"case-demo",case_type:"new_auto",
  policy:{company:"Synthetic"},documents:[]};
const shape=(id,section,type="text",value="ok",extra={})=>({
  id,section,type,value,required:true,entityId:null,origin:"CASE_UNVERIFIED",
  evidence:[],conflict:false,...extra});
const standard=()=>[shape("policy.insurer","policy"),
  shape("quoteDiscounts.checkedAgainstQuote","coverage","boolean",true)];
const mk=(fields=standard(),extras={})=>({
   schema_version:1,fields,sections:[{id:"policy"},{id:"coverage"},{id:"history"}],
   expected_field_ids:fields.map(f=>f.id),source_files:[],unassigned_candidates:[],
   ...extras
});
const options=(expectedFields=standard(),records=[],extras={})=>({
  expectedFields,expectedSections:mk().sections,records,...extras
});
const doc=(id="doc1",type="MVR",sections=undefined)=>({
 id,sourceHash:sha,documentType:type,
 ...(sections===undefined?{}:{logicalDocuments:sections})
});
const report=(id="doc1",type="mvr",count=2)=>({
  fields:[
    shape(`report:${type}:${id}.pulledDate`,"history","date","2026-10-15",{entityId:id}),
    shape(`report:${type}:${id}.summary`,"history","record",
      type==="mvr"?{hasConvictions:count>0,convictions:Array.from({length:count},(_,i)=>(
        {offenceDate:"2024-01-02",description:"sample",classification:"minor",id:i}))}:
      {hasClaims:count>0,claims:Array.from({length:count},(_,i)=>(
        {claimNumber:"TEST"+i,lossDate:"2024-01-01",driver:"Synthetic",atFaultPercent:0}))},
      {entityId:id})
  ]
});
const history=(type="mvr",id="doc1",count=2)=>({
  schemaVersion:"5B-07-v1",reports:[{reportId:"digest",documentId:id,
    logicalDocumentId:null,sourceHash:sha,documentType:type.toUpperCase(),
    assignedRows:count}],drivers:[{caseDriverId:"driver1",
      convictions:type==="mvr"?Array.from({length:count},(_,i)=>({
        id:"item"+i,kind:"conviction",source:{documentId:id,
        logicalDocumentId:null,sourceHash:sha,page:i+1}})):[],
      claims:type==="dash"?Array.from({length:count},(_,i)=>({
        id:"item"+i,kind:"claim",source:{documentId:id,
        logicalDocumentId:null,sourceHash:sha,page:i+1}})):[]}],
  unassigned:[],blockingIssues:[],totals:{reports:1}
});
test("canonical live field parity succeeds with all sources",()=>{
 const r=assessKeyinCoverage(mk(),options());
 assert.deepEqual(r.structuralIssues,[]);
 assert.equal(r.totals.catalogFields,2);
 assert.equal(r.totals.sourceBound,0);
});
test("missing canonical field is detected even if expected_field_ids is similarly forged",()=>{
 const arr=standard().slice(0,1);
 const r=assessKeyinCoverage(mk(arr),options());
 assert.ok(r.structuralIssues.join(" ").includes("Canonical Key-in field missing"));
});
test("unexpected dynamic field rejected in live exact mode",()=>{
 const fields=standard();fields.push(shape("report:mvr:phantom.summary","history","record",{}));
 const r=assessKeyinCoverage(mk(fields),options(standard(),[],{expectedExact:true}));
 assert.ok(r.structuralIssues.join(" ").includes("Unexpected field outside live catalog"));
});
test("field order discrepancy detected",()=>{
 const r=mk();r.expected_field_ids.reverse();
 assert.ok(assessKeyinCoverage(r,options()).structuralIssues.join(" ").includes("expected_field_ids"));
});
test("field section and type divergence caught",()=>{
 const r=mk();r.fields[0].section="history";
 const result=assessKeyinCoverage(r,options());
 assert.ok(result.structuralIssues.join(" ").includes("schema mismatch"));
});
test("missing values, explicit No, and empty OPCF are classified without false accuracy",()=>{
 const fields=[shape("a","policy","text",null),
  shape("b","coverage","boolean",false),shape("vehicle:v.opcf","coverage","list",[])];
 const r=assessKeyinCoverage(mk(fields),{});
 assert.equal(r.totals.missing,1);assert.equal(r.totals.caseUnverified,2);
 assert.equal(r.totals.requiredMissing,1);
});
test("invalid number / date / unknown type recorded as editable field issues, not rebuild faults",()=>{
 const fields=[shape("a","policy","number","12"),
  shape("b","coverage","date","2026-02-30"),
  shape("c","history","future","x")];
 const result=assessKeyinCoverage(mk(fields),{expectedFields:fields});
 assert.equal(result.fieldIssues.length,3);
 assert.equal(result.structuralIssues.length,0);
});
test("source-bound extracted field without evidence must not be trusted",()=>{
 const fields=standard();fields[0].origin="EXTRACTED";
 const r=assessKeyinCoverage(mk(fields),options());
 assert.ok(r.reconciliationIssues.join(" ").includes("without evidence"));
});
test("evidence SHA / page mismatches are detected",()=>{
 const fields=standard();fields[0].evidence=[{documentId:"doc1",page:0,sourceHash:sha}];
 const r=assessKeyinCoverage(mk(fields,{source_files:[{id:"doc1",sha256:sha}]}),options());
 assert.ok(r.reconciliationIssues.join(" ").includes("Invalid field source reference"));
});
test("two logical report sections create two distinct physical report IDs",()=>{
 const list=physicalKeyinReports([doc("doc1","MIXED",[
  {id:"s1",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2},
  {id:"s2",documentType:"DASH",presenceStatus:"FOUND",startPage:3,endPage:4}])]);
 assert.deepEqual(list.map(x=>x.id),["doc1::s2","doc1::s1"]);
 assert.deepEqual(list.map(x=>x.type),["dash","mvr"]);
});
test("withdrawn report sections excluded; no fallback if explicit []",()=>{
 assert.deepEqual(physicalKeyinReports([doc("doc1","MVR",[])]),[]);
 assert.deepEqual(physicalKeyinReports([{...doc("doc1","MVR",[
   {id:"s1",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2}
 ]),withdrawnSectionRanges:[{startPage:1,endPage:2}]}]),[]);
});
test("physical report missing paired Key-in summary/pull date is a structural blocker",()=>{
 const r=assessKeyinCoverage(mk(),options(standard(),[doc()]));
 assert.equal(r.structuralIssues.filter(x=>x.includes("has no Key-in")).length,2);
});
test("orphan report field not backed by physical active report is detected",()=>{
 const fields=[...standard(),...report().fields];
 const r=assessKeyinCoverage(mk(fields),options(standard(),[doc("real","MVR")]));
 assert.ok(r.structuralIssues.join(" ").includes("has no active physical"));
});
test("07 ledger must exist for active physical MVR/DASH",()=>{
 const fields=[...standard(),...report().fields];
 const r=assessKeyinCoverage(mk(fields),options(standard(),[doc()]));
 assert.ok(r.reconciliationIssues.join(" ").includes("require a 5B-07 integrity ledger"));
});
test("two source convictions cannot be silently reduced to one in Broker summary",()=>{
 const fields=[...standard(),...report("doc1","mvr",1).fields];
 const review=mk(fields,{source_files:[{id:"doc1",sha256:sha}],
  driver_history_integrity:history("mvr","doc1",2)});
 const r=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.ok(r.reconciliationIssues.join(" ").includes("omits source event rows"));
});
test("two source convictions represented as two rows pass reconciliation",()=>{
 const fields=[...standard(),...report("doc1","mvr",2).fields];
 const review=mk(fields,{source_files:[{id:"doc1",sha256:sha}],
  driver_history_integrity:history("mvr","doc1",2)});
 const r=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.deepEqual(r.reconciliationIssues,[]);
});
test("DASH claims preserve multi-row count and misdeclared No is caught",()=>{
 const fields=[...standard(),...report("doc1","dash",2).fields];
 const review=mk(fields,{source_files:[{id:"doc1",sha256:sha}],
  driver_history_integrity:history("dash","doc1",2)});
 let r=assessKeyinCoverage(review,options(standard(),[doc("doc1","DASH")]));
 assert.deepEqual(r.reconciliationIssues,[]);
 fields.find(f=>f.id.endsWith(".summary")).value.hasClaims=false;
 r=assessKeyinCoverage(review,options(standard(),[doc("doc1","DASH")]));
 assert.ok(r.reconciliationIssues.join(" ").includes("omits source event rows"));
});
test("source events with no valid physical page are blocked",()=>{
 const review=mk([...standard(),...report().fields],{
   source_files:[{id:"doc1",sha256:sha}],
   driver_history_integrity:history()});
 review.driver_history_integrity.drivers[0].convictions[0].source.page=null;
 const r=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.ok(r.reconciliationIssues.join(" ").includes("Orphaned"));
});
test("07 blocking issues and unassigned histories are never quietly cleared",()=>{
 const integrity=history();integrity.blockingIssues=[{code:"UNKNOWN_SOURCE_DRIVER_REF"}];
 integrity.unassigned=[{reason:"UNMATCHED_CASE_DRIVER"}];
 const review=mk([...standard(),...report().fields],{
  source_files:[{id:"doc1",sha256:sha}],driver_history_integrity:integrity
 });
 const r=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.ok(r.reconciliationIssues.join(" ").includes("blocking issues"));
 assert.ok(r.reconciliationIssues.join(" ").includes("unassigned events"));
});
test("source history audit doesn't echo offence descriptions or licence PII",()=>{
 const integrity=history();
 integrity.drivers[0].convictions[0].facts={
  licenceNumber:"H-123-PRIVATE",description:"Sensitive offense narrative"};
 const review=mk([...standard(),...report().fields],{
  source_files:[{id:"doc1",sha256:sha}],driver_history_integrity:integrity});
 const reportResult=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.equal(JSON.stringify(reportResult).includes("H-123-PRIVATE"),false);
 assert.equal(JSON.stringify(reportResult).includes("Sensitive offense narrative"),false);
});
test("Auditor-side package rejects static field deletion (both lists edited)",()=>{
 const review=mk(standard().slice(0,1));
 const issues=keyinPackageIntegrityIssues(review,caseData,[]);
 assert.ok(issues.join(" ").includes("Canonical Key-in field missing"));
});
test("Auditor-side package rejects missing physical MVR payload fields",()=>{
 const review=mk();
 const issues=keyinPackageIntegrityIssues(review,caseData,[doc()]);
 assert.ok(issues.join(" ").includes("Physical MVR has no Key-in"));
});
test("Auditor-side validates benign no-report Case without 07 ledger",()=>{
 const issues=keyinPackageIntegrityIssues(mk(),caseData,[]);
 assert.deepEqual(issues,[]);
});
test("required physical MVR cannot be claimed received with no report",()=>{
 const data={...caseData,documents:[{id:"d2",category:"mvr",
   required:true,received:true}]};
 const review=mk([...standard(),...report("d2","mvr",0).fields]);
 const issues=keyinPackageIntegrityIssues(review,data,[]);
 assert.ok(issues.join(" ").includes("Required MVR has no physical report"));
});
test("live exact mode catches deleted dynamic report/discount field",()=>{
 const expected=[...standard(),shape("quoteDiscount:safety.selected","coverage","boolean",true)];
 const r=assessKeyinCoverage(mk(standard()),options(expected,[],{expectedExact:true}));
 assert.ok(r.structuralIssues.join(" ").includes("Canonical Key-in field missing: quoteDiscount"));
});
test("report with zero parsed rows is unrecorded warning, not fake zero",()=>{
 const review=mk([...standard(),...report("doc1","mvr",0).fields],{
 source_files:[{id:"doc1",sha256:sha}],driver_history_integrity:{
 schemaVersion:"5B-07-v1",drivers:[],reports:[{documentId:"doc1",
 logicalDocumentId:null,sourceHash:sha,documentType:"MVR"}],
 blockingIssues:[],unassigned:[]}
 });
 const r=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.equal(r.reconciliationIssues.length,0);
 assert.ok(r.warnings.join(" ").includes("source event rows unrecorded"));
});
test("08 Case driver IDs enforce 07 ledger ownership at export",()=>{
 const review=mk([...standard(),...report().fields],{
   source_files:[{id:"doc1",sha256:sha}],driver_history_integrity:history()});
 const r=assessKeyinCoverage(review,options(standard(),[doc()],{
   caseDriverIds:["d-actual"]}));
 assert.ok(r.reconciliationIssues.join(" ").includes("outside current Case"));
});
test("07 ledger cannot silently omit a physical report section",()=>{
 const historyData=history();
 historyData.reports=[];
 const review=mk([...standard(),...report().fields],{
  source_files:[{id:"doc1",sha256:sha}],driver_history_integrity:historyData});
 const result=assessKeyinCoverage(review,options(standard(),[doc()]));
 assert.ok(result.reconciliationIssues.join(" ").includes("physical report absent from source history ledger"));
});
test("conditional Required fields follow actual BrokerDesk sectionIssues()",()=>{
 const fields=[
   shape("vehicle:v.commute","vehicles","boolean",true),
   shape("vehicle:v.commuteOneWayKm","vehicles","number",null,
     {required:false}),
   shape("vehicle:v.collision.present","coverage","boolean",true),
   shape("vehicle:v.collision.deductible","coverage","number",null,
     {required:false}),
   shape("vehicle:v.parkingSameAsMailing","vehicles","boolean",false),
   shape("vehicle:v.garagingAddress","vehicles","text",null,
     {required:false})
 ];
 const result=assessKeyinCoverage(mk(fields),options(fields));
 assert.equal(result.totals.requiredMissing,3);
 fields.find(f=>f.id.endsWith(".commute")).value=false;
 fields.find(f=>f.id.endsWith(".collision.present")).value=false;
 fields.find(f=>f.id.endsWith(".parkingSameAsMailing")).value=true;
 const changed=assessKeyinCoverage(mk(fields),options(fields));
 assert.equal(changed.totals.requiredMissing,0);
});
test("case discount ID can contain a colon without being rejected by Auditor",()=>{
 const fields=[...standard(),shape("quoteDiscount:WINTER_TIRES:driver-id.selected",
   "coverage","boolean",true)];
 const r=assessKeyinCoverage(mk(fields),options());
 assert.deepEqual(r.structuralIssues,[]);
});
test("tampered dynamic discount type cannot be accepted via loose Auditor catalog",()=>{
 const fields=[...standard(),shape("quoteDiscount:safety.selected",
   "coverage","text","yes")];
 const r=assessKeyinCoverage(mk(fields),options());
 assert.ok(r.structuralIssues.join(" ").includes("Dynamic field schema mismatch"));
});
test("an extra payment.plan field remains valid in the Auditor static parity check",()=>{
 const fields=[...standard(),shape("payment.plan","documents","text","Monthly")];
 const sections=[...mk().sections,{id:"documents"}];
 const r=assessKeyinCoverage(mk(fields,{sections}),{
  ...options(),expectedSections:sections});
 assert.deepEqual(r.structuralIssues,[]);
});
test("duplicate report section ID and unscoped mixed report fail closed",()=>{
 const sections=[
  {id:"same",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2},
  {id:"same",documentType:"DASH",presenceStatus:"FOUND",startPage:3,endPage:4},
  {documentType:"MVR",presenceStatus:"FOUND",startPage:5,endPage:6}
 ];
 const result=assessKeyinCoverage(mk(),options(standard(),[doc("mixed","MIXED",sections)]));
 assert.ok(result.structuralIssues.join(" ").includes("Duplicate physical report logical-section ID"));
 assert.ok(result.structuralIssues.join(" ").includes("Mixed report missing distinct logical-section ID"));
});
test("field evidence outside multi-section PDF page range is rejected",()=>{
 const sections=[
 {id:"r1",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2},
 {id:"r2",documentType:"DASH",presenceStatus:"FOUND",startPage:3,endPage:4}
 ];
 const fields=standard();fields[0].origin="EXTRACTED";
 fields[0].evidence=[{documentId:"doc1",sourceHash:sha,page:4,logicalDocumentId:"r1"}];
 const r=assessKeyinCoverage(mk(fields,{source_files:[{id:"doc1",sha256:sha}]}),
  options(fields,[doc("doc1","MIXED",sections)]));
 assert.ok(r.reconciliationIssues.join(" ").includes("outside its logical report"));
});
test("manual evidence in mixed physical PDF cannot omit logical document boundary",()=>{
 const sections=[
 {id:"r1",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2},
 {id:"r2",documentType:"DASH",presenceStatus:"FOUND",startPage:3,endPage:4}
 ];
 const fields=standard();fields[0].origin="MANUAL_FROM_SOURCE";
 fields[0].evidence=[{documentId:"doc1",sourceHash:sha,page:2}];
 const r=assessKeyinCoverage(mk(fields,{source_files:[{id:"doc1",sha256:sha}]}),
  options(fields,[doc("doc1","MIXED",sections)]));
 assert.ok(r.reconciliationIssues.join(" ").includes("no logical section in mixed PDF"));
});

// Acceptance regression: optional Case prior dates may be empty, never malformed.
// Required dates keep both the missing-field accounting and strict date typing.
for (const id of ["prior.start","prior.end"]) {
  const dateAudit=(value,required)=> {
    const field={...shape(id,"policy","date",value,{required}),value}; // Preserve explicit undefined; do not use shape's "ok" default.
    const fields=[...standard(),field];
    return assessKeyinCoverage(mk(fields),options(fields,[],{verifyRequired:true}));
  };
  test(`${id}: optional empty/default date is MISSING, not a type error`,()=>{
    for(const value of [""," \t\r\n",null,undefined]){
      const result=dateAudit(value,false);
      assert.deepEqual(result.fieldIssues,[],JSON.stringify(value));
      assert.equal(result.fields.find(f=>f.id===id).state,"MISSING");
      assert.equal(result.totals.requiredMissing,0);
    }
  });
  test(`${id}: optional valid ISO date is accepted`,()=>{
    for(const value of ["2024-02-29","2026-10-29"]){
      const result=dateAudit(value,false);
      assert.deepEqual(result.fieldIssues,[]);
      assert.notEqual(result.fields.find(f=>f.id===id).state,"MISSING");
    }
  });
  test(`${id}: optional nonblank invalid date or wrong type still fails`,()=>{
    for(const value of ["2026-02-29","2026-04-31","2026-13-01","not-a-date",
      "2026-10-29T00:00:00Z"," 2026-10-29 ",0,false,[],{}]){
      const result=dateAudit(value,false);
      assert(result.fieldIssues.some(s=>s.includes(id)),JSON.stringify(value));
    }
  });
  test(`${id}: required blank or absent dates remain requiredMissing`,()=>{
    for(const value of [""," \t",null,undefined]){
      const result=dateAudit(value,true);
      assert.equal(result.totals.requiredMissing,1);
      assert.equal(result.fields.find(f=>f.id===id).required,true);
      if(typeof value==="string")
        assert(result.fieldIssues.some(s=>s.includes(id)),"Required blank cannot take optional exemption.");
    }
  });
  test(`${id}: required malformed/non-string date stays blocking`,()=>{
    for(const value of ["2025-02-29","2026-04-31","n/a",false,42]){
      const result=dateAudit(value,true);
      assert(result.fieldIssues.some(s=>s.includes(id)));
    }
    const valid=dateAudit("2024-02-29",true);
    assert.deepEqual(valid.fieldIssues,[]);
    assert.equal(valid.totals.requiredMissing,0);
  });
}
test("optional-date exemption cannot weaken non-date value typing",()=>{
  for(const type of ["boolean","number","list","assignments","record","future-type"]){
    const fields=[...standard(),shape("synthetic.optional","policy",type,"",{required:false})];
    const result=assessKeyinCoverage(mk(fields),options(fields));
    assert(result.fieldIssues.some(s=>s.includes("synthetic.optional")),type);
  }
});
test("a date with omitted required metadata cannot take the optional exemption",()=>{
  const field=shape("synthetic.date","policy","date","");
  delete field.required;
  const fields=[...standard(),field];
  const result=assessKeyinCoverage(mk(fields),options(fields));
  assert(result.fieldIssues.some(s=>s.includes("synthetic.date")));
});

test.after(()=>rmSync(root,{recursive:true,force:true}));

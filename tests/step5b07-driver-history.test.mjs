import test from "node:test";
import assert from "node:assert/strict";
import {analyzeDriverHistory,driverHistorySectionIssues}
  from "../lib/step5b07-driver-history.mjs";

const H="e".repeat(64),L1="S12345678901234",L2="T98765432109876";
const persons=[
 {id:"driver-1",name:"Alex Chen",licence_number:L1,dateOfBirth:"1988-04-05"},
 {id:"driver-2",name:"Jordan Lee",licence_number:L2,dateOfBirth:"1991-11-20"}
];
const drivers=(a=persons)=>({case_id:"case-synthetic",drivers:a});
// Fixture pages have literal synthetic count statements. Evidence is copied
// from these statements, not fabricated from observation.page/pulledDate.page.
// Production never calls this test-only generator.
const makeSyntheticCountPage=(doc,type,data,logicalDocumentId)=>{
 const fieldEvidence={},lines=[];
 const keys=["reportedConvictionCount","convictionCount","convictionsCount",
  "reportedClaimCount","claimCount","claimsCount","reportedNoConvictions","reportedNoClaims"];
 const generate=(scope,label)=>{
  const local={};
  for(const key of keys){
   if(scope[key]===undefined||scope[key]===null)continue;
   const line=`${label}: ${key} = ${String(scope[key])}`;
   lines.push(line);
   local[key]=[{page:1,documentId:doc,logicalDocumentId,
    sourceHash:H,documentType:type,text:line}];
  }
  return local;
 };
 Object.assign(fieldEvidence,generate(data,"REPORT"));
 if(data.driver&&typeof data.driver==="object"){
  Object.assign(fieldEvidence,generate(data.driver,"DRIVER"));
 }
 if(Array.isArray(data.drivers))data.drivers.forEach((person,i)=>{
  if(person&&typeof person==="object")
   person.fieldEvidence={...(person.fieldEvidence||{}),
    ...generate(person,`DRIVER ${i+1}`)};
 });
 return {fieldEvidence,text:lines.join("\\n")};
};
const source=(doc,type,data,extra={})=>{
 const logicalDocumentId=extra.logicalDocumentId??`section-${doc}`;
 const proof=extra.syntheticCountEvidence===false?{fieldEvidence:{},text:""}:
   makeSyntheticCountPage(doc,type,data,logicalDocumentId);
 const configuredPages=extra.record?.packagePages;
 const physicalPages=Array.isArray(configuredPages)
  ? configuredPages.map(p=>p.page===1&&proof.text
    ? {...p,text:[p.text,proof.text].filter(Boolean).join("\\n")} : p)
  : [{page:1,text:proof.text,pageOcrStatus:"COMPLETED"}];
 return {
  record:{id:doc,sourceHash:H,documentType:type,
   ...extra.record,packagePages:physicalPages},
  hash:extra.hash??H,
  observation:{documentId:doc,documentType:type,logicalDocumentId,
   entityKind:extra.kind||"",subjectId:extra.subjectId??"",data,
   ...(extra.page===false?{}:{page:1}),
   ...extra.observation,
   fieldEvidence:{...proof.fieldEvidence,...extra.observation?.fieldEvidence}}
 };
};
const conviction=(ticket,page=2,more={})=>({ticketNumber:ticket,offenceDate:"2025-02-03",offence:"Speeding",page,...more});
const claim=(number,page=3,more={})=>({claimNumber:number,lossDate:"2024-04-09",amount:2000,page,...more});
const person=(who,over={})=>({
 sourceDriverId:who===1?"source-A":"source-B",
 fullName:who===1?"Alex Chen":"Jordan Lee",
 licenceNumber:who===1?L1:L2,page:1,
 ...over
});
const run=(sources,c=drivers())=>analyzeDriverHistory(c,sources);
const codes=r=>r.blockingIssues.map(x=>x.code);
const forDriver=(r,id)=>r.drivers.find(x=>x.caseDriverId===id);

test("2 drivers, 3 convictions and 3 claims across independent MVR/DASH reports",()=>{
 const mvr=source("mvr","MVR",{drivers:[
  person(1,{reportedConvictionCount:2,convictions:[conviction("T-1"),conviction("T-2",3)]}),
  person(2,{reportedConvictionCount:1,convictions:[conviction("T-3",4)]})
 ]});
 const dash=source("dash","DASH",{drivers:[
  person(1,{reportedClaimCount:1,claims:[claim("CL-1")]}),
  person(2,{reportedClaimCount:2,claims:[claim("CL-2"),claim("CL-3",4)]})
 ]});
 const r=run([mvr,dash]);
 assert.deepEqual(r.totals,{reports:2,convictionObservations:3,
  claimObservations:3,unassigned:0,blockingIssues:0});
 assert.deepEqual(forDriver(r,"driver-1").convictions.map(x=>x.facts.ticketNumber),["T-1","T-2"]);
 assert.deepEqual(forDriver(r,"driver-2").convictions.map(x=>x.facts.ticketNumber),["T-3"]);
 assert.deepEqual(forDriver(r,"driver-2").claims.map(x=>x.facts.claimNumber),["CL-2","CL-3"]);
 assert.equal(forDriver(r,"driver-1").convictions[0].source.page,2);
 assert.equal(forDriver(r,"driver-1").claims[0].source.documentId,"dash");
});
test("license normalization ignores hyphen and spaces but not different digits",()=>{
 const r=run([source("mvr","MVR",{
  driver:person(1,{licenceNumber:"S1234-56789 01234"}),
  convictions:[conviction("T-1")],reportedConvictionCount:1})]);
 assert.equal(r.totals.convictionObservations,1);
 assert.equal(r.totals.blockingIssues,0);
});
test("different drivers with the same legal name are matched by distinct licences",()=>{
 const c=drivers(persons.map(x=>({...x,name:"SAME NAME"})));
 const r=run([source("m","MVR",{drivers:[
  person(2,{fullName:"SAME NAME",reportedConvictionCount:1,convictions:[conviction("T2")]}),
  person(1,{fullName:"SAME NAME",reportedConvictionCount:1,convictions:[conviction("T1")]})
 ]})],c);
 assert.equal(forDriver(r,"driver-1").convictions[0].facts.ticketNumber,"T1");
 assert.equal(forDriver(r,"driver-2").convictions[0].facts.ticketNumber,"T2");
});
test("report order never assigns identity; unmatched third driver retained",()=>{
 const r=run([source("d","DASH",{drivers:[
  {fullName:"Unlisted",licenceNumber:"V12345678901234",page:1,
   reportedClaimCount:1,claims:[claim("UNKNOWN")]},
  person(2,{reportedClaimCount:1,claims:[claim("C2")]}),
  person(1,{reportedClaimCount:1,claims:[claim("C1")]})
 ]})]);
 assert.deepEqual(r.drivers.map(d=>d.claims.length),[1,1]);
 assert.equal(r.unassigned.length,1);
 assert.ok(codes(r).includes("UNMATCHED_CASE_DRIVER"));
});
test("name-only source cannot imply a driver, even when only one Case driver",()=>{
 const r=run([source("m","MVR",{driver:{name:"Alex Chen",page:1},
    convictions:[conviction("T1")],reportedConvictionCount:1})],
    drivers([persons[0]]));
 assert.equal(r.unassigned.length,1);
 assert.ok(codes(r).includes("UNMATCHED_CASE_DRIVER"));
});
test("name and DOB are sufficient only when unique and noncontradictory",()=>{
 const r=run([source("m","MVR",{driver:{fullName:"Jordan Lee",dob:"1991-11-20",page:1},
   convictions:[conviction("T1")],reportedConvictionCount:1})]);
 assert.equal(forDriver(r,"driver-2").convictions.length,1);
 assert.deepEqual(r.blockingIssues,[]);
});
test("duplicate licences in the Case are ambiguous, not arbitrarily first",()=>{
 const c=drivers([persons[0],{...persons[0],id:"duplicated"}]);
 const r=run([source("m","MVR",{driver:person(1),
   convictions:[conviction("T1")],reportedConvictionCount:1})],c);
 assert.ok(codes(r).includes("AMBIGUOUS_CASE_DRIVER"));
 assert.equal(r.totals.convictionObservations,0);
 assert.equal(r.unassigned.length,1);
});
test("licence conflict blocks a name+DOB corroboration match",()=>{
 const r=run([source("m","MVR",{driver:person(1,{licenceNumber:L2}),
  convictions:[conviction("T1")],reportedConvictionCount:1})]);
 assert.equal(r.unassigned.length,1);
 assert.equal(r.totals.convictionObservations,0);
});
test("unverified source hash cannot supply any events",()=>{
 const r=run([source("bad","MVR",{driver:person(1),
   convictions:[conviction("T1")],reportedConvictionCount:1},{hash:"broken"})]);
 assert.ok(codes(r).includes("UNVERIFIED_REPORT_SOURCE"));
 assert.equal(r.totals.convictionObservations,0);
});
test("hash mismatch between verified context and record cannot supply rows",()=>{
 const r=run([source("bad","DASH",{driver:person(1),claims:[claim("C1")]},
   {record:{sourceHash:"a".repeat(64)}})]);
 assert.ok(codes(r).includes("UNVERIFIED_REPORT_SOURCE"));
 assert.equal(r.totals.claimObservations,0);
});
test("unrelated auto quotes never become convictions/claims",()=>{
 const r=run([source("q","AUTO_QUOTE",{driver:person(1),
   convictions:[conviction("T1")],claims:[claim("C1")]})]);
 assert.equal(r.totals.reports,0);
 assert.equal(r.totals.blockingIssues,0);
});
test("same context repeated by ingestion is not counted twice",()=>{
 const s=source("m","MVR",{driver:person(1),
   convictions:[conviction("T1")],reportedConvictionCount:1});
 const r=run([s,s]);
 assert.equal(r.totals.convictionObservations,1);
 assert.equal(r.reports[0].sourceRows,1);
 assert.equal(r.totals.blockingIssues,0);
});
test("same ticket date can have two independent ticket IDs",()=>{
 const r=run([source("m","MVR",{driver:person(1),
   convictions:[conviction("T1"),conviction("T2")],reportedConvictionCount:2})]);
 assert.equal(r.totals.convictionObservations,2);
 assert.equal(r.totals.blockingIssues,0);
});
test("same claim number for two drivers is not collapsed across people",()=>{
 const r=run([source("d","DASH",{drivers:[
  person(1,{reportedClaimCount:1,claims:[claim("SAME")]}),
  person(2,{reportedClaimCount:1,claims:[claim("SAME")]})
 ]})]);
 assert.equal(r.totals.claimObservations,2);
 assert.equal(r.totals.blockingIssues,0);
});
test("same source-local driver ID in separate reports never leaks identity",()=>{
 const r=run([
  source("m1","MVR",{driver:person(1,{sourceDriverId:"local-1"}),
   convictions:[conviction("T1")],reportedConvictionCount:1}),
  source("m2","MVR",{driver:person(2,{sourceDriverId:"local-1"}),
   convictions:[conviction("T2")],reportedConvictionCount:1})
 ]);
 assert.equal(forDriver(r,"driver-1").convictions.length,1);
 assert.equal(forDriver(r,"driver-2").convictions.length,1);
 assert.equal(r.totals.blockingIssues,0);
});
test("flat report rows reference explicit document-local driver IDs",()=>{
 const r=run([source("d","DASH",{drivers:[person(1),person(2)],
   claims:[claim("B",4,{driverId:"source-B"}),claim("A",2,{driverId:"source-A"})],
   reportedClaimCount:2})]);
 assert.equal(forDriver(r,"driver-1").claims[0].facts.claimNumber,"A");
 assert.equal(forDriver(r,"driver-2").claims[0].facts.claimNumber,"B");
 assert.equal(r.totals.blockingIssues,0);
});
test("invalid local driver ID stays unmatched, not Case-ID fallback",()=>{
 const r=run([source("d","DASH",{drivers:[person(1),person(2)],
   claims:[claim("C",4,{driverId:"driver-1"})],reportedClaimCount:1})]);
 assert.ok(codes(r).includes("UNKNOWN_SOURCE_DRIVER_REF"));
 assert.ok(codes(r).includes("UNMATCHED_CASE_DRIVER"));
 assert.equal(r.unassigned.length,1);
});
test("nested row pointing at a different local person is contradictory",()=>{
 const r=run([source("d","DASH",{drivers:[
  person(1,{reportedClaimCount:1,claims:[claim("C",4,{driverId:"source-B"})]}),
  person(2)
 ]})]);
 assert.ok(codes(r).includes("CONFLICTING_SOURCE_DRIVER_IDENTITY"));
 assert.equal(r.totals.claimObservations,0);
});
test("explicit conviction count mismatch blocks review",()=>{
 const r=run([source("m","MVR",{driver:person(1),
   convictions:[conviction("T1")],reportedConvictionCount:3})]);
 assert.ok(codes(r).includes("REPORTED_COUNT_MISMATCH"));
});
test("reported no-claims zero is distinguished from missing claim data",()=>{
 const r=run([source("d","DASH",{driver:person(1),
   reportedNoClaims:true})]);
 assert.equal(r.totals.claimObservations,0);
 assert.equal(forDriver(r,"driver-1").reportedCounts[0].count,0);
 assert.equal(r.totals.blockingIssues,0);
});
test("false reported zero with a Claim is a blocking contradiction",()=>{
 const r=run([source("d","DASH",{driver:person(1),
   reportedClaimCount:0,claims:[claim("C1")]})]);
 assert.ok(codes(r).includes("REPORTED_COUNT_MISMATCH"));
 assert.ok(codes(r).includes("CONTRADICTORY_REPORTED_ZERO"));
});
test("missing count cannot be rewritten as zero or declared complete",()=>{
 const r=run([source("d","DASH",{driver:person(1),claims:[]})]);
 assert.equal(forDriver(r,"driver-1").reportedCounts.length,0);
 assert.ok(codes(r).includes("REPORT_COMPLETENESS_UNRECORDED"));
});
test("missing claim page is retained with missing-provenance blocker",()=>{
 const r=run([source("d","DASH",{driver:person(1,{page:undefined}),
   claims:[{claimNumber:"C1",lossDate:"2024-01-02"}],reportedClaimCount:1},{page:false,syntheticCountEvidence:false})]);
 assert.equal(r.totals.claimObservations,1);
 assert.ok(codes(r).includes("MISSING_EVENT_PAGE"));
 assert.ok(codes(r).includes("MISSING_REPORTED_COUNT_PAGE"));
});
test("failed OCR or PDF page forces source completeness review",()=>{
 const r=run([source("m","MVR",{driver:person(1),convictions:[],
   reportedConvictionCount:0},{record:{packagePages:[
    {page:1,pageOcrStatus:"COMPLETED"},{page:2,pageOcrStatus:"OCR_FAILED"}
   ]}})]);
 assert.ok(codes(r).includes("UNREADABLE_REPORT_PAGE"));
});
test("failed OCR of unrelated mixed PDF section does not block MVR's section",()=>{
 const r=run([source("mixed","MVR",{driver:person(1),convictions:[],
   reportedConvictionCount:0},{logicalDocumentId:"section-m",
   record:{documentType:"MIXED",logicalDocuments:[
    {id:"section-m",startPage:1,endPage:1},
    {id:"section-application",startPage:2,endPage:2}
   ],packagePages:[
    {page:1,pageOcrStatus:"COMPLETED"},
    {page:2,pageOcrStatus:"OCR_FAILED"}
   ]}})]);
 assert.equal(codes(r).includes("UNREADABLE_REPORT_PAGE"),false);
});
test("different reports with same ticket but incompatible facts are both kept and conflict",()=>{
 const a=source("a","MVR",{driver:person(1),
  convictions:[conviction("T1",2,{offence:"Speeding"})],reportedConvictionCount:1});
 const b=source("b","MVR",{driver:person(1),
  convictions:[conviction("T1",2,{offence:"Careless driving"})],reportedConvictionCount:1});
 const r=run([a,b]);
 assert.equal(r.totals.convictionObservations,2);
 assert.ok(codes(r).includes("CROSS_REPORT_EVENT_CONFLICT"));
});
test("supplementary report missing details is not itself a contradictory value",()=>{
 const a=source("a","DASH",{driver:person(1),
  claims:[claim("C1",2,{status:"CLOSED"})],reportedClaimCount:1});
 const b=source("b","DASH",{driver:person(1),
  claims:[{claimNumber:"C1",page:2}],reportedClaimCount:1});
 const r=run([a,b]);
 assert.equal(r.totals.claimObservations,2);
 assert.equal(codes(r).includes("CROSS_REPORT_EVENT_CONFLICT"),false);
});
test("different logical sections of the same document remain distinct source reports",()=>{
 const a=source("combo","MVR",{driver:person(1),
  convictions:[conviction("T1")],reportedConvictionCount:1},{logicalDocumentId:"section-A"});
 const b=source("combo","MVR",{driver:person(2),
  convictions:[conviction("T2")],reportedConvictionCount:1},{logicalDocumentId:"section-B"});
 const r=run([a,b]);
 assert.equal(r.totals.reports,2);
 assert.equal(r.totals.convictionObservations,2);
 assert.deepEqual(r.blockingIssues,[]);
});
test("same explicit source item ID with inconsistent content is a conflict",()=>{
 const r=run([source("m","MVR",{driver:person(1),convictions:[
   conviction("A",2,{sourceRowId:"ROW-1"}),conviction("B",3,{sourceRowId:"ROW-1"})],
   reportedConvictionCount:2})]);
 assert.ok(codes(r).includes("DUPLICATE_EVENT_ID_CONFLICT"));
});
test("parsed row pages can be sourced from fieldEvidence without positional driver matching",()=>{
 const s=source("d","DASH",{driver:person(1),
  claims:[{claimNumber:"C1"}],reportedClaimCount:1});
 s.observation.fieldEvidence={claims:[{page:5}]};
 const r=run([s]);
 assert.equal(forDriver(r,"driver-1").claims[0].source.page,5);
 assert.equal(codes(r).includes("MISSING_EVENT_PAGE"),false);
});
test("untrusted user-origin Case IDs do not replace evidence identity",()=>{
 const r=run([source("m","MVR",{driver:{caseDriverId:"driver-1",page:1},
  convictions:[conviction("T1")],reportedConvictionCount:1})]);
 assert.equal(r.totals.convictionObservations,0);
 assert.ok(codes(r).includes("UNMATCHED_CASE_DRIVER"));
});
test("review section gate blocks all confirmations for unresolved evidence",()=>{
 const r=run([source("d","DASH",{driver:person(1),claims:[]})]);
 const message=driverHistorySectionIssues({driver_history_integrity:r},"coverage");
 assert.equal(message.length,1);
 assert.match(message[0],/needs source reconciliation/i);
 assert.equal(driverHistorySectionIssues({driver_history_integrity:{blockingIssues:[]}},"drivers").length,0);
 assert.equal(driverHistorySectionIssues({},"drivers").length,0);
});
test("serialised integrity ledger does not echo driver's licence or date of birth",()=>{
 const r=run([source("m","MVR",{driver:person(1),convictions:[conviction("T1")],reportedConvictionCount:1})]);
 const json=JSON.stringify(r);
 assert.ok(!json.includes(L1));
 assert.ok(!json.includes("1988-04-05"));
});

test("entity DRIVER + CONVICTION rows use only verified local linkage and retain all entries",()=>{
 const d=source("m","MVR",{...person(1,{reportedConvictionCount:2})},
  {kind:"DRIVER",subjectId:"source-A",observation:{page:1}});
 const c1=source("m","MVR",{...conviction("T-1",2),driverId:"source-A"},
  {kind:"CONVICTION",subjectId:"conviction-1",observation:{page:2}});
 const c2=source("m","MVR",{...conviction("T-2",3),driverId:"source-A"},
  {kind:"CONVICTION",subjectId:"conviction-2",observation:{page:3}});
 const r=run([d,c1,c2]);
 assert.deepEqual(forDriver(r,"driver-1").convictions.map(x=>x.facts.ticketNumber),["T-1","T-2"]);
 assert.equal(r.totals.blockingIssues,0);
});
test("duplicate document-local driver IDs make an event ambiguous",()=>{
 const r=run([source("m","MVR",{drivers:[
  person(1,{sourceDriverId:"same"}),
  person(2,{sourceDriverId:"same"})
 ],convictions:[conviction("T",2,{driverId:"same"})],reportedConvictionCount:1})]);
 assert.equal(r.totals.convictionObservations,0);
 assert.ok(codes(r).includes("SOURCE_DRIVER_ID_COLLISION"));
 assert.ok(codes(r).includes("AMBIGUOUS_SOURCE_DRIVER_REF"));
});
test("unknown parser history keys block rather than silently drop claimHistory",()=>{
 const r=run([source("d","DASH",{driver:person(1),claimHistory:[
  {claimNumber:"NOT IN SUPPORTED SCHEMA"}
 ],reportedClaimCount:0})]);
 // The legacy 'claimHistory' format needs a reviewed schema adapter.
 // The reported zero alone cannot greenlight an unparsed alternative array.
 assert.ok(codes(r).includes("UNSUPPORTED_HISTORY_FIELD"));
});
test("no fabricated person-0 link is permitted for anonymous nested drivers",()=>{
 const r=run([source("d","DASH",{drivers:[
  {name:"Alex Chen",licenceNumber:L1,page:1},
  {name:"Jordan Lee",licenceNumber:L2,page:1}
 ],claims:[claim("C1",2,{driverId:"person-0"})],reportedClaimCount:1})]);
 assert.equal(r.totals.claimObservations,0);
 assert.ok(codes(r).includes("UNKNOWN_SOURCE_DRIVER_REF"));
});
test("report count is invalid when supplied as a non-numeric OCR string",()=>{
 const r=run([source("m","MVR",{driver:person(1),
  convictions:[conviction("T1")],reportedConvictionCount:"many"})]);
 assert.ok(codes(r).includes("INVALID_REPORTED_COUNT"));
 assert.ok(codes(r).includes("REPORT_COMPLETENESS_UNRECORDED"));
});

test("rows nested inside data.driver are not dropped by a blank report wrapper",()=>{
 const r=run([source("m","MVR",{
  driver:person(1,{convictions:[conviction("T-nested")],reportedConvictionCount:1})
 })]);
 assert.equal(r.totals.convictionObservations,1);
 assert.equal(r.totals.blockingIssues,0);
});
test("contradictory nested vs root event arrays preserve both and block",()=>{
 const r=run([source("m","MVR",{
  driver:person(1,{convictions:[conviction("T-inner")]}),
  convictions:[conviction("T-outer",3)],reportedConvictionCount:2
 })]);
 assert.equal(r.totals.convictionObservations,2);
 assert.ok(codes(r).includes("CONFLICTING_REPORT_COLLECTIONS"));
});

test("mixed PDF without a logical section cannot silently merge MVR history",()=>{
 const r=run([source("mixed","MVR",{driver:person(1),
   convictions:[conviction("T1")],reportedConvictionCount:1},{
    logicalDocumentId:"",
    record:{documentType:"MIXED",logicalDocuments:[
      {id:"MVR-1"},{id:"DASH-2"}
    ]}
 })]);
 assert.equal(r.totals.convictionObservations,0);
 assert.ok(codes(r).includes("MISSING_LOGICAL_DOCUMENT_BOUNDARY"));
});


// Actual MVR parser contract: counts are located by fieldEvidence, not by
// data.page/observation.page. These fixtures intentionally omit both.
const verifiedCount=(doc,type,key,count,page=2,more={})=>{
 const data={driver:person(1,{page:undefined}),[key]:count,
  [type==="MVR"?"convictions":"claims"]:[]};
 const observation={page:undefined,fieldEvidence:{
  [key]:[{page,documentId:doc,logicalDocumentId:`section-${doc}`,
   sourceHash:H,documentType:type,
   text:`${key} = ${count}`,...more}]
 }};
 return source(doc,type,data,{page:false,syntheticCountEvidence:false,observation,
  record:{packagePages:[{page,text:`${key} = ${count}`,pageOcrStatus:"COMPLETED"}]}});
};
test("actual MVR zero: count-only fieldEvidence page works without observation.page",()=>{
 const s=verifiedCount("mvr-exact","MVR","reportedConvictionCount",0,4);
 const r=run([s]);
 assert.deepEqual(r.blockingIssues,[]);
 assert.equal(forDriver(r,"driver-1").reportedCounts[0].page,4);
 assert.equal(forDriver(r,"driver-1").reportedCounts[0].coverageScope,"REPORT_ONLY");
});
test("actual DASH zero: exact reportedClaimCount evidence page is recognized",()=>{
 const r=run([verifiedCount("dash-exact","DASH","reportedClaimCount",0,7)]);
 assert.deepEqual(r.blockingIssues,[]);
 assert.equal(forDriver(r,"driver-1").reportedCounts[0].page,7);
 assert.equal(forDriver(r,"driver-1").reportedCounts[0].coverageScope,"REPORT_ONLY");
});
test("single explicit proof may have repeated supporting fragments on the SAME page",()=>{
 const s=verifiedCount("repeat","MVR","reportedConvictionCount",0,3);
 s.observation.fieldEvidence.reportedConvictionCount.push({
  ...s.observation.fieldEvidence.reportedConvictionCount[0],text:"No convictions found"});
 assert.deepEqual(codes(run([s])),[]);
});
test("pulledDate evidence and generic driver/observation page do not prove count page",()=>{
 const s=source("generic","MVR",{driver:person(1,{page:1}),
  reportedConvictionCount:0,convictions:[],page:1},
  {syntheticCountEvidence:false});
 s.observation.fieldEvidence={pulledDate:[{page:1,sourceHash:H}]};
 assert.ok(codes(run([s])).includes("MISSING_REPORTED_COUNT_PAGE"));
});
test("DASH generic observation page does not prove zero-claims declaration",()=>{
 const s=source("dash-generic","DASH",{
  driver:person(1),reportedClaimCount:0,claims:[],page:1},
  {syntheticCountEvidence:false});
 assert.ok(codes(run([s])).includes("MISSING_REPORTED_COUNT_PAGE"));
});
test("explicit reportedNoClaims=true also needs evidence for that EXACT key",()=>{
 const s=source("dash-no","DASH",{driver:person(1),reportedNoClaims:true},
  {syntheticCountEvidence:false});
 s.observation.fieldEvidence={pulledDate:[{page:1}]};
 assert.ok(codes(run([s])).includes("MISSING_REPORTED_COUNT_PAGE"));
 s.observation.fieldEvidence.reportedNoClaims=[{page:1,sourceHash:H}];
 assert.deepEqual(codes(run([s])),[]);
});
test("conflicting MVR count evidence pages fail closed even if one page matches observation",()=>{
 const s=verifiedCount("mvr-conflict","MVR","reportedConvictionCount",0,2);
 s.record.packagePages.push({page:3,text:"contradictory count location"});
 s.observation.page=2;
 s.observation.fieldEvidence.reportedConvictionCount.push({page:3,
  documentId:"mvr-conflict",logicalDocumentId:"section-mvr-conflict",sourceHash:H});
 const r=run([s]);
 assert.ok(codes(r).includes("CONFLICTING_REPORTED_COUNT_PAGE"));
 assert.ok(codes(r).includes("MISSING_REPORTED_COUNT_PAGE"));
});
test("conflicting DASH count evidence pages fail closed",()=>{
 const s=verifiedCount("dash-conflict","DASH","reportedClaimCount",0,2);
 s.record.packagePages.push({page:5,text:"second count proof"});
 s.observation.fieldEvidence.reportedClaimCount.push({page:5});
 assert.ok(codes(run([s])).includes("CONFLICTING_REPORTED_COUNT_PAGE"));
});
test("empty, malformed or non-physical page cannot use generic observation fallback",()=>{
 for(const bad of [[],[{page:0}],[{page:-1}],[{page:"two"}],[{}]]){
  const s=verifiedCount("bad-page","MVR","reportedConvictionCount",0,2);
  s.observation.page=2;
  s.observation.fieldEvidence.reportedConvictionCount=bad;
  assert.ok(codes(run([s])).includes("MISSING_REPORTED_COUNT_PAGE"));
 }
});
test("a count page cannot belong to a different physical document or source hash",()=>{
 for(const extra of [{documentId:"other"},
  {sourceHash:"a".repeat(64)},{hash:"a".repeat(64)},
  {documentType:"DASH"}]){
  const s=verifiedCount("wrong-source","MVR","reportedConvictionCount",0,2,extra);
  assert.ok(codes(run([s])).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
 }
});
test("verified source record hash is mandatory even if context hash looks valid",()=>{
 const s=verifiedCount("unhashed","MVR","reportedConvictionCount",0,2);
 delete s.record.sourceHash;
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORT_SOURCE"));
});
test("a mixed PDF count page must be inside the matching logical MVR section",()=>{
 const record={documentType:"MIXED",logicalDocuments:[
  {id:"mvr-1",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:3},
  {id:"dash-1",documentType:"DASH",presenceStatus:"FOUND",startPage:4,endPage:6}
 ],packagePages:[{page:2,text:"MVR 0 convictions"},{page:5,text:"DASH 0 claims"}]};
 const s=source("mixed-count","MVR",{driver:person(1,{page:undefined}),
  reportedConvictionCount:0,convictions:[]},{
  logicalDocumentId:"mvr-1",syntheticCountEvidence:false,page:false,record,
  observation:{page:undefined,fieldEvidence:{
   reportedConvictionCount:[{page:2,documentId:"mixed-count",
     logicalDocumentId:"mvr-1",sourceHash:H}]
  }}
 });
 assert.deepEqual(codes(run([s])),[]);
 s.observation.fieldEvidence.reportedConvictionCount[0].page=5;
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});
test("mixed PDF count evidence with another logicalDocumentId is rejected",()=>{
 const s=source("mixed-source","DASH",{driver:person(1),
  reportedClaimCount:0,claims:[]},{
  logicalDocumentId:"d-sec",syntheticCountEvidence:false,
  record:{documentType:"MIXED",logicalDocuments:[
   {id:"m-sec",documentType:"MVR",presenceStatus:"FOUND",startPage:1,endPage:2},
   {id:"d-sec",documentType:"DASH",presenceStatus:"FOUND",startPage:3,endPage:4}
  ],packagePages:[{page:3,text:"0 claims"}]},
  observation:{fieldEvidence:{reportedClaimCount:[{page:3,logicalDocumentId:"m-sec"}]}}
 });
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});
test("withdrawn report section never supplies a DASH count",()=>{
 const s=source("withdrawn","DASH",{driver:person(1),
  claims:[],reportedClaimCount:0},{
  logicalDocumentId:"d-sec",record:{documentType:"MIXED",
   logicalDocuments:[{id:"d-sec",documentType:"DASH",
    presenceStatus:"FOUND",startPage:1,endPage:2}],
   withdrawnSectionRanges:[{startPage:1,endPage:2}]}
 });
 const r=run([s]);
 assert.ok(codes(r).includes("WITHDRAWN_REPORT_SECTION"));
 assert.equal(r.totals.reports,0);
});
test("withdrawn physical page rejects count proof, even in a plain MVR",()=>{
 const s=verifiedCount("page-revoked","MVR","reportedConvictionCount",0,2);
 s.record.withdrawnSectionRanges=[{startPage:2,endPage:2}];
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});
test("DASH last-six-years zero is not full-history zero-claims proof",()=>{
 const s=verifiedCount("six-years","DASH","reportedClaimCount",0,2,
  {sourceText:"Zero claims in the last six years"});
 const r=run([s]);
 assert.ok(codes(r).includes("LIMITED_LOOKBACK_CLAIM_COUNT"));
 assert.ok(r.totals.blockingIssues>0);
});
test("unknown DASH claim count cannot become a zero from an empty claims array",()=>{
 const r=run([source("unknown-dash","DASH",{driver:person(1),claims:[]},
  {syntheticCountEvidence:false})]);
 assert.ok(codes(r).includes("REPORT_COMPLETENESS_UNRECORDED"));
 assert.equal(forDriver(r,"driver-1").reportedCounts.length,0);
});

test("duplicate logical-section IDs cannot choose an arbitrary physical range",()=>{
 const s=verifiedCount("duplicate-section","MVR","reportedConvictionCount",0,2);
 s.record.logicalDocuments=[
  {id:"section-duplicate-section",documentType:"MVR",presenceStatus:"FOUND",
   startPage:1,endPage:2},
  {id:"section-duplicate-section",documentType:"MVR",presenceStatus:"FOUND",
   startPage:3,endPage:5}
 ];
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORT_SECTION"));
});
test("observation document ID cannot misbind a verified record",()=>{
 const s=verifiedCount("doc-id","MVR","reportedConvictionCount",0,2);
 s.observation.documentId="different-document-id";
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORT_SOURCE"));
});

test("one evidence row with contradictory page/pageNumber is rejected",()=>{
 const s=verifiedCount("same-row","MVR","reportedConvictionCount",0,2);
 s.observation.fieldEvidence.reportedConvictionCount[0].pageNumber=3;
 assert.ok(codes(run([s])).includes("CONFLICTING_REPORTED_COUNT_PAGE"));
});
test("count proof referring to an absent physical page fails inventory validation",()=>{
 const s=verifiedCount("missing-physical","DASH","reportedClaimCount",0,2);
 s.record.packagePages=[{page:1,text:"No count exists on the cited page"}];
 assert.ok(codes(run([s])).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});
test("nested count evidence cannot conflict with report-level fieldEvidence",()=>{
 const s=verifiedCount("conflict-levels","MVR","reportedConvictionCount",0,2);
 s.observation.data.driver.fieldEvidence={
  reportedConvictionCount:[{page:3,sourceHash:H}]};
 assert.ok(codes(run([s])).includes("CONFLICTING_REPORTED_COUNT_PAGE"));
});

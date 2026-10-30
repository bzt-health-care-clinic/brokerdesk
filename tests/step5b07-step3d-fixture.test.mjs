import test from "node:test";
import assert from "node:assert/strict";
import {bindSyntheticZeroHistoryProof}
 from "./fixtures/step3d-history-zero-count-proof.mjs";
import {analyzeDriverHistory} from "../lib/step5b07-driver-history.mjs";

const HASH="d".repeat(64);
const driver={id:"driver-1",name:"Synthetic Driver",licence_number:"S12345678901234"};
const ctx=(id,type,key,line,page=2)=>({
 record:{id,documentType:type,sourceHash:HASH,packagePages:[
  {page:1,text:"MVR/DASH pull date: 2026-10-29"},
  {page,text:line,pageOcrStatus:"COMPLETED"}]},
 hash:HASH,
 observation:{documentId:id,logicalDocumentId:`section-${id}`,documentType:type,
  data:{driver:{fullName:"Synthetic Driver",licenceNumber:driver.licence_number},
   [key]:0,[type==="MVR"?"convictions":"claims"]:[]},
  fieldEvidence:{pulledDate:[{page:1}]}}
});
test("Step 3D-style MVR 0 convictions uses an actual synthetic count text page",()=>{
 const src=bindSyntheticZeroHistoryProof(ctx("mvr","MVR","reportedConvictionCount",
  "TOTAL REPORTED CONVICTIONS: 0"),{key:"reportedConvictionCount",page:2});
 const r=analyzeDriverHistory({drivers:[driver]},[src]);
 assert.deepEqual(r.blockingIssues,[]);
 assert.equal(r.drivers[0].reportedCounts[0].page,2);
});
test("Step 3D-style DASH 0 claims requires explicit entire-report count text",()=>{
 const src=bindSyntheticZeroHistoryProof(ctx("dash","DASH","reportedClaimCount",
  "TOTAL REPORTED CLAIMS (ENTIRE REPORT): 0"),{key:"reportedClaimCount",page:2});
 const r=analyzeDriverHistory({drivers:[driver]},[src]);
 assert.deepEqual(r.blockingIssues,[]);
 assert.equal(r.drivers[0].reportedCounts[0].page,2);
});
test("Step 3D older pulledDate page never stands in for missing count proof",()=>{
 const s=ctx("missing","DASH","reportedClaimCount","Not an explicit count line");
 const r=analyzeDriverHistory({drivers:[driver]},[s]);
 assert.ok(r.blockingIssues.some(i=>i.code==="MISSING_REPORTED_COUNT_PAGE"));
 assert.throws(()=>bindSyntheticZeroHistoryProof(s,{key:"reportedClaimCount",page:2}),
  /must contain/);
});
test("Step 3D synthetic last-six-years zero cannot certify all history",()=>{
 const s=ctx("limited","DASH","reportedClaimCount",
  "Claims during last six years: 0");
 assert.throws(()=>bindSyntheticZeroHistoryProof(s,{key:"reportedClaimCount",page:2}),
  /must contain/);
});
test("Step 3D synthetic helper rejects default/missing page, wrong hash and section",()=>{
 const s=ctx("invalid","MVR","reportedConvictionCount",
  "TOTAL REPORTED CONVICTIONS: 0");
 assert.throws(()=>bindSyntheticZeroHistoryProof(s,{key:"reportedConvictionCount"}),
  /Explicit physical page/);
 assert.throws(()=>bindSyntheticZeroHistoryProof({...s,hash:"b".repeat(64)},
  {key:"reportedConvictionCount",page:2}),/SHA-256/);
 s.record.logicalDocuments=[{id:"other",documentType:"MVR",
  presenceStatus:"FOUND",startPage:2,endPage:2}];
 assert.throws(()=>bindSyntheticZeroHistoryProof(s,{key:"reportedConvictionCount",page:2}),
  /active logical/);
});

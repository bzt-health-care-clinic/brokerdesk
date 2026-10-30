import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifiedReviewDocuments,buildExplicitReviewCandidates}
  from "../local-server/broker-review-source.mjs";
import {deriveStep3eOptions}
  from "../local-server/broker-review-step3e-options.mjs";
import {analyzeVehicleSourceConflicts}
  from "../lib/step5b06-vehicle-isolation.mjs";
import {createBrokerReview,sectionIssues,editBrokerReviewField}
  from "../lib/broker-keyin-review.mjs";

const VIN="1A2B3C4D5E6F7G8H9";
const VIN2="2B3C4D5E6F7G8H9J";
const claimName="Synthetic Driver";
const caseData=(vehicles)=>({
 case_id:"synthetic-case",case_type:"new_auto",
 policy:{company:"Intact",mailing_address:"100 TEST ST"},
 insured:{name:"Synthetic Insured"},
 vehicles,drivers:[{id:"driver-a",name:claimName,licence_number:"SYNTH-1234567"}],
 documents:[],coverage:{}
});
const e=(id,vin,excluded,data={})=>({kind:"VEHICLE",id,excluded,
  label:`Vehicle ${id}`,data:{vin,...data},fieldEvidence:{}});
const context=(vehicle,docId)=>({
 record:{id:docId},hash:"f".repeat(64),observation:{
  documentId:docId,documentType:"AUTO_QUOTE",
  entityKind:"VEHICLE",subjectType:"VEHICLE",subjectId:vehicle.id,
  logicalDocumentId:"sec-"+docId,data:vehicle.data,fieldEvidence:{}
 }
});
function verifiedSources(entities){
 const folder=mkdtempSync(join(tmpdir(),"broker-step5b06-"));
 const file=join(folder,"synthetic-quote.bin");
 writeFileSync(file,"Synthetic PDF source fixture bytes.","utf8");
 const hash=createHash("sha256").update("Synthetic PDF source fixture bytes.").digest("hex");
 const record={id:"doc-1",documentType:"AUTO_QUOTE",sourceHash:hash,
   logicalDocuments:[],parsedSources:[{documentId:"doc-1",documentType:"AUTO_QUOTE",
   data:{},fieldEvidence:{},entities}],state:"PARSED"};
 const repo={listDocuments:()=>[record],documentPath:()=>({path:file})};
 return {docs:verifiedReviewDocuments(repo,"synthetic-case"),close:()=>rmSync(folder,{recursive:true,force:true})};
}
test("real verifiedReviewDocuments exposes Active only when Excluded shares VIN",()=>{
 const pack=verifiedSources([
  e("excluded-1",VIN,true,{annualKm:88000,liability:900000}),
  e("excluded-2",VIN,true,{annualKm:74000,liability:700000}),
  e("active",VIN,false,{annualKm:15000,liability:2000000,
     dcpdDeductible:500,
     coverages:[{name:"All Perils",value:"$1,000"}]})
 ]);
 try{
  const originals=pack.docs.sources.filter(c=>c.observation.entityKind==="VEHICLE");
  assert.equal(originals.length,1);
  assert.equal(originals[0].observation.data.annualKm,15000);
  const item=caseData([{id:"car-a",vin:VIN}]);
  const opts=deriveStep3eOptions(item,pack.docs);
  assert.equal(opts.coverageByVehicle["car-a"].liability,2000000);
  assert.equal(opts.coverageByVehicle["car-a"].dcpdDeductible,500);
  assert.equal(opts.coverageByVehicle["car-a"].allPerils.deductible,1000);
  const review=createBrokerReview(item,{...opts,sourceFiles:pack.docs.verified});
  assert.equal(review.fields.find(f=>f.id==="vehicle:car-a.liability").value,2000000);
  assert.equal(review.fields.find(f=>f.id==="vehicle:car-a.dcpdDeductible").value,500);
  assert.equal(review.fields.filter(f=>f.id.endsWith(".vin")).length,1);
 } finally {pack.close();}
});
test("two active sources with same VIN conflicting coverage fail section review",()=>{
 const item=caseData([{id:"car-a",vin:VIN}]);
 const contexts=[
 context(e("source-a",VIN,false,{liability:1000000,
   coverages:[{name:"#20",value:"Yes"}],declaredOperators:["Synthetic Driver (Prn)"]}),"doc-a"),
 context(e("source-b",VIN,false,{liability:2000000,
   coverages:[{name:"#20",value:"Yes"},{name:"#44",value:"Yes"}],
   declaredOperators:["Synthetic Driver (Occ)"]}),"doc-b")
 ];
 const resolved=analyzeVehicleSourceConflicts(item,contexts);
 const options={coverageByVehicle:{"car-a":{liability:2000000,opcf:["20","44"]}},
  conflictingFieldIds:resolved.conflictingFieldIds};
 const review=createBrokerReview(item,options);
 for (const key of ["liability","opcf","driverAssignments"]) {
   const f=review.fields.find(f=>f.id===`vehicle:car-a.${key}`);
   assert.equal(f?.conflict,true,`missing conflict for ${key}`);
   assert.equal(f?.value,null);
 }
 assert.ok(sectionIssues(review,"coverage").some(issue=>/Unresolved source conflict/.test(issue)));
 const fixed=editBrokerReviewField(review,"vehicle:car-a.liability",1000000,{actor:"SYNTHETIC-BROKER"});
 assert.equal(fixed.fields.find(f=>f.id==="vehicle:car-a.liability").conflict,false);
 assert.equal(fixed.fields.find(f=>f.id==="vehicle:car-a.opcf").conflict,true);
});
test("two distinct active VINs keep separate coverage/deductibles",()=>{
 const item=caseData([{id:"car-a",vin:VIN},{id:"car-b",vin:VIN2}]);
 const sources=[
 context(e("a",VIN,false,{liability:1000000,
     coverages:[{name:"Collision",value:"500"}]}),"doc-a"),
 context(e("b",VIN2,false,{liability:2000000,
     coverages:[{name:"Collision",value:"1000"}]}),"doc-b")
 ];
 const options=deriveStep3eOptions(item,{sources,records:[],verified:[]});
 assert.equal(options.coverageByVehicle["car-a"].collision.deductible,500);
 assert.equal(options.coverageByVehicle["car-b"].collision.deductible,1000);
 assert.deepEqual(analyzeVehicleSourceConflicts(item,sources).conflictingFieldIds,[]);
});


import {parseAppliedRating} from "../lib/applied-rating-parser.ts";

function syntheticAppliedPage(){
  const blocks=[];
  const add=(text,x,y)=>blocks.push({
    text,boundingBox:{x,y,width:Math.max(45,text.length*5),height:10},confidence:.99
  });
  const vinValues=[VIN,VIN2,VIN2], kms=[44000,99000,14000],
    liabilities=[700000,750000,2000000];
  for(let i=0;i<3;i++){
    const top=i*240;
    add(`Vehicle ${i+1} of 3 | Synthetic ${i<2?"Excluded":"Rated"}`,20,top);
    add(vinValues[i],30,top+36);add("VIN",30,top+49);
    add(String(kms[i]),30,top+81);add("Annual km",30,top+94);
    add("Coverages",30,top+125);
    add(`Bodily Injury ($${liabilities[i]})`,30,top+148);
    add(`All Perils ($${i===2?"1000":"500"})`,30,top+166);
  }
  return {page:2,pageNumber:2,text:"Applied Rating Services\nSynthetic Quote",
    width:900,height:900,blocks,confidence:.99};
}
test("actual Applied geometry parser preserves 3 source groups and excluded status",()=>{
 const result=parseAppliedRating({text:"Applied Rating Services",
   pages:[syntheticAppliedPage()],metadata:{fileId:"synthetic-applied"}},
   "AUTO_QUOTE");
 assert.ok(result);
 const groups=result.entities?.filter(e=>e.kind==="VEHICLE")??[];
 assert.equal(groups.length,3);
 assert.deepEqual(groups.map(e=>e.excluded),[true,true,false]);
 assert.equal(groups[1].data.vin,groups[2].data.vin);
 assert.equal(groups[2].data.annualKm,14000);
 assert.notEqual(groups[1].data.annualKm,groups[2].data.annualKm);
 assert.equal(groups[2].data.liability,2000000);
});

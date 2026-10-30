import test from "node:test";
import assert from "node:assert/strict";
import {analyzeVehicleSourceConflicts,classifySourceVehicleObservations}
 from "../lib/step5b06-vehicle-isolation.mjs";
const VIN1="1A2B3C4D5E6F7G8H9";
const VIN2="2B3C4D5E6F7G8H9J";
const c=(id,vin)=>({id,vin});
const case1={vehicles:[c("active-1",VIN1)]};
const source=(documentId,data,extra={})=>({
 record:{id:documentId},hash:"synthetic-sha256",observation:{
  documentId,documentType:"AUTO_QUOTE",entityKind:"VEHICLE",subjectType:"VEHICLE",
  subjectId:"synthetic-"+documentId,logicalDocumentId:"auto-section",
  data,...extra}});
const excluded=(vin,annualKm)=>({kind:"VEHICLE",id:"excluded",
  excluded:true,data:{vin,annualKm}});
test("three parsed source vehicles remain separate: two excluded, one active",()=>{
 const separated=classifySourceVehicleObservations([{
  documentId:"quote",logicalDocumentId:"auto-section",
  entities:[excluded(VIN1,95000),excluded(VIN2,35000),
    {kind:"VEHICLE",id:"active",excluded:false,data:{vin:VIN1,annualKm:15000}}]
 }]);
 assert.equal(separated.active.length,1);
 assert.equal(separated.excluded.length,2);
 assert.equal(separated.active[0].data.annualKm,15000);
});
test("same VIN excluded + active does not create conflict",()=>{
 const sources=[source("excluded",{vin:VIN1,annualKm:75000,liability:700000},
     {excluded:true}),source("active",{vin:VIN1,annualKm:15000,liability:2000000})];
 const result=analyzeVehicleSourceConflicts(case1,sources);
 assert.deepEqual(result.conflictingFieldIds,[]);
 assert.equal(result.observedActive,1);
 assert.equal(result.ignoredExcluded,1);
});
test("conflicting active Annual KM and liability require resolution",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("q1",{vin:VIN1,annualKm:10000,liability:1000000}),
  source("q2",{vin:VIN1,annualKm:23000,liability:2000000})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.annualKm"));
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.liability"));
});
test("different active VINs keep separate Coverage even when values differ",()=>{
 const out=analyzeVehicleSourceConflicts({vehicles:[c("a",VIN1),c("b",VIN2)]},[
  source("q1",{vin:VIN1,annualKm:12000,liability:1000000}),
  source("q2",{vin:VIN2,annualKm:18000,liability:2000000}),
 ]);
 assert.deepEqual(out.conflictingFieldIds,[]);
});
test("different DCPD deductible is detected for same active vehicle",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("a",{vin:VIN1,dcpdDeductible:0}),
  source("b",{vin:VIN1,dcpdDeductible:500})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.dcpdDeductible"));
});
test("different All Perils deductible in two quote versions is a conflict",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("q1",{vin:VIN1,coverages:[{name:"All Perils",value:"$500"}]}),
  source("q2",{vin:VIN1,coverages:[{name:"All Perils",value:"$1,000"}]})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.allPerils.deductible"));
});
test("Collision and Comprehensive states never inferred from missing rows",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("q1",{vin:VIN1,coverages:[{name:"All Perils",value:"$500"}]}),
  source("q2",{vin:VIN1,coverages:[{name:"All Perils",value:"500"}]})
 ]);
 assert.deepEqual(out.conflictingFieldIds,[]);
});
test("OPCF differences are not silently overwritten",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
 source("q1",{vin:VIN1,coverages:[{name:"#20",value:"Yes"},{name:"#44",value:"Yes"}]}),
 source("q2",{vin:VIN1,coverages:[{name:"#20",value:"Yes"},{name:"#27",value:"Yes"}]})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.opcf"));
});
test("principal/occasional assignments cannot be quietly replaced",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
 source("q1",{vin:VIN1,declaredOperators:["Alice (Prn)","Bob (Occ)"]}),
 source("q2",{vin:VIN1,declaredOperators:["Bob (Prn)","Alice (Occ)"]})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.driverAssignments"));
});
test("repeat parsing of the same source does not create duplicate active records",()=>{
 const a=source("q1",{vin:VIN1,annualKm:17000});
 const out=analyzeVehicleSourceConflicts(case1,[a,a]);
 assert.equal(out.observedActive,1);
 assert.deepEqual(out.conflictingFieldIds,[]);
});
test("two Case vehicles sharing one VIN are ambiguous",()=>{
 const out=analyzeVehicleSourceConflicts({vehicles:[c("a",VIN1),c("b",VIN1)]},[
  source("q1",{vin:VIN1,liability:1000000})]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:a.vin"));
 assert.ok(out.conflictingFieldIds.includes("vehicle:b.vin"));
});
test("invalid/unrecognized VIN cannot be matched by vehicle sequence",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("q1",{vin:"NOT_A_VIN",liability:1000000})]);
 assert.equal(out.observedActive,0);
 assert.deepEqual(out.conflictingFieldIds,[]);
});
test("non-Auto source cannot contaminate Auto vehicle",()=>{
 const s=source("report",{vin:VIN1,annualKm:99999});
 s.observation.documentType="DASH";
 assert.deepEqual(analyzeVehicleSourceConflicts(case1,[s]).conflictingFieldIds,[]);
});
test("minor formatting differences in numeric amounts are not conflicts",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
  source("q1",{vin:VIN1,liability:"$1,000,000"}),
  source("q2",{vin:VIN1,liability:1000000})
 ]);
 assert.deepEqual(out.conflictingFieldIds,[]);
});

test("one active source with contradictory Liability fields is blocked",()=>{
 const out=analyzeVehicleSourceConflicts(case1,[
   source("q1",{vin:VIN1,liability:1000000,
     coverages:[{name:"Bodily Injury",value:"$2,000,000"}]})
 ]);
 assert.ok(out.conflictingFieldIds.includes("vehicle:active-1.liability"));
});

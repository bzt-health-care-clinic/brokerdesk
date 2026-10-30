import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBrokerReview, sectionIssues } from "../lib/broker-keyin-review.mjs";
import { validateReportSummary } from "../lib/reviewed-report-schema.mjs";
import { generateRemarks } from "../lib/remarks-generator.mjs";
import { deriveStep3eOptions } from "../local-server/broker-review-step3e-options.mjs";
import { enrichStep3eRemarks } from "../local-server/broker-review-step3e-remarks.mjs";
import { projectBrokerReviewedCase } from "../local-server/reviewed-case-projection-stage3b.mjs";
import { reviewedCaseConsistencyIssues } from "../local-server/reviewed-keyin-package.mjs";
import { buildExplicitReviewCandidates } from "../local-server/broker-review-source.mjs";
const VIN1="WBX73EF04T5683888",VIN2="5N1AT2MVXKC837736";
const hash="a".repeat(64);
const copy=v=>JSON.parse(JSON.stringify(v));
function autoCase({two=false}={}) {
 return {
   case_id:"case-1",case_type:"new_auto",insured:{name:"DOE, JOHN",co_insured:[]},
   policy:{company:"Intact",quote_number:"Q100",effective_date:"2026-10-22",
     mailing_address:"20 Main St",policy_number:"P1"},
   drivers:[{id:"d1",name:"John Doe",licence_number:"D123456789",
     assigned_vehicle:"v1",principal:true}],
   vehicles:[{id:"v1",vin:VIN1,year:2026,make:"BMW",model:"X1",primary_use:"Pleasure",
     annual_km:12000,commute_km:0,winter_tires:true,garaging_address:"20 Main St",
     ownership:{received:true,vin:VIN1}},
     ...(two?[{id:"v2",vin:VIN2,year:2019,make:"Nissan",model:"Rogue",
       primary_use:"Commute",annual_km:14000,commute_km:10}]:[])],
   coverage:{liability:1000000,all_perils_deductible:1000,
     endorsements:["20","27","44R"],comparison:[]},
   claims:[],documents:[],prior_insurance:{},policy_change:{},
   intake_discount_review:{selections:[{kind:"WINTER_TIRES",subject_key:"v1"}]}
 };
}
const source=(data,documentType="AUTO_QUOTE",id="doc-auto",entityKind="VEHICLE")=>({
   record:{id,parserVersion:7},hash,observation:{
     documentId:id,documentType,entityKind,data,
     fieldEvidence:Object.fromEntries(Object.keys(data).map(k=>[k,[{page:2}]]))
   }
});
const docs=(sources=[])=>({
   sources,verified:[{id:"doc-auto",sha256:hash}],
   records:[{id:"doc-auto",documentType:"AUTO_QUOTE",logicalDocuments:[]}]
});
test("derived options carry verified per-car Coverage, OPCF and driver assignment",()=>{
 const item=autoCase();
 const v=source({vin:VIN1,liability:2000000,allPerilsDeductible:500,
   coverages:[{name:"Collision",value:"1000"},{name:"#20",value:"Yes"}],
   declaredOperators:["John Doe (Prn)"]});
 const options=deriveStep3eOptions(item,docs([v]));
 assert.equal(options.coverageByVehicle.v1.liability,2000000);
 assert.deepEqual(options.coverageByVehicle.v1.collision,{present:true,deductible:1000});
 assert.deepEqual(options.driverAssignmentsByVehicle.v1,[{driverId:"d1",role:"PRINCIPAL"}]);
 assert.equal(options.garagingSameMailByVehicle.v1,true);
 const review=createBrokerReview(item,{...options,sourceFiles:[{id:"doc-auto",sha256:hash}]});
 const field=id=>review.fields.find(f=>f.id===id)?.value;
 assert.equal(field("vehicle:v1.liability"),2000000);
 assert.equal(field("vehicle:v1.collision.present"),true);
 assert.equal(field("vehicle:v1.allPerils.deductible"),500);
 assert.equal(field("vehicle:v1.opcf44"),false);
});
test("a second vehicle never inherits policy-level Coverage",()=>{
 const item=autoCase({two:true});
 const options=deriveStep3eOptions(item,docs());
 assert.equal(options.coverageByVehicle.v1,undefined);
 assert.equal(options.coverageByVehicle.v2,undefined);
});
test("unmatched VIN cannot bind a car or its Coverage",()=>{
 const options=deriveStep3eOptions(autoCase(),docs([source({vin:VIN2,liability:9000000})]));
 assert.equal(options.coverageByVehicle.v1.liability,1000000);
});
test("duplicate VIN does not assign parsed candidate to either vehicle",()=>{
 const item=autoCase({two:true});item.vehicles[1].vin=item.vehicles[0].vin;
 const opt=deriveStep3eOptions(item,docs([source({vin:VIN1,liability:4000000})]));
 assert.equal(opt.coverageByVehicle.v1,undefined);
 const catalog=createBrokerReview(item,{sourceFiles:[{id:"doc-auto",sha256:hash}]}).fields;
 assert.equal(buildExplicitReviewCandidates(item,catalog,[source({vin:VIN1,liability:4000000})])
   .candidates.filter(c=>c.fieldId.endsWith(".liability")).length,0);
});
test("only discounts actually known to quote/case are displayed",()=>{
 const item=autoCase();
 const derived=deriveStep3eOptions(item,docs([source({
   quoteDiscounts:[{id:"multi",name:"Multi Vehicle",selected:true}]
 })]));
 assert.deepEqual(derived.quoteDiscounts.map(d=>d.id).sort(),
   ["WINTER_TIRES:v1","multi"]);
 const review=createBrokerReview(item,derived);
 assert.ok(review.fields.find(f=>f.id==="quoteDiscount:multi.selected"));
 assert.equal(review.fields.some(f=>f.id==="quoteDiscount:retired.selected"),false);
});
test("MVR parsed zero still requires a real source report pull date",()=>{
 const item=autoCase();
 const d=docs([source({pulledDate:"2026-10-15",
   reportedConvictionCount:0,convictions:[]}, "MVR","mvr-1",null)]);
 d.verified.push({id:"mvr-1",sha256:hash});
 d.records.push({id:"mvr-1",logicalDocuments:[{documentType:"MVR",presenceStatus:"FOUND"}]});
 const opts=deriveStep3eOptions(item,d);
 assert.equal(opts.reports[0].pulledDate,"2026-10-15");
 assert.deepEqual(opts.reports[0].summary,{hasConvictions:false,convictions:[]});
 const review=createBrokerReview(item,opts);
 assert.equal(review.fields.filter(f=>f.id.includes("report:mvr:mvr-1.summary")).length,1);
});


test("MVR zero with a parser warning is NOT automatically clean",()=>{
 const c=source({requestDate:"2026-10-20",reportedConvictionCount:0,convictions:[]},
   "MVR","mvr-1",null);
 c.observation.warnings=[{severity:"medium",message:"Partial conviction rows"}];
 const d={sources:[c],verified:[{id:"mvr-1",sha256:hash}],records:[
   {id:"mvr-1",documentType:"MVR",logicalDocuments:[]}]};
 const out=deriveStep3eOptions(autoCase(),d);
 assert.equal(out.reports[0].summary,null);
});
test("two MVR logical sections in one PDF remain two independent pending reports",()=>{
 const item=autoCase();
 const d={
   verified:[{id:"combined",sha256:hash}],sources:[],
   records:[{id:"combined",documentType:"OTHER",logicalDocuments:[
     {id:"mvr-alice",documentType:"MVR",presenceStatus:"FOUND"},
     {id:"mvr-bob",documentType:"MVR",presenceStatus:"FOUND"}]}]
 };
 const out=deriveStep3eOptions(item,d);
 assert.deepEqual(out.reports.map(r=>r.id).sort(),
   ["combined::mvr-alice","combined::mvr-bob"]);
 assert.ok(out.reports.every(r=>r.summary===null));
});
test("empty extracted MVR cannot be asserted clean",()=>{
 const s=validateReportSummary({},"mvr");
 assert.ok(s.length);
 assert.ok(validateReportSummary({hasConvictions:false,convictions:[{
   offenceDate:"2026-01-01",description:"Speeding",classification:"Minor"}]},"mvr").length);
 assert.deepEqual(validateReportSummary({hasConvictions:false,convictions:[]},"mvr"),[]);
});
test("MVR Yes requires offence date, offence and classification",()=>{
 const good={hasConvictions:true,convictions:[{
  offenceDate:"2026-02-02",description:"Speeding",classification:"Minor"}]};
 assert.deepEqual(validateReportSummary(good,"mvr"),[]);
 assert.ok(validateReportSummary({...good,convictions:[{description:"Speeding"}]},"mvr").length);
});
test("MVR invalid date rejects parsed values",()=>{
 assert.ok(validateReportSummary({hasConvictions:true,convictions:[{
   offenceDate:"2026-02-30",description:"Speeding",classification:"Minor"}]},"mvr").length);
});
test("DASH empty object / empty claim list cannot bypass Yes",()=>{
 assert.ok(validateReportSummary({},"dash").length);
 assert.ok(validateReportSummary({hasClaims:true,claims:[]},"dash").length);
});
test("DASH requires Claim#, loss date, driver and at-fault%",()=>{
 const good={hasClaims:true,claims:[{claimNumber:"C123",lossDate:"2026-03-01",
   driver:"John Doe",atFaultPercent:25}]};
 assert.deepEqual(validateReportSummary(good,"dash"),[]);
 assert.ok(validateReportSummary({...good,claims:[{lossDate:"2026-03-01",driver:"John Doe",
   atFaultPercent:25}]},"dash").length);
 assert.ok(validateReportSummary({...good,claims:[{claimNumber:"C123",lossDate:"2026-03-01",
   driver:"John Doe",atFaultPercent:150}]},"dash").length);
});
test("DASH negative data is an explicit empty claim array",()=>{
 assert.deepEqual(validateReportSummary({hasClaims:false,claims:[]},"dash"),[]);
});
test("Review page validation enforces report schema, not just non-null record",()=>{
 const item=autoCase();
 const r=createBrokerReview(item,{reports:[{type:"mvr",id:"mvr-1",pulledDate:"2026-10-20",summary:{}}]});
 assert.ok(sectionIssues(r,"history","2026-10-22").some(e=>e.includes("hasConvictions")));
 r.fields.find(f=>f.id==="report:mvr:mvr-1.summary").value={hasConvictions:false,convictions:[]};
 assert.equal(sectionIssues(r,"history","2026-10-22").some(e=>e.includes("hasConvictions")),false);
});
test("preflight report day 30 valid, day 31 expired",()=>{
 const item=autoCase();
 const r=createBrokerReview(item,{reports:[{type:"dash",id:"dash1",
   pulledDate:"2026-09-22",summary:{hasClaims:false,claims:[]}}]});
 assert.equal(sectionIssues(r,"history","2026-10-22").some(e=>e.includes("older than")),false);
 assert.ok(sectionIssues(r,"history","2026-10-23").some(e=>e.includes("older than")));
});
test("single vehicle liability + deductible + OPCF projected to outbound copy",()=>{
 const item=autoCase();
 const r=createBrokerReview(item,{coverageByVehicle:{v1:{
   liability:2000000,allPerils:{present:true,deductible:500},
   collision:{present:false},comprehensive:{present:false},opcf:["20","27","44R"],
   opcf44:true}},driverAssignmentsByVehicle:{v1:[{driverId:"d1",role:"PRINCIPAL"}]}});
 const frozen=copy(r);
 for(const sec of r.sections)sec.status="CONFIRMED",sec.confirmation={ok:true};
 const p=projectBrokerReviewedCase(item,r);
 assert.deepEqual(p.issues,[]);
 assert.equal(p.item.coverage.liability,2000000);
 assert.equal(p.item.coverage.all_perils_deductible,500);
 assert.equal(item.coverage.liability,1000000);
 assert.deepEqual(reviewedCaseConsistencyIssues(r,p.item),[]);
 p.item.coverage.liability=1000000;
 assert.ok(reviewedCaseConsistencyIssues(r,p.item).some(x=>x.includes("Liability")));
});
test("reviewed snapshot/Case discount divergence rejects",()=>{
 const item=autoCase();
 const r=createBrokerReview(item);
 for(const s of r.sections)s.status="CONFIRMED",s.confirmation={ok:true};
 const p=projectBrokerReviewedCase(item,r);
 assert.deepEqual(p.issues,[]);
 const edited=copy(r);
 edited.fields.push({id:"quoteDiscount:WINTER_TIRES:v1.selected",value:false});
 assert.ok(reviewedCaseConsistencyIssues(edited,p.item).some(x=>x.includes("discount")));
});
test("multi-car differing Coverage retains per-car truth without inventing shared limits",()=>{
 const item=autoCase({two:true});
 const r=createBrokerReview(item,{coverageByVehicle:{
    v1:{liability:1000000,opcf:["20"]},v2:{liability:2000000,opcf:["27"]}
 }});
 for(const s of r.sections)s.status="CONFIRMED",s.confirmation={ok:true};
 const p=projectBrokerReviewedCase(item,r);
 assert.deepEqual(p.issues,[]);
 assert.equal(p.item.coverage.liability,1000000);
 assert.deepEqual(reviewedCaseConsistencyIssues(r,p.item),[]);
});
test("tampering legacy mapped Coverage after projection is caught",()=>{
 const item=autoCase();
 const r=createBrokerReview(item,{coverageByVehicle:{v1:{liability:2000000}}});
 for(const s of r.sections)s.status="CONFIRMED",s.confirmation={ok:true};
 const p=projectBrokerReviewedCase(item,r);
 p.item.coverage.liability=50000;
 assert.ok(reviewedCaseConsistencyIssues(r,p.item).length);
});
function changeCase(){
 const item=autoCase();
 item.case_type="auto_policy_change";
 item.policy.company="Pembridge";
 item.policy_change={
   transaction_types:["ADD_VEHICLE"],
   change_effective_date:"2026-10-22",
   requested_changes:[{id:"ch1",type:"ADD_VEHICLE",subject_id:"v1",
     new_value:{id:"v1",vin:VIN1}}]
 };
 return item;
}
test("Remarks Add Vehicle uses edited Review values, not stale vehicle Case",()=>{
 const item=changeCase();
 const review={fields:[
   {id:"vehicle:v1.vin",value:VIN1},{id:"vehicle:v1.year",value:2026},
   {id:"vehicle:v1.make",value:"BMW"},{id:"vehicle:v1.model",value:"X1"},
   {id:"vehicle:v1.use",value:"Commute"},
   {id:"vehicle:v1.annualKm",value:16000},
   {id:"vehicle:v1.commute",value:true},
   {id:"vehicle:v1.commuteOneWayKm",value:25},
   {id:"vehicle:v1.liability",value:1000000},
   {id:"vehicle:v1.allPerils.present",value:true},
   {id:"vehicle:v1.allPerils.deductible",value:1000},
   {id:"vehicle:v1.collision.present",value:false},
   {id:"vehicle:v1.comprehensive.present",value:false},
   {id:"vehicle:v1.opcf",value:["20","27","44"]}
 ]};
 const enriched=enrichStep3eRemarks(review,item,{
  type:"ADD_VEHICLE",company:"Pembridge",effectiveDate:"2026-10-22"});
 assert.equal(enriched.addedVehicle.commuteOneWayKm,25);
 const result=generateRemarks(enriched);
 assert.equal(result.needsManualCompletion,false,result.missing?.join(","));
 assert.match(result.text,/one-way commute 25 km/);
 assert.match(result.text,/annual 16,000 km/);
 assert.match(result.text,/OPCF 20, 27, 44/);
 assert.equal(result.characters<=460,true);
});

test("combined Add+Delete request maps to vehicle substitution, not a silent Add-only note",()=>{
 const item=changeCase();
 item.policy_change.transaction_types=["ADD_VEHICLE","DELETE_VEHICLE"];
 item.policy_change.requested_changes.push({
  id:"remove1",type:"DELETE_VEHICLE",previous_value:{
    year:2019,make:"Nissan",model:"Rogue",vin:VIN2,reason:"trade-in"}
 });
 const r={fields:[{id:"change:remove1.before",value:{
    year:2019,make:"Nissan",model:"Rogue",vin:VIN2,reason:"trade-in"}}]};
 const req=enrichStep3eRemarks(r,item,{
   type:"ADD_VEHICLE",company:"Intact",effectiveDate:"2026-10-22"});
 assert.equal(req.type,"VEHICLE_SUBSTITUTION");
 assert.equal(req.removedVehicle.vin,VIN2);
 assert.equal(req.addedVehicle.vin,VIN1);
});
test("Remarks ambiguous new vehicle ID must fallback rather than guessing",()=>{
 const item=changeCase();
 item.policy_change.requested_changes[0].subject_id="unknown";
 const enriched=enrichStep3eRemarks({fields:[]},item,{
   type:"ADD_VEHICLE",company:"Pembridge",effectiveDate:"2026-10-22"});
 assert.equal(enriched.addedVehicle,undefined);
 assert.equal(generateRemarks(enriched).templateId,"MANUAL_FALLBACK");
});
test("strict Ownership patch does not allow a bare matching subjectId",()=>{
 const ts=readFileSync(new URL("../lib/intake-profile.ts",import.meta.url),"utf8");
 assert.match(ts,/return observedVins\.includes\(vin\)/);
 assert.doesNotMatch(ts,/return Boolean\(\(vehicle\.id && section\.subjectId === vehicle\.id\) \|\|/);
});

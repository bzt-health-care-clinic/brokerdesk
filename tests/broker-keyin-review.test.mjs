import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
 createBrokerReview, editBrokerReviewField, confirmBrokerReviewSection,
 updateBrokerReviewSources, sectionIssues, reviewExportIssues,
 finalizeBrokerReview, verifyBrokerSnapshot, sectionFingerprint
} from "../lib/broker-keyin-review.mjs";
import { BrokerKeyinReviewStore } from "../local-server/broker-review-store.mjs";

const sourceDocHash="f".repeat(64);
function caseFixture() {
 return {
  case_id:"CASE0001",case_type:"new_auto",
  policy:{company:"Aviva",quote_number:"Q001",effective_date:"2026-11-01",
    mailing_address:"123 Example Road",client_code:"C001"},
  insured:{name:"TEST CLIENT",co_insured:[]},
  drivers:[{
    id:"d1",name:"TEST DRIVER",licence_number:"D0001",licence_class:"G",
    relationship:"Insured",g1_date:"",g2_date:"",g_date:""
  }],
  vehicles:[{
    id:"v1",vin:"1HGBH41JXMN109186",year:2026,make:"Honda",model:"Civic",
    primary_use:"Pleasure",annual_km:15000,commute_km:0,winter_tires:false,
    garaging_address:"123 Example Road"
  }],
  documents:[],
  prior_insurance:{insurer:"Example",policy_number:"POL001",
    effective_date:"2022-11-01",expiry_date:"2026-10-31",
    continuous_insurance:"4 years"},
  claims:[]
 };
}
function options() {
 return {
  commuteByVehicle:{v1:false},garagingSameMailByVehicle:{v1:true},
  driverAssignmentsByVehicle:{v1:[{driverId:"d1",role:"PRINCIPAL"}]},
  coverageByVehicle:{v1:{liability:1000000,allPerils:{present:true,deductible:1000},
    collision:{present:false},comprehensive:{present:false},opcf:["20","44"],opcf44:true}},
  quoteDiscountsChecked:true,quoteDiscounts:[{id:"winter",name:"Winter Tires",
    selected:false,evidenceRequired:false}],
  reports:[{type:"mvr",id:"d1",pulledDate:"2026-09-22",summary:{hasConvictions:false,convictions:[]}},
    {type:"dash",id:"case",pulledDate:"2026-09-22",summary:{hasClaims:false,claims:[]}}],
  sourceFiles:[{id:"doc1",sha256:sourceDocHash}],
  now:"2026-10-22T12:00:00Z"
 };
}
function confirmAll(review,referenceDate="2026-10-22") {
 let current=review;
 for (const section of current.sections) {
  current=confirmBrokerReviewSection(current,section.id,{
    actor:"BROKER-1",expectedRevision:current.revision,referenceDate,
    now:"2026-10-22T12:00:00Z"});
 }
 return current;
}
test("auto review creates independent vehicle and driver fields with optional roles hidden",()=>{
 const review=createBrokerReview(caseFixture(),options());
 assert.ok(review.fields.find(f=>f.id==="vehicle:v1.driverAssignments"));
 assert.equal(review.fields.filter(f=>f.id.includes(".occasional")).length,0);
 assert.ok(review.fields.find(f=>f.id==="report:mvr:d1.pulledDate"));
 assert.ok(review.fields.find(f=>f.id==="vehicle:v1.allPerils.present"));
});
test("Broker confirms each section once; whole reviewed snapshot verifies",()=>{
 const review=confirmAll(createBrokerReview(caseFixture(),options()));
 assert.equal(reviewExportIssues(review,{submissionDate:"2026-10-22"}).length,0);
 const snapshot=finalizeBrokerReview(review,{brokerId:"BROKER-1",
   expectedRevision:review.revision,submittedAt:"2026-10-22T18:30:00Z"});
 assert.equal(snapshot.review_status,"BROKER_CONFIRMED");
 assert.deepEqual(verifyBrokerSnapshot(JSON.parse(JSON.stringify(snapshot)),
   {submissionDate:"2026-10-22"}),[]);
 assert.equal(snapshot.sections.length,7);
});
test("same report is valid on day 30 but expires on day 31",()=>{
 const review=createBrokerReview(caseFixture(),options());
 assert.equal(sectionIssues(review,"history","2026-10-22").length,0);
 assert.ok(sectionIssues(review,"history","2026-10-23")
   .some(x=>x.includes("older than 30 days")));
});
test("confirmed source change invalidates sections; old snapshot cannot be passed as current",()=>{
 let review=confirmAll(createBrokerReview(caseFixture(),options()));
 review=updateBrokerReviewSources(review,[{id:"doc1",sha256:"e".repeat(64)}],
   {expectedRevision:review.revision});
 assert.ok(review.sections.every(s=>s.status==="PENDING"));
 assert.ok(reviewExportIssues(review,{submissionDate:"2026-10-22"}).length>0);
});
test("editing field resets its page and increment revision; mismatch gets 409",()=>{
 let review=confirmAll(createBrokerReview(caseFixture(),options()));
 const before=review.revision;
 review=editBrokerReviewField(review,"vehicle:v1.annualKm",12000,
   {actor:"BROKER-1",expectedRevision:before});
 assert.equal(review.revision,before+1);
 assert.equal(review.sections.find(s=>s.id==="vehicles").status,"PENDING");
 assert.equal(review.sections.find(s=>s.id==="policy").status,"CONFIRMED");
 assert.throws(()=>editBrokerReviewField(review,"vehicle:v1.annualKm",11000,
   {actor:"BROKER-1",expectedRevision:before}),{status:409});
});
test("zero and false values are distinct from null; driver assignment cannot have two principals",()=>{
 let review=createBrokerReview(caseFixture(),options());
 assert.equal(review.fields.find(f=>f.id==="vehicle:v1.commute").value,false);
 assert.equal(review.fields.find(f=>f.id==="vehicle:v1.commuteOneWayKm").value,0);
 assert.ok(!sectionIssues(review,"vehicles").some(x=>x.includes("commuteOneWayKm")));
 review=editBrokerReviewField(review,"vehicle:v1.driverAssignments",[
  {driverId:"d1",role:"PRINCIPAL"},{driverId:"d1",role:"PRINCIPAL"}],
  {actor:"BROKER-1",expectedRevision:review.revision});
 assert.ok(sectionIssues(review,"vehicles").some(x=>x.includes("Duplicate driver")));
});
test("candidate binding requires explicit field ID and active matching source hash",()=>{
 const opts=options();
 opts.candidates=[{fieldId:"vehicle:v1.annualKm",value:19000,
   documentId:"doc1",sourceHash:sourceDocHash,page:2,active:true},
  {fieldId:"driver:unknown.name",value:"WRONG ASSOCIATION",
   documentId:"doc1",sourceHash:sourceDocHash,page:1,active:true}];
 const review=createBrokerReview(caseFixture(),opts);
 assert.equal(review.fields.find(f=>f.id==="vehicle:v1.annualKm").value,19000);
 assert.equal(review.unassigned_candidates.length,1);
 assert.ok(sectionIssues(review,"final").some(x=>x.includes("unassigned")));
});
test("manual tampering of a confirmed field breaks the section checksum",()=>{
 const review=confirmAll(createBrokerReview(caseFixture(),options()));
 review.fields.find(f=>f.id==="vehicle:v1.vin").value="1HGBH41JXMN109187";
 assert.notEqual(review.sections.find(s=>s.id==="vehicles").confirmation.contentSha256,
   sectionFingerprint(review,"vehicles"));
 assert.ok(reviewExportIssues(review,{submissionDate:"2026-10-22"})
   .some(x=>x.includes("stale")));
});
test("SQLite store saves section status and rejects concurrent revision overwrite",()=>{
 const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE cases(id TEXT PRIMARY KEY);
   CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
     case_id TEXT, document_id TEXT, actor TEXT, action TEXT,details_json TEXT,created_at TEXT);`);
 db.prepare("INSERT INTO cases(id) VALUES(?)").run("CASE0001");
 const store=new BrokerKeyinReviewStore(db);
 const created=store.create(caseFixture(),options(),"BROKER-1");
 const edited=store.edit("CASE0001","vehicle:v1.annualKm",18000,
   {actor:"BROKER-1",expectedRevision:created.revision});
 assert.equal(store.read("CASE0001").revision,2);
 assert.equal(store.read("CASE0001").fields.find(f=>f.id==="vehicle:v1.annualKm").value,18000);
 assert.throws(()=>store.edit("CASE0001","vehicle:v1.annualKm",12000,
   {actor:"BROKER-1",expectedRevision:1}),{status:409});
 const confirmed=store.confirm("CASE0001","vehicles",
   {actor:"BROKER-1",expectedRevision:edited.revision,referenceDate:"2026-10-22"});
 assert.equal(confirmed.sections.find(s=>s.id==="vehicles").status,"CONFIRMED");
 assert.ok(db.prepare("SELECT count(*) AS n FROM audit_events").get().n>=3);
 db.close();
});

test("Unknown case types fail closed instead of inheriting Home template",()=>{
 assert.throws(()=>createBrokerReview({...caseFixture(),case_type:"audit_review"},options()),
    /does not support case type/i);
});
test("Stale source references must be refreshed before Broker re-confirms",()=>{
 const opts=options();
 opts.candidates=[{fieldId:"vehicle:v1.annualKm",value:19000,
   documentId:"doc1",sourceHash:sourceDocHash,page:2,active:true}];
 let review=createBrokerReview(caseFixture(),opts);
 review=updateBrokerReviewSources(review,[{id:"doc1",sha256:"e".repeat(64)}],
   {expectedRevision:review.revision});
 assert.ok(sectionIssues(review,"vehicles").some(x=>x.includes("Source evidence is stale")));
 assert.throws(()=>confirmBrokerReviewSection(review,"vehicles",
   {actor:"BROKER-1",expectedRevision:review.revision}),{status:422});
});
test("Manual edits cannot masquerade as machine-extracted evidence",()=>{
 const review=createBrokerReview(caseFixture(),options());
 assert.throws(()=>editBrokerReviewField(review,"vehicle:v1.annualKm",12000,
   {actor:"BROKER-1",origin:"EXTRACTED"}),/Invalid source/);
});


test("OPCF 44/44R is optional: an explicit No must not block the Coverage review",()=>{
  const opts=options();
  opts.coverageByVehicle.v1.opcf=["20"];
  opts.coverageByVehicle.v1.opcf44=false;
  const review=createBrokerReview(caseFixture(),opts);
  assert.equal(review.fields.find(f=>f.id==="vehicle:v1.opcf44").value,false);
  assert.ok(!sectionIssues(review,"coverage","2026-10-22").some(s=>s.includes("opcf44")));
  assert.doesNotThrow(()=>confirmBrokerReviewSection(review,"coverage",{
    actor:"BROKER-1",expectedRevision:review.revision,referenceDate:"2026-10-22"}));
});

test("No purchased OPCF is valid, while purchased OPCF 44R requires Yes",()=>{
 const opts=options();
 opts.coverageByVehicle.v1.opcf=[];
 opts.coverageByVehicle.v1.opcf44=false;
 let review=createBrokerReview(caseFixture(),opts);
 assert.equal(sectionIssues(review,"coverage").length,0);
 opts.coverageByVehicle.v1.opcf=["44R"];
 review=createBrokerReview(caseFixture(),opts);
 assert.ok(sectionIssues(review,"coverage").some(issue=>issue.includes("OPCF 44/44R")));
 opts.coverageByVehicle.v1.opcf44=true;
 review=createBrokerReview(caseFixture(),opts);
 assert.equal(sectionIssues(review,"coverage").length,0);
});
test("Selected discount cannot confirm required supporting evidence as missing",()=>{
 const opts=options();
 opts.quoteDiscounts=[{id:"winter",name:"Winter Tires",selected:true,
  evidenceRequired:true,evidencePresent:false}];
 let review=createBrokerReview(caseFixture(),opts);
 assert.ok(sectionIssues(review,"coverage").some(issue=>issue.includes("requires its proof")));
 opts.quoteDiscounts[0].evidencePresent=true;
 review=createBrokerReview(caseFixture(),opts);
 assert.equal(sectionIssues(review,"coverage").length,0);
});

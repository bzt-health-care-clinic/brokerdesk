import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BrokerReviewService } from "../local-server/broker-review-integration.mjs";
import {
  verifiedReviewDocuments, buildExplicitReviewCandidates
} from "../local-server/broker-review-source.mjs";
import { createBrokerReview } from "../lib/broker-keyin-review.mjs";

const hash=data=>createHash("sha256").update(data).digest("hex");
function caseFixture(){
  return {
    case_id:"CASE0001",case_type:"new_auto",
    policy:{company:"Aviva",quote_number:"Q1",effective_date:"2026-11-01",
      mailing_address:"123 Example Rd"},
    insured:{name:"TEST CLIENT",co_insured:[]},
    drivers:[{id:"d1",name:"TEST DRIVER",licence_number:"D1234567",licence_class:"G"}],
    vehicles:[{id:"v1",vin:"1HGBH41JXMN109186",year:2026,make:"Honda",
      model:"Civic",primary_use:"Pleasure",annual_km:12000,commute_km:0}],
    documents:[],claims:[]
  };
}
function harness(withDocument=true){
 const db=new DatabaseSync(":memory:");
 db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,case_id TEXT,
       document_id TEXT,actor TEXT,action TEXT,details_json TEXT,created_at TEXT);`);
 db.prepare("INSERT INTO cases(id) VALUES(?)").run("CASE0001");
 const dir=mkdtempSync(join(tmpdir(),"bd-step2-"));
 const path=join(dir,"quote.pdf");
 const bytes=Buffer.from("SYNTHETIC TEST ONLY; not a real PDF");
 writeFileSync(path,bytes);
 const item=caseFixture();
 const rec={id:"doc1",sourceHash:hash(bytes),state:"PARSED",
   documentType:"AUTO_QUOTE",staleExtraction:false,logicalDocuments:[],
   parsedSources:[]};
 let docs=withDocument?[rec]:[];
 const repo={
  getCase:()=>item,
  listDocuments:()=>docs,
  documentPath:id=>docs.some(r=>r.id===id)?{path}:null
 };
 const service=new BrokerReviewService(db,repo);
 const cleanup=()=>{db.close();rmSync(dir,{recursive:true,force:true});};
 return {db,path,rec,item,service,cleanup,docs,removeDoc:()=>{docs=[]},addDoc:()=>{docs=[rec]}};
}
test("GET is read-only; POST creates a draft with fingerprint and audit event",()=>{
 const h=harness();try{
  assert.equal(h.service.read("CASE0001").review,null);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM keyin_reviews").get().n,0);
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  assert.equal(created.review.review_status,"DRAFT");
  assert.equal(created.review.revision,1);
  assert.equal(h.db.prepare("SELECT COUNT(*) n FROM keyin_review_bindings").get().n,1);
  assert.ok(!created.ready);
  assert.throws(()=>h.service.create("CASE0001",{actor:"PILOT-BROKER-1"}),{status:409});
 }finally{h.cleanup();}
});
test("Broker edits are saved, versioned and rejected on stale optimistic version",()=>{
 const h=harness();try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const changed=h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,fieldId:"vehicle:v1.annualKm",value:9000});
  assert.equal(changed.review.revision,2);
  assert.equal(h.service.read("CASE0001").review.fields
    .find(f=>f.id==="vehicle:v1.annualKm").value,9000);
  assert.throws(()=>h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:1,fieldId:"vehicle:v1.annualKm",value:8000}),{status:409});
  assert.throws(()=>h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:2,fieldId:"vehicle:v1.annualKm",value:"BAD"}),{status:400});
 }finally{h.cleanup();}
});
test("Case changed behind Broker Review blocks confirm/edit until explicit rebuild",()=>{
 const h=harness();try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  h.item.policy.mailing_address="456 Changed Ave";
  const live=h.service.read("CASE0001");
  assert.match(live.sourceIssues.join(" "),/Case details changed/i);
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,sectionId:"policy"}),{status:409});
  const rebuilt=h.service.rebuild("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision});
  assert.equal(rebuilt.sourceIssues.length,0);
  assert.equal(rebuilt.review.revision,2);
  assert.equal(rebuilt.review.sections.every(s=>s.status==="PENDING"),true);
 }finally{h.cleanup();}
});
test("A changed physical file is never auto-rebaselined",()=>{
 const h=harness();try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  writeFileSync(h.path,Buffer.from("MUTATED CONTENT"));
  const changed=h.service.read("CASE0001");
  assert.ok(changed.sourceIssues.length);
  assert.throws(()=>h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,fieldId:"policy.insured",
    value:"DIFFERENT"}),{status:409});
  assert.throws(()=>h.service.rebuild("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision}),{status:409});
  h.rec.sourceHash=hash(Buffer.from("MUTATED CONTENT"));
  const rebuilt=h.service.rebuild("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision});
  assert.equal(rebuilt.sourceIssues.length,0);
 }finally{h.cleanup();}
});
test("No saved physical file cannot pass a section confirm",()=>{
 const h=harness(false);try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,sectionId:"policy"}),{status:422});
 }finally{h.cleanup();}
});
test("Exact VIN/LICENCE and real evidence page allow mapping, unmatched not assigned",()=>{
 const h=harness();try{
  const hashValue=h.rec.sourceHash;
  const observation={
   documentId:"doc1",documentType:"AUTO_QUOTE",data:{
     vin:"1HGBH41JXMN109186",annualKm:15000,licenceNumber:"D1234567",
     driverName:"TEST DRIVER"
   },fieldEvidence:{
     vin:[{page:2}], annualKm:[{page:2}],licenceNumber:[{page:3}],driverName:[{page:3}]
   }
  };
  h.rec.parsedSources=[observation];
  const live=verifiedReviewDocuments({
   listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  const review=createBrokerReview(h.item,{sourceFiles:live.verified});
  const mapped=buildExplicitReviewCandidates(h.item,review.fields,live.sources);
  assert.ok(mapped.candidates.some(c=>c.fieldId==="vehicle:v1.annualKm"&&c.page===2));
  assert.ok(mapped.candidates.some(c=>c.fieldId==="driver:d1.name"&&c.page===3));
  h.rec.parsedSources=[{...observation,data:{...observation.data,vin:"WBAZZZ99999999999",licenceNumber:"UNKNOWN"}}];
  const changed=verifiedReviewDocuments({
   listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  const mismatched=buildExplicitReviewCandidates(h.item,review.fields,changed.sources);
  assert.equal(mismatched.candidates.some(c=>c.fieldId.startsWith("vehicle:")||c.fieldId.startsWith("driver:")),false);
 }finally{h.cleanup();}
});
test("Preview of uncommon Remarks returns safe, editable fallback rather than imaginary values",()=>{
 const h=harness();try{
  h.item.case_type="auto_policy_change";
  h.item.policy_change={transaction_types:["OTHER_POLICY_CHANGE"],
   change_effective_date:"2026-11-01",requested_changes:[]};
  h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const reply=h.service.remarks("CASE0001");
  assert.equal(reply.preview.needsManualCompletion,true);
  assert.match(reply.preview.text,/Hi U\/W/);
  assert.doesNotMatch(reply.preview.text,/\bundefined\b/);
 }finally{h.cleanup();}
});
test("Document removed after draft creation invalidates source fingerprint",()=>{
 const h=harness();try{
  const initial=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  h.removeDoc();
  assert.ok(h.service.read("CASE0001").sourceIssues.length>0);
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:initial.review.revision,sectionId:"policy"}),{status:409});
 }finally{h.cleanup();}
});
test("Confirmed section persisted in SQLite and unchanged on subsequent read",()=>{
 const h=harness();try{
  const initial=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const result=h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:initial.review.revision,sectionId:"policy"});
  assert.equal(result.review.sections.find(s=>s.id==="policy").status,"CONFIRMED");
  assert.equal(h.service.read("CASE0001").review.sections
     .find(s=>s.id==="policy").status,"CONFIRMED");
 }finally{h.cleanup();}
});
test("Server stores audit metadata without raw field values",()=>{
 const h=harness();try{
  const initial=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:initial.review.revision,fieldId:"policy.insured",
    value:"SECRET TEST NAME"});
  const audit=h.db.prepare("SELECT details_json FROM audit_events WHERE action='BROKER_FIELD_EDITED'").get();
  assert.doesNotMatch(audit.details_json,/SECRET TEST NAME/);
 }finally{h.cleanup();}
});

test("Document checklist flag does not substitute for a matching actual PDF",()=>{
 const h=harness();try{
  h.item.documents=[{id:"check-1",name:"Signed Application",category:"signed_application",
    required:true,received:true}];
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,sectionId:"documents"}),{status:422});
  h.rec.logicalDocuments=[{documentType:"AUTO_APPLICATION",presenceStatus:"FOUND",
    startPage:1,endPage:1}];
  h.item.documents=h.item.documents.map(doc=>({...doc}));
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,sectionId:"documents"}),{status:409});
  const updated=h.service.rebuild("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision});
  assert.doesNotMatch(updated.sourceIssues.join(" "),/changed/i);
 }finally{h.cleanup();}
});

test("Pembridge Remarks count includes spaces, punctuation and newlines",()=>{
 const h=harness();try{
  h.item.case_type="auto_policy_change";
  h.item.policy.company="Pembridge";
  h.item.policy.policy_number="POL0001";
  h.item.policy_change={transaction_types:["PAYMENT_CHANGE"],
    change_effective_date:"2026-10-22",requested_changes:[{id:"c1",type:"PAYMENT_CHANGE",
      subject_name:"Insured",new_value:"New void cheque",effective_date:"2026-10-22"}]};
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const text="Hi U/W, As insured's request, please change the void cheque. Effective date: October 22, 2026. "
    .padEnd(461,"X");
  const updated=h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,fieldId:"remarks.text",value:text});
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:updated.review.revision,sectionId:"remarks"}),{status:422});
 }finally{h.cleanup();}
});
test("Public HTTP adapter enforces action/method allowlist",()=>{
 const h=harness();try{
  assert.equal(h.service.handle("CASE0001","","GET").status,200);
  assert.equal(h.service.handle("CASE0001","","POST",{actor:"PILOT-BROKER-1"}).status,201);
  assert.throws(()=>h.service.handle("CASE0001","fields","GET"),{status:404});
  assert.throws(()=>h.service.handle("CASE0001","remarks-preview","POST"),{status:404});
 }finally{h.cleanup();}
});

test("A new parser observation invalidates confirmation even with identical PDF bytes",()=>{
 const h=harness();try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  h.rec.parsedSources=[{
    documentId:"doc1",documentType:"AUTO_QUOTE",
    data:{vin:"1HGBH41JXMN109186",annualKm:13000},
    fieldEvidence:{vin:[{page:1}],annualKm:[{page:1}]}
  }];
  const changed=h.service.read("CASE0001");
  assert.match(changed.sourceIssues.join(" "),/changed/i);
  assert.throws(()=>h.service.confirm("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision,sectionId:"vehicles"}),{status:409});
  const rebuilt=h.service.rebuild("CASE0001",{actor:"PILOT-BROKER-1",
    expectedRevision:created.review.revision});
  assert.equal(rebuilt.review.sections.every(sec=>sec.status==="PENDING"),true);
  assert.equal(rebuilt.sourceIssues.length,0);
 }finally{h.cleanup();}
});

test("Duplicate Case VIN or licence never silently receives source evidence",()=>{
 const h=harness();try{
  const observation={
    documentId:"doc1",documentType:"AUTO_QUOTE",
    data:{vin:"1HGBH41JXMN109186",annualKm:15000,licenceNumber:"D1234567",
      driverName:"TEST DRIVER"},
    fieldEvidence:{
      vin:[{page:2}],annualKm:[{page:2}],licenceNumber:[{page:3}],driverName:[{page:3}]
    }
  };
  h.rec.parsedSources=[observation];
  const docs=verifiedReviewDocuments({
   listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  h.item.vehicles.push({...h.item.vehicles[0],id:"v2"});
  h.item.drivers.push({...h.item.drivers[0],id:"d2"});
  const fieldTemplate=createBrokerReview(h.item,{sourceFiles:docs.verified});
  const mapping=buildExplicitReviewCandidates(h.item,fieldTemplate.fields,docs.sources);
  assert.equal(mapping.candidates.filter(x=>x.fieldId.startsWith("vehicle:")||
    x.fieldId.startsWith("driver:")).length,0);
 }finally{h.cleanup();}
});

test("Vehicle assignments reject duplicate drivers or multiple Principal roles",()=>{
 const h=harness();try{
  const created=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const f=created.review.fields.find(f=>f.type==="assignments");
  assert.ok(f,"Vehicle assignment field must exist in the template");
  const base={actor:"PILOT-BROKER-1",expectedRevision:created.review.revision,
    fieldId:f.id};
  assert.throws(()=>h.service.edit("CASE0001",{...base,value:[
    {driverId:"d1",role:"PRINCIPAL"},{driverId:"d1",role:"SECONDARY"}
  ]}),{status:400});
  assert.throws(()=>h.service.edit("CASE0001",{...base,value:[
    {driverId:"d1",role:"PRINCIPAL"},{driverId:"d2",role:"PRINCIPAL"}
  ]}),{status:400});
 }finally{h.cleanup();}
});


test("Unverified OCR evidence cannot silently replace Broker Review fields",()=>{
 const h=harness();try {
  const observation={documentId:"doc1",documentType:"AUTO_QUOTE",data:{
    vin:"1HGBH41JXMN109186",annualKm:8888,licenceNumber:"D1234567",driverName:"BAD OCR NAME"
  },fieldEvidence:{
    vin:[{page:1,provider:"ocr_space",confidence:.99}],
    annualKm:[{page:1,provider:"ocr_space",confidence:.99}],
    licenceNumber:[{page:1,provider:"ocr_space",confidence:.99}],
    driverName:[{page:1,provider:"ocr_space",confidence:.99}]
  }};
  h.rec.parsedSources=[observation];
  let live=verifiedReviewDocuments({listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  let review=createBrokerReview(h.item,{sourceFiles:live.verified});
  let mapped=buildExplicitReviewCandidates(h.item,review.fields,live.sources);
  assert.equal(mapped.candidates.some(c=>c.fieldId.startsWith("vehicle:")||c.fieldId.startsWith("driver:")),false);
  h.rec.state="NEEDS_REVIEW";
  h.rec.parsedSources=[{...observation,fieldEvidence:{
    vin:[{page:1}],annualKm:[{page:1}],licenceNumber:[{page:1}],driverName:[{page:1}]}}];
  live=verifiedReviewDocuments({listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  mapped=buildExplicitReviewCandidates(h.item,review.fields,live.sources);
  assert.equal(mapped.candidates.length,0);
 }finally{h.cleanup();}
});
test("Withdrawn logical section and out-of-range evidence pages never auto-fill",()=>{
 const h=harness();try {
  const section={id:"LS1",documentType:"AUTO_QUOTE",presenceStatus:"FOUND",startPage:2,endPage:3};
  const observation={documentId:"doc1",logicalDocumentId:"LS1",documentType:"AUTO_QUOTE",
   data:{vin:"1HGBH41JXMN109186",annualKm:17000},
   fieldEvidence:{vin:[{page:2}],annualKm:[{page:9}]}};
  h.rec.logicalDocuments=[section];h.rec.parsedSources=[observation];
  const repo={listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})};
  const template=createBrokerReview(h.item,{sourceFiles:[{id:h.rec.id,sha256:h.rec.sourceHash}]});
  const present=verifiedReviewDocuments(repo,"CASE0001");
  let mapped=buildExplicitReviewCandidates(h.item,template.fields,present.sources);
  assert.equal(mapped.candidates.some(c=>c.fieldId==="vehicle:v1.annualKm"),false);
  h.rec.withdrawnSectionRanges=[{startPage:2,endPage:2}];
  const withdrawn=verifiedReviewDocuments(repo,"CASE0001");
  assert.equal(withdrawn.sources.length,0);
 }finally{h.cleanup();}
});
test("Mismatched quote insured name must not auto-fill the named policyholder",()=>{
 const h=harness();try{
  h.rec.parsedSources=[{documentId:"doc1",documentType:"AUTO_QUOTE",data:{namedInsured:"DIFFERENT PERSON"},
    fieldEvidence:{namedInsured:[{page:1}]}}];
  let sources=verifiedReviewDocuments({listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  let review=createBrokerReview(h.item,{sourceFiles:sources.verified});
  let mapped=buildExplicitReviewCandidates(h.item,review.fields,sources.sources);
  assert.equal(mapped.candidates.some(c=>c.fieldId==="policy.insured"),false);
  h.rec.parsedSources[0].data.namedInsured="CLIENT, TEST";
  sources=verifiedReviewDocuments({listDocuments:()=>[h.rec],documentPath:()=>({path:h.path})},"CASE0001");
  mapped=buildExplicitReviewCandidates(h.item,review.fields,sources.sources);
  assert.equal(mapped.candidates.some(c=>c.fieldId==="policy.insured"),true);
 }finally{h.cleanup();}
});
test("Assignments may only reference a driver actually in the current Case",()=>{
 const h=harness();try{
  const r=h.service.create("CASE0001",{actor:"PILOT-BROKER-1"});
  const field=r.review.fields.find(x=>x.type==="assignments");
  assert.throws(()=>h.service.edit("CASE0001",{actor:"PILOT-BROKER-1",expectedRevision:r.review.revision,
    fieldId:field.id,value:[{driverId:"invented",role:"PRINCIPAL"}]}),{status:400});
  assert.equal(h.service.read("CASE0001").review.revision,r.review.revision);
 }finally{h.cleanup();}
});

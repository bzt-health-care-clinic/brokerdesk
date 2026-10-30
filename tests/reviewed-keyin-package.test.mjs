import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
 createBrokerReview, confirmBrokerReviewSection, finalizeBrokerReview
} from "../lib/broker-keyin-review.mjs";
import { BrokerKeyinReviewStore } from "../local-server/broker-review-store.mjs";
import {
 reviewedKeyinPayload, validateReviewedKeyinPackage, remapReviewedKeyinForAuditor,
 auditorKeyinSheet, auditorKeyinSheetText, REVIEWED_KEYIN_PACKAGE_VERSION
} from "../local-server/reviewed-keyin-package.mjs";

const sha="b".repeat(64), now="2026-10-22T16:00:00Z";
function item(){
 return {case_id:"CHANGE001",case_type:"auto_policy_change",
  policy:{company:"Aviva",policy_number:"POL007",client_code:"TEST1"},
  insured:{name:"TEST INSURED",co_insured:[]},
  drivers:[],vehicles:[],documents:[],
  policy_change:{change_effective_date:"2026-10-22",requested_changes:[
   {id:"change1",type:"ADDRESS_CHANGE",subject_name:"Mailing",new_value:"222 Test Ave",
    effective_date:"2026-10-22"}],
   notes:"Hi U/W,\nAs insured's request, please change the mailing address to 222 Test Ave.\nEffective date: October 22, 2026."}
 };
}
function ready(){
 const c=item(),opts={sourceFiles:[{id:"doc1",sha256:sha}],now};
 let draft=createBrokerReview(c,opts);
 for(const section of draft.sections)
  draft=confirmBrokerReviewSection(draft,section.id,{actor:"BROKER-1",
    referenceDate:"2026-10-22",expectedRevision:draft.revision,now});
 return {snapshot:finalizeBrokerReview(draft,{brokerId:"BROKER-1",submittedAt:now}),item:c,
  records:[{id:"doc1",sourceHash:sha,logicalDocuments:[]}]};
}
test("package adapter validates snapshot and supplies reviewed-keyin.json bytes",()=>{
 const {snapshot,item:caseData,records}=ready();
 const payload=reviewedKeyinPayload(snapshot,caseData,records,now);
 assert.equal(payload.path,"reviewed-keyin.json");
 assert.equal(JSON.parse(payload.bytes).review_status,"BROKER_CONFIRMED");
 assert.deepEqual(validateReviewedKeyinPackage(snapshot,caseData,records,now),[]);
 assert.equal(REVIEWED_KEYIN_PACKAGE_VERSION,"0.4-reviewed-keyin");
});
test("replacing evidence hash breaks original package without altering Broker snapshot",()=>{
 const {snapshot,item:caseData,records}=ready();
 const changed=[{...records[0],sourceHash:"c".repeat(64)}];
 assert.ok(validateReviewedKeyinPackage(snapshot,caseData,changed,now)
  .some(problem=>problem.includes("Source hash changed")));
 assert.throws(()=>reviewedKeyinPayload(snapshot,caseData,changed,now),{status:422});
});
test("Auditor receives direct text sheet and immutable original snapshot ID mapping",()=>{
 const {snapshot}=ready();
 const before=snapshot.snapshot_sha256;
 const mapped=remapReviewedKeyinForAuditor(snapshot,new Map([
  ["CHANGE001","AUD001"],["doc1","AUD-DOC1"]
 ]));
 assert.equal(mapped.original_snapshot_sha256,before);
 assert.equal(mapped.display_view.source_case_id,"AUD001");
 assert.equal(snapshot.source_case_id,"CHANGE001");
 assert.equal(snapshot.snapshot_sha256,before);
 const text=auditorKeyinSheetText(auditorKeyinSheet(mapped.display_view));
 assert.match(text,/Requested Changes/);
 assert.match(text,/UW Remarks/);
 assert.match(text,/222 Test Ave/);
});
test("SQLite finalize stores and re-reads fully verified immutable snapshot",()=>{
 const db=new DatabaseSync(":memory:");
 db.exec(`CREATE TABLE cases(id TEXT PRIMARY KEY);
   CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
     case_id TEXT, document_id TEXT, actor TEXT, action TEXT,details_json TEXT,created_at TEXT);`);
 db.prepare("INSERT INTO cases(id) VALUES(?)").run("CHANGE001");
 const store=new BrokerKeyinReviewStore(db);
 let draft=store.create(item(),{sourceFiles:[{id:"doc1",sha256:sha}],now},"BROKER-1");
 for(const section of draft.sections)draft=store.confirm("CHANGE001",section.id,
  {actor:"BROKER-1",expectedRevision:draft.revision,referenceDate:"2026-10-22"});
 const snapshot=store.finalize("CHANGE001",{actor:"BROKER-1",
  expectedRevision:draft.revision,submittedAt:now});
 assert.equal(snapshot.review_status,"BROKER_CONFIRMED");
 assert.deepEqual(validateReviewedKeyinPackage(snapshot,item(),
  [{id:"doc1",sourceHash:sha,logicalDocuments:[]}],now),[]);
 assert.throws(()=>store.edit("CHANGE001","remarks.text","CHANGED",{
  actor:"BROKER-1",expectedRevision:snapshot.revision}),{status:409});
 db.close();
});


test("a draft worksheet never claims Broker confirmation",()=>{
  const review=createBrokerReview(item(),{sourceFiles:[{id:"doc1",sha256:sha}]});
  assert.equal(auditorKeyinSheet(review).brokerReview,"DRAFT");
});
test("source inventory refuses duplicate IDs even when hashes are identical",()=>{
  const {snapshot,item:caseData,records}=ready();
  const duplicate={...snapshot,source_files:[...snapshot.source_files,snapshot.source_files[0]]};
  assert.ok(validateReviewedKeyinPackage(duplicate,caseData,records,now)
    .some(problem=>problem.includes("Duplicate source-file IDs")));
  const duplicateRecords=[...records,{...records[0]}];
  assert.ok(validateReviewedKeyinPackage(snapshot,caseData,duplicateRecords,now)
    .some(problem=>problem.includes("Duplicate source-file IDs")));
});
test("reviewed insured names match regardless of order or punctuation, not identity",()=>{
  const {snapshot,item:caseData,records}=ready();
  const order={...caseData,insured:{...caseData.insured,name:"INSURED, TEST"}};
  assert.deepEqual(validateReviewedKeyinPackage(snapshot,order,records,now),[]);
  const wrong={...caseData,insured:{...caseData.insured,name:"TEST INSURED JR"}};
  assert.ok(validateReviewedKeyinPackage(snapshot,wrong,records,now)
    .some(issue=>issue.includes("policy.insured")));
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createBrokerReview, confirmBrokerReviewSection } from "../lib/broker-keyin-review.mjs";
import { BrokerKeyinReviewStore } from "../local-server/broker-review-store.mjs";
import { createBdzip, readBdzip } from "../local-server/bdzip.mjs";
import {
  REVIEWED_V04, prepareReviewedExport, validateArchiveReviewedSnapshot,
  freezeReviewedExportInTransaction, ensureAuditorReviewedSchema, prepareAuditorReviewedRecord,
  saveAuditorReviewedRecord, loadAuditorReviewedRecord
} from "../local-server/reviewed-keyin-stage3.mjs";

const now="2026-10-22T16:00:00Z";
const pdf=Buffer.from("%PDF-1.4\nsynthetic safe data\n","utf8");
import { createHash } from "node:crypto";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const sha=hash(pdf);
const item=()=>({
  case_id:"CHG003",case_type:"auto_policy_change",
  policy:{company:"Aviva",policy_number:"POL001",client_code:"TEST001"},
  insured:{name:"EXAMPLE TEST",co_insured:[]},drivers:[],vehicles:[],documents:[],
  policy_change:{
    change_effective_date:"2026-10-22",
    requested_changes:[{
      id:"change1",type:"ADDRESS_CHANGE",subject_name:"Mailing",
      new_value:"123 Example Rd",effective_date:"2026-10-22"
    }],
    notes:"Hi U/W,\nAs insured's request, please change the mailing address to 123 Example Rd.\nEffective date: October 22, 2026."
  }
});
const records=()=>[{id:"doc1",sourceHash:sha,logicalDocuments:[{id:"logical1"}]}];
const prepare=()=>{
  let r=createBrokerReview(item(),{now,sourceFiles:[{id:"doc1",sha256:sha}]});
  for(const section of r.sections)
    r=confirmBrokerReviewSection(r,section.id,{
      actor:"PILOT-BROKER-1",expectedRevision:r.revision,
      referenceDate:"2026-10-22",now
    });
  return r;
};
const fakeManifest=(prepared,overrides={})=>({
  package_version:REVIEWED_V04, broker:{id:"PILOT-BROKER-1"},
  submitted_at:now, reviewed_keyin:prepared.manifestReview,...overrides
});
const fakeParts=prepared=>new Map([["reviewed-keyin.json",prepared.entry.bytes]]);
const mapping=()=>new Map([
  ["CHG003","AUD003"],["doc1","DOC003"],["logical1","SEC003"]
]);

test("v0.4 export preview is final and does not mutate draft",()=>{
  const draft=prepare();
  const prepared=prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now);
  assert.equal(draft.review_status,"DRAFT");
  assert.equal(prepared.requiresFinalize,true);
  assert.equal(prepared.snapshot.revision,draft.revision+1);
  assert.equal(prepared.snapshot.review_status,"BROKER_CONFIRMED");
  assert.equal(prepared.snapshot.finalized_by,"PILOT-BROKER-1");
  assert.equal(prepared.entry.path,"reviewed-keyin.json");
  assert.deepEqual(validateArchiveReviewedSnapshot(fakeParts(prepared),
    fakeManifest(prepared),item(),records()),prepared.snapshot);
});
test("incomplete section never exported as Broker confirmed",()=>{
  const draft=createBrokerReview(item(),{sourceFiles:[{id:"doc1",sha256:sha}]});
  assert.throws(()=>prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now),{status:422});
});
test("exact persisted final snapshot matches packaged bytes",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,document_id TEXT,actor TEXT,action TEXT,details_json TEXT,created_at TEXT);`);
  db.prepare("INSERT INTO cases(id) VALUES(?)").run("CHG003");
  const store=new BrokerKeyinReviewStore(db);
  const draft=prepare();
  db.prepare("INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at) VALUES(?,?,?,?,?)")
    .run("CHG003",draft.revision,draft.review_status,JSON.stringify(draft),draft.updated_at);
  const prepared=prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now);
  const stored=store.finalize("CHG003",{
    actor:"PILOT-BROKER-1",expectedRevision:draft.revision,submittedAt:now
  });
  assert.deepEqual(stored,prepared.snapshot);
  assert.deepEqual(JSON.parse(prepared.entry.bytes),stored);
  db.close();
});
test("v0.3 remains readable, cannot be upgraded by sneaking in reviewed file",()=>{
  assert.equal(validateArchiveReviewedSnapshot(new Map(),
    {package_version:"0.3-pilot"},item(),records()),null);
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  assert.throws(()=>validateArchiveReviewedSnapshot(fakeParts(prep),
    {package_version:"0.3-pilot"},item(),records()),{status:422});
});
test("v0.4 requires verified bytes, correct metadata and broker identity",()=>{
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  assert.throws(()=>validateArchiveReviewedSnapshot(new Map(),
    fakeManifest(prep),item(),records()),{status:422});
  const tampered=new Map(fakeParts(prep));
  tampered.set("reviewed-keyin.json",Buffer.from("{}"));
  assert.throws(()=>validateArchiveReviewedSnapshot(tampered,
    fakeManifest(prep),item(),records()),{status:422});
  assert.throws(()=>validateArchiveReviewedSnapshot(fakeParts(prep),
    fakeManifest(prep,{broker:{id:"ANOTHER-BROKER"}}),item(),records()),{status:422});
  assert.throws(()=>validateArchiveReviewedSnapshot(fakeParts(prep),
    fakeManifest(prep,{reviewed_keyin:{...prep.manifestReview,field_count:9}}),item(),records()),{status:422});
});
test("changing a PDF source hash rejects snapshot even with matching archive bytes",()=>{
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  assert.throws(()=>validateArchiveReviewedSnapshot(fakeParts(prep),
    fakeManifest(prep),item(),[{...records()[0],sourceHash:"a".repeat(64)}]),{status:422});
});
test("missing ID remap is rejected instead of silently leaving Broker document ID",()=>{
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  assert.throws(()=>prepareAuditorReviewedRecord(prep.snapshot,
    new Map([["CHG003","AUD003"]]),"AUD003"),{status:422});
});
test("imported worksheet persists original hash and mapped Case document IDs",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE imported_packages(package_id TEXT PRIMARY KEY);
    INSERT INTO cases(id) VALUES('AUD003');
    INSERT INTO imported_packages(package_id) VALUES('PKG003');`);
  ensureAuditorReviewedSchema(db);
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  const mapped=prepareAuditorReviewedRecord(prep.snapshot,mapping(),"AUD003");
  db.exec("BEGIN IMMEDIATE");
  saveAuditorReviewedRecord(db,"PKG003","AUD003",mapped);
  db.exec("COMMIT");
  const result=loadAuditorReviewedRecord(db,"AUD003");
  assert.equal(result.reviewedHash,prep.snapshot.snapshot_sha256);
  assert.equal(result.sheet.sourceCaseId,"AUD003");
  assert.equal(result.sheet.brokerReview,"BROKER_CONFIRMED");
  assert.match(JSON.stringify(result.sheet),/Requested Changes/);
  assert.equal(loadAuditorReviewedRecord(db,"AUD003").packageId,"PKG003");
  const before=JSON.parse(db.prepare("SELECT original_snapshot_json FROM imported_reviewed_keyin").get().original_snapshot_json);
  assert.equal(before.source_case_id,"CHG003");
  assert.equal(before.snapshot_sha256,prep.snapshot.snapshot_sha256);
  db.close();
});
test("missing reviewed worksheet returns legacy 404 rather than forged confirmation",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec("CREATE TABLE imported_packages(package_id TEXT PRIMARY KEY); CREATE TABLE cases(id TEXT PRIMARY KEY);");
  ensureAuditorReviewedSchema(db);
  assert.throws(()=>loadAuditorReviewedRecord(db,"OLD"),{status:404});
  db.close();
});
test("SQLite tampering of original snapshot fails verified read",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE imported_packages(package_id TEXT PRIMARY KEY);
    INSERT INTO cases(id) VALUES('AUD003');
    INSERT INTO imported_packages(package_id) VALUES('PKG003');`);
  ensureAuditorReviewedSchema(db);
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  saveAuditorReviewedRecord(db,"PKG003","AUD003",
    prepareAuditorReviewedRecord(prep.snapshot,mapping(),"AUD003"));
  db.prepare("UPDATE imported_reviewed_keyin SET snapshot_sha256=? WHERE package_id=?")
    .run("0".repeat(64),"PKG003");
  assert.throws(()=>loadAuditorReviewedRecord(db,"AUD003"),{status:409});
  db.close();
});
test("BDZIP writer/reader supports reviewed entry and rejects an unlisted path",()=>{
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  const archive=createBdzip([
    {path:"case.json",bytes:Buffer.from("{}")},
    {path:"document-records.json",bytes:Buffer.from("[]")},
    {path:prep.entry.path,bytes:prep.entry.bytes},
    {path:"documents/example.pdf",bytes:pdf},
    {path:"manifest.json",bytes:Buffer.from("{}")}
  ]);
  const extracted=readBdzip(archive);
  assert.equal(extracted.get("reviewed-keyin.json").toString("utf8"),prep.entry.bytes.toString("utf8"));
  assert.throws(()=>createBdzip([{path:"../bad",bytes:pdf}]),{status:400});
});

test("Auditor vehicle driver assignment displays name before role, without absent roles",()=>{
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  const snapshot=structuredClone(prep.snapshot);
  snapshot.fields.push({
    id:"driver:D1.name",section:"drivers",label:"Driver name",
    value:"JOHN SAMPLE",origin:"BROKER_CORRECTED",evidence:[]
  },{
    id:"vehicle:V1.driverAssignments",section:"vehicles",label:"Assigned Driver -> Role",
    value:[{driverId:"D1",role:"PRINCIPAL"}],origin:"BROKER_CORRECTED",evidence:[]
  });
  snapshot.sections.push({id:"drivers",title:"Drivers"},{id:"vehicles",title:"Vehicles"});
  const mapped=prepareAuditorReviewedRecord(snapshot,mapping(),"AUD003");
  const roles=mapped.worksheet.sections.find(s=>s.id==="vehicles").rows.find(r=>
    r.id==="vehicle:V1.driverAssignments");
  assert.equal(roles.value,"JOHN SAMPLE — Principal");
  assert.doesNotMatch(roles.value,/Occasional|Excluded/);
});

test("SQLite worksheet alteration cannot masquerade as the original Broker sheet",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE imported_packages(package_id TEXT PRIMARY KEY);
    INSERT INTO cases(id) VALUES('AUD003');
    INSERT INTO imported_packages(package_id) VALUES('PKG003');`);
  ensureAuditorReviewedSchema(db);
  const prep=prepareReviewedExport(prepare(),item(),records(),"PILOT-BROKER-1",now);
  saveAuditorReviewedRecord(db,"PKG003","AUD003",
    prepareAuditorReviewedRecord(prep.snapshot,mapping(),"AUD003"));
  const sheet=JSON.parse(db.prepare("SELECT worksheet_json FROM imported_reviewed_keyin").get().worksheet_json);
  sheet.sections[0].rows[0].value="INCORRECT";
  db.prepare("UPDATE imported_reviewed_keyin SET worksheet_json=? WHERE package_id=?")
    .run(JSON.stringify(sheet),"PKG003");
  assert.throws(()=>loadAuditorReviewedRecord(db,"AUD003"),{status:409});
  db.close();
});

test("review freeze and outbound package roll back together when package recording fails",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,document_id TEXT,actor TEXT,action TEXT,details_json TEXT,created_at TEXT);
    CREATE TABLE outbound_submissions(package_id TEXT PRIMARY KEY,case_id TEXT,
      UNIQUE(case_id));
    INSERT INTO cases(id) VALUES('CHG003');
    INSERT INTO outbound_submissions(package_id,case_id) VALUES('FIRST','CHG003');`);
  const store=new BrokerKeyinReviewStore(db);
  const draft=prepare();
  db.prepare("INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at) VALUES(?,?,?,?,?)")
    .run("CHG003",draft.revision,draft.review_status,JSON.stringify(draft),draft.updated_at);
  const prepared=prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now);
  db.exec("BEGIN IMMEDIATE");
  try {
    freezeReviewedExportInTransaction(db,prepared,"CHG003","PILOT-BROKER-1");
    assert.throws(()=>db.prepare("INSERT INTO outbound_submissions(package_id,case_id) VALUES(?,?)")
      .run("SECOND","CHG003"), /UNIQUE constraint failed/);
    db.exec("ROLLBACK");
  }catch(e){ if(db.isTransaction) db.exec("ROLLBACK");throw e; }
  const after=store.read("CHG003");
  assert.equal(after.review_status,"DRAFT");
  assert.equal(after.revision,draft.revision);
  assert.equal(db.prepare("SELECT COUNT(*) as n FROM audit_events").get().n,0);
  assert.equal(db.prepare("SELECT COUNT(*) as n FROM outbound_submissions").get().n,1);
  db.close();
});

test("successful package transaction atomically stores exact final revision",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,document_id TEXT,actor TEXT,action TEXT,details_json TEXT,created_at TEXT);
    CREATE TABLE outbound_submissions(package_id TEXT PRIMARY KEY,case_id TEXT);
    INSERT INTO cases(id) VALUES('CHG003');`);
  const store=new BrokerKeyinReviewStore(db);
  const draft=prepare();
  db.prepare("INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at) VALUES(?,?,?,?,?)")
    .run("CHG003",draft.revision,draft.review_status,JSON.stringify(draft),draft.updated_at);
  const prepared=prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now);
  db.exec("BEGIN IMMEDIATE");
  freezeReviewedExportInTransaction(db,prepared,"CHG003","PILOT-BROKER-1");
  db.prepare("INSERT INTO outbound_submissions(package_id,case_id) VALUES(?,?)").run("GOOD","CHG003");
  db.exec("COMMIT");
  assert.deepEqual(store.read("CHG003"),prepared.snapshot);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='BROKER_REVIEW_FINALIZED'").get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbound_submissions").get().n,1);
  db.close();
});

test("prepared package never freezes a modified review revision or another Broker",()=>{
  const db=new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE cases(id TEXT PRIMARY KEY);
    CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,document_id TEXT,actor TEXT,action TEXT,details_json TEXT,created_at TEXT);
    INSERT INTO cases(id) VALUES('CHG003');`);
  const store=new BrokerKeyinReviewStore(db),draft=prepare();
  db.prepare("INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at) VALUES(?,?,?,?,?)")
    .run("CHG003",draft.revision,draft.review_status,JSON.stringify(draft),draft.updated_at);
  const prepared=prepareReviewedExport(draft,item(),records(),"PILOT-BROKER-1",now);
  db.exec("BEGIN IMMEDIATE");
  assert.throws(()=>freezeReviewedExportInTransaction(db,prepared,"CHG003","PILOT-BROKER-2"),{status:409});
  const changed=structuredClone(draft);changed.updated_at="2026-10-22T17:00:00Z";
  db.prepare("UPDATE keyin_reviews SET review_json=? WHERE case_id=?").run(JSON.stringify(changed),"CHG003");
  assert.throws(()=>freezeReviewedExportInTransaction(db,prepared,"CHG003","PILOT-BROKER-1"),{status:409});
  db.exec("ROLLBACK");
  assert.equal(store.read("CHG003").review_status,"DRAFT");
  db.close();
});

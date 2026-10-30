/**
 * Step 3D: actual Broker v0.4 BDZIP -> independent Auditor SQLite import.
 * Every case name, VIN, licence, hash and file byte is synthetic.
 * Tests the post-extraction/manual-verification path, not OCR or insurer key-in.
 * Run on Windows Node 24 (the production pilot's authoritative Intake runtime).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDatabase} from "../local-server/database.mjs";
import {resolveDataPaths} from "../local-server/paths.mjs";
import {LocalRepositories} from "../local-server/repositories.mjs";
import {BrokerReviewService} from "../local-server/broker-review-integration.mjs";
import {SubmissionPilotService} from "../local-server/submission-service.mjs";
import {createBlankAutoCase} from "../lib/case-factories.ts";
import {readBdzip,createBdzip} from "../local-server/bdzip.mjs";

const ACTOR="PILOT-BROKER-1";
const CAR_ID="SYN-CAR-3D";
const DRIVER_ID="SYN-DRIVER-3D-1";
const OTHER_ID="SYN-DRIVER-3D-2";
const OLD_VIN="1HGCM82633A004352";
const NEW_VIN="1HGCM82633A004353";
const OLD_LICENCE="D1234-56789-01234";
const NEW_LICENCE="D9988-77777-00001";
const OTHER_LICENCE="J1111-22222-33333";
const day=new Date().toISOString().slice(0,10);
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const section=(id,fileId,type,subjectId)=>({
  id,physicalFileId:fileId,documentType:type,title:"Synthetic "+type,
  ...(subjectId?{subjectId,subjectType:"VEHICLE"}:{}),
  presenceStatus:"FOUND",parseStatus:"PARSED",validationStatus:"VALID",
  classificationSource:"MANUAL",startPage:1,endPage:1
});

function fixture({ownershipFileVin=NEW_VIN}={}){
  const root=mkdtempSync(join(tmpdir(),"brokerdesk-step3d-"));
  const brokerPaths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:join(root,"broker")});
  const auditorPaths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:join(root,"auditor")});
  const db=openDatabase(brokerPaths.database),repo=new LocalRepositories(db,brokerPaths);
  const adb=openDatabase(auditorPaths.database),ar=new LocalRepositories(adb,auditorPaths);
  const broker=new SubmissionPilotService(db,brokerPaths,repo,{reviewedV04:true});
  const auditor=new SubmissionPilotService(adb,auditorPaths,ar,{reviewedV04:false});
  const review=new BrokerReviewService(db,repo);
  const item=createBlankAutoCase();
  item.policy.company="Intact";
  item.policy.client_code="SYN3D";
  item.policy.auto_quote_number="SYN-QUOTE-3D";
  item.policy.quote_number="SYN-QUOTE-3D";
  item.policy.effective_date=day;
  item.policy.mailing_address="100 Synthetic Lane, Toronto, ON";
  item.insured.name="JOHN DOE";
  item.insured.co_insured=[];
  item.drivers=[
    {id:DRIVER_ID,name:"JOHN DOE",dob:"1985-02-14",licence_number:OLD_LICENCE,
      licence_class:"G",licence_province:"ON",mvr_received:day,
      convictions:[],mvr_convictions:[],telematics:{enabled:false}},
    {id:OTHER_ID,name:"JANE EXAMPLE",dob:"1988-03-15",licence_number:OTHER_LICENCE,
      licence_class:"G",licence_province:"ON",mvr_received:day,
      convictions:[],mvr_convictions:[],telematics:{enabled:false}}
  ];
  // The Broker's saved VIN is old. The separately reviewed Ownership metadata
  // identifies the replacement VIN. Only a confirmed Review may project it.
  item.vehicles=[{
    id:CAR_ID,year:2003,make:"HONDA",model:"ACCORD",vin:OLD_VIN,
    primary_use:"pleasure",annual_km:8000,commute_km:0,
    owned:true,leased:false,winter_tires:false,parking:"Driveway",
    ownership:{received:true,vin:NEW_VIN,year:2003,make:"HONDA",model:"ACCORD",
      registered_owner:"JOHN DOE",additional_owners:[],
      address:"100 Synthetic Lane, Toronto, ON",leased:false,lessor:null,lienholder:null}
  }];
  repo.upsertCase({case:item},"CREATE_CASE");
  const ids={};
  function upload(type,id,vin){
    const sec=id+"S";
    // The synthetic MVR/DASH bytes expressly contain zero-record assertions.
    // No unreadable report is silently converted to a clean report.
    // The physical synthetic report bytes explicitly state the report-wide total.
    // This is a test declaration, NOT proof of a driver's lifetime history.
    const countKey=type==="MVR"?"reportedConvictionCount":type==="DASH"?"reportedClaimCount":null;
    const countLabel=type==="MVR"?"TOTAL REPORTED CONVICTIONS: 0":
      type==="DASH"?"TOTAL REPORTED CLAIMS (ENTIRE REPORT): 0":null;
    const reportFact=countLabel?" | "+countLabel+" | "+(type==="MVR"?"convictions=[]":"claims=[]"):"";
    const bytes=Buffer.from("SYNTHETIC STEP 3D | "+type+" | "+id+" | "+(vin??"")+reportFact+"\n");
    const reportData=type==="MVR"?{pulledDate:day,reportedConvictionCount:0,convictions:[]}:
      type==="DASH"?{pulledDate:day,reportedClaimCount:0,claims:[]}:null;
    const record={
      id,fileName:id+".pdf",mimeType:"application/pdf",size:bytes.length,
      documentType:type,state:"PARSED",
      classification:{documentType:type,confidence:1,reason:"synthetic manual evidence"},
      logicalDocuments:[section(sec,id,type,type==="OWNERSHIP"?CAR_ID:null)],
      ...(countKey?{packagePages:[{
        page:1,pageNumber:1,text:bytes.toString("utf8"),confidence:1,
        extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",
        classification:{documentType:type,confidence:1,reason:"synthetic explicit count page"}
      }]}:{}),
      ...(type==="OWNERSHIP"?{parsedSources:[{
        documentId:id,documentType:type,logicalDocumentId:sec,
        parsedAt:new Date().toISOString(),confidence:1,
        data:{vin},warnings:[],fieldEvidence:{}
      }]}:reportData?{parsedSources:[{
        documentId:id,documentType:type,logicalDocumentId:sec,
        parsedAt:new Date().toISOString(),confidence:1,
        data:reportData,warnings:[],
        fieldEvidence:{pulledDate:[{page:1,source:"synthetic-fixture",confidence:1}],
          [countKey]:[{page:1,documentId:id,logicalDocumentId:sec,sourceHash:sha(bytes),
            documentType:type,text:countLabel,confidence:1}]}
      }]}:{})
    };
    ids[type]={id,sec,bytes,stored:repo.saveDocument(item.case_id,record,bytes,id+".pdf")};
  }
  upload("AUTO_APPLICATION","SYN3DAPP");
  upload("AUTO_QUOTE","SYN3DQUO");
  upload("OWNERSHIP","SYN3DOWN",ownershipFileVin);
  upload("MVR","SYN3DMVR");
  upload("DASH","SYN3DDASH");
  repo.saveSignedCase(item.case_id,{
    ...repo.getCase(item.case_id),signed_document_id:ids.AUTO_APPLICATION.id,
    signed_logical_document_id:ids.AUTO_APPLICATION.sec
  },"SIGNED_VERIFIED");
  repo.saveNamedInsuredComparison(item.case_id,{
    applicationDocumentId:ids.AUTO_APPLICATION.id,
    applicationLogicalDocumentId:ids.AUTO_APPLICATION.sec,
    quoteDocumentId:ids.AUTO_QUOTE.id,
    quoteLogicalDocumentId:ids.AUTO_QUOTE.sec,
    applicationNames:["DOE, JOHN"],quoteNames:["JOHN DOE"]
  },ACTOR);
  return {root,db,adb,repo,ar,broker,auditor,review,ids,caseId:item.case_id,
    close(){db.close();adb.close();rmSync(root,{recursive:true,force:true});}};
}

function confirmCorrection(f,licence=NEW_LICENCE) {
  let state=f.review.create(f.caseId,{actor:ACTOR});
  const fields=new Set(state.review.fields.map(field=>field.id));
  const edits=new Map([
    ["vehicle:"+CAR_ID+".vin",NEW_VIN],
    ["driver:"+DRIVER_ID+".licenceNumber",licence],
    ["vehicle:"+CAR_ID+".commute",false],
    ["vehicle:"+CAR_ID+".parkingSameAsMailing",true],
    ["vehicle:"+CAR_ID+".driverAssignments",[
      {driverId:DRIVER_ID,role:"PRINCIPAL"},
      {driverId:OTHER_ID,role:"OCCASIONAL"}
    ]],
    ["vehicle:"+CAR_ID+".liability",1000000],
    ["vehicle:"+CAR_ID+".allPerils.present",false],
    ["vehicle:"+CAR_ID+".collision.present",false],
    ["vehicle:"+CAR_ID+".comprehensive.present",false],
    ["vehicle:"+CAR_ID+".opcf",[]],
    ["quoteDiscounts.checkedAgainstQuote",true]
  ]);
  for(const field of state.review.fields) {
    if(field.id.startsWith("document:")&&field.id.endsWith(".received"))
      edits.set(field.id,true);
  }
  for(const [fieldId,value] of edits) {
    assert(fields.has(fieldId),"Expected field missing from real Broker Review: "+fieldId);
    state=f.review.edit(f.caseId,{
      actor:ACTOR,expectedRevision:state.review.revision,fieldId,value
    });
  }
  for(const part of state.review.sections) {
    try {
      state=f.review.confirm(f.caseId,{
        actor:ACTOR,expectedRevision:state.review.revision,sectionId:part.id
      });
    } catch(error) {
      throw new Error("Step 3D Broker section "+part.id+": "+
        JSON.stringify(error.blockers??[error.message]),{cause:error});
    }
  }
  assert.equal(state.ready,true,"Broker Review not ready: "+
    JSON.stringify({source:state.sourceIssues,fields:state.fieldIssues}));
  return state;
}
const row=(sheet,id)=>sheet.sections.flatMap(s=>s.rows).find(r=>r.id===id);

test("actual v0.4 BDZIP carries confirmed VIN and Licence into independent Auditor",()=>{
  const f=fixture();
  try {
    const original=f.repo.getCase(f.caseId);
    assert.equal(original.vehicles[0].vin,OLD_VIN);
    assert.equal(original.drivers[0].licence_number,OLD_LICENCE);
    confirmCorrection(f);
    const gate=f.broker.preflight(f.caseId);
    assert.equal(gate.passed,true,"Broker hard blockers: "+JSON.stringify(gate.blockers));
    const bundle=f.broker.exportCase(f.caseId,{id:ACTOR,name:"Synthetic Pilot Broker"});
    assert.equal(bundle.manifest.package_version,"0.4-reviewed-keyin");
    assert.equal(bundle.manifest.system,"new-business");
    assert.equal(bundle.manifest.preflight.passed,true);
    assert.equal(bundle.archive.subarray(0,4).toString("hex"),"504b0304");
    const archive=readBdzip(bundle.archive);
    assert(archive.has("reviewed-keyin.json"));
    const outbound=JSON.parse(archive.get("case.json").toString("utf8"));
    assert.equal(outbound.vehicles[0].vin,NEW_VIN);
    assert.equal(outbound.vehicles[0].ownership.vin,NEW_VIN);
    assert.equal(outbound.drivers[0].licence_number,NEW_LICENCE);
    assert.equal(outbound.drivers[1].licence_number,OTHER_LICENCE);
    assert.equal(outbound.drivers[0].id,DRIVER_ID);
    assert.equal(outbound.drivers[1].id,OTHER_ID);
    // Editing Review/creating the archive must not rewrite the Broker source.
    const unchanged=f.repo.getCase(f.caseId);
    assert.equal(unchanged.vehicles[0].vin,OLD_VIN);
    assert.equal(unchanged.drivers[0].licence_number,OLD_LICENCE);
    const records=JSON.parse(archive.get("document-records.json").toString("utf8"));
    const ownership=records.find(d=>d.id===f.ids.OWNERSHIP.id);
    assert(ownership);
    assert.equal(ownership.sourceHash,sha(f.ids.OWNERSHIP.bytes));
    assert.equal(ownership.parsedSources[0].data.vin,NEW_VIN);
    assert.equal(archive.get(ownership.package_file_path).equals(f.ids.OWNERSHIP.bytes),true);
    const snapshot=JSON.parse(archive.get("reviewed-keyin.json").toString("utf8"));
    assert.equal(snapshot.fields.find(x=>x.id==="vehicle:"+CAR_ID+".vin").value,NEW_VIN);
    assert.equal(snapshot.fields.find(x=>x.id==="driver:"+DRIVER_ID+".licenceNumber").value,NEW_LICENCE);
    assert.equal(bundle.manifest.reviewed_keyin.sha256,sha(archive.get("reviewed-keyin.json")));
    const imported=f.auditor.importArchive(bundle.archive,bundle.filename);
    assert.equal(imported.imported,true);
    assert.equal(imported.system,"new-business");
    assert.notEqual(imported.case_id,f.caseId);
    const received=f.ar.getCase(imported.case_id);
    assert.equal(received.vehicles[0].vin,NEW_VIN);
    assert.equal(received.drivers[0].licence_number,NEW_LICENCE);
    assert.equal(received.drivers[1].licence_number,OTHER_LICENCE);
    assert(f.ar.signedEvidenceStillValid(received));
    assert(f.ar.namedInsuredComparisonStillValid(received));
    const auditDocs=f.ar.listDocuments(imported.case_id);
    assert.equal(auditDocs.length,5);
    const auditOwnership=auditDocs.find(d=>d.documentType==="OWNERSHIP");
    assert(auditOwnership);
    assert.notEqual(auditOwnership.id,f.ids.OWNERSHIP.id);
    assert.equal(auditOwnership.sourceHash,sha(f.ids.OWNERSHIP.bytes));
    assert.equal(auditOwnership.parsedSources[0].data.vin,NEW_VIN);
    const reviewed=f.auditor.readReviewedKeyin(imported.case_id);
    assert.equal(reviewed.sheet.brokerReview,"BROKER_CONFIRMED");
    assert.equal(reviewed.reviewedHash,snapshot.snapshot_sha256);
    assert.equal(row(reviewed.sheet,"vehicle:"+CAR_ID+".vin").originalValue,NEW_VIN);
    assert.equal(row(reviewed.sheet,"driver:"+DRIVER_ID+".licenceNumber").originalValue,NEW_LICENCE);
    assert.match(row(reviewed.sheet,"vehicle:"+CAR_ID+".driverAssignments").value,/JOHN DOE.*Principal.*JANE EXAMPLE.*Occasional/);
    assert.equal(f.auditor.listInbox("new-business").length,1);
    assert.equal(f.auditor.listInbox("policy-change").length,0);
    assert.equal(f.auditor.importArchive(bundle.archive,bundle.filename).duplicate,true);
    assert.equal(f.auditor.listInbox("new-business").length,1);
    const forged=new Map(archive);
    const changed=Buffer.from(forged.get(ownership.package_file_path));
    changed[0]^=1;
    forged.set(ownership.package_file_path,changed);
    const altered=createBdzip([...forged].map(([path,bytes])=>({path,bytes})));
    assert.throws(()=>f.auditor.importArchive(altered,bundle.filename),/SHA-256 mismatch/);
    assert.equal(f.auditor.listInbox("new-business").length,1);
  } finally {f.close();}
});

test("old VIN Ownership cannot validate a corrected VIN even when Case metadata says corrected",()=>{
  const f=fixture({ownershipFileVin:OLD_VIN});
  try {
    confirmCorrection(f);
    const before=f.broker.preflight(f.caseId);
    assert.equal(before.passed,false,"Old source Ownership must not validate corrected VIN");
    assert(before.blockers.some(b=>b.code==="INTAKE_VEHICLE_OWNERSHIP"),
      "Missing Ownership mismatch blocker: "+JSON.stringify(before.blockers));
    assert.throws(()=>f.broker.exportCase(f.caseId,{id:ACTOR,name:"Synthetic Pilot Broker"}),/hard blockers/);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbound_submissions").get().n,0);
    assert.equal(f.auditor.listInbox("new-business").length,0);
  } finally {f.close();}
});

test("Ownership with matching vehicle ID but no readable VIN is rejected by Intake",()=>{
  const f=fixture({ownershipFileVin:""});
  try {
    confirmCorrection(f);
    const result=f.broker.preflight(f.caseId);
    assert.equal(result.passed,false);
    assert(result.blockers.some(b=>b.code==="INTAKE_VEHICLE_OWNERSHIP"),
      "Missing VIN must not pass using vehicle subjectId: "+JSON.stringify(result.blockers));
    assert.throws(()=>f.broker.exportCase(f.caseId,{id:ACTOR,name:"Synthetic Pilot Broker"}),/hard blockers/);
    assert.equal(f.auditor.listInbox("new-business").length,0);
  } finally {f.close();}
});

test("duplicate corrected Licence cannot attach to a second Driver or export",()=>{
  const f=fixture();
  try {
    confirmCorrection(f,OTHER_LICENCE);
    const gate=f.broker.preflight(f.caseId);
    assert.equal(gate.passed,false);
    assert(gate.blockers.some(b=>b.code==="BROKER_CASE_PROJECTION"),
      "Duplicate Driver licence was not rejected: "+JSON.stringify(gate.blockers));
    assert.throws(()=>f.broker.exportCase(f.caseId,{id:ACTOR,name:"Synthetic Pilot Broker"}),/mapped|projection|issues|safely/i);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbound_submissions").get().n,0);
  } finally {f.close();}
});

test("physical Ownership edits after Broker confirmation prevent BDZIP export",()=>{
  const f=fixture();
  try {
    confirmCorrection(f);
    const owner=f.repo.documentPath(f.ids.OWNERSHIP.id);
    assert(owner?.path);
    appendFileSync(owner.path,Buffer.from("SYNTHETIC MUTATION AFTER BROKER REVIEW\n"));
    assert.throws(()=>f.broker.exportCase(f.caseId,{id:ACTOR,name:"Synthetic Pilot Broker"}),/integrity|source/i);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM outbound_submissions").get().n,0);
    assert.equal(f.auditor.listInbox("new-business").length,0);
  } finally {f.close();}
});

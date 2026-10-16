import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { SubmissionPilotService } from "../local-server/submission-service.mjs";
import { readBdzip, createBdzip } from "../local-server/bdzip.mjs";
import { createBlankHabCase, createBlankPolicyChangeCase, createBlankAutoCase } from "../lib/case-factories.ts";
import { evaluateIntakeProfile } from "../lib/intake-profile.ts";
import { createHash } from "node:crypto";

const root=mkdtempSync(join(tmpdir(),"brokerdesk-submission-pilot-"));
const paths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:root});
const db=openDatabase(paths.database);
const repo=new LocalRepositories(db,paths);
const pilot=new SubmissionPilotService(db,paths,repo,{allowedBrokerIds:"PILOT-BROKER-1,PILOT-BROKER-2"});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const now="2026-10-16";
const section=(id,physicalFileId,documentType)=>({
  id,physicalFileId,documentType,title:"Synthetic signed evidence",
  presenceStatus:"FOUND",parseStatus:"PARSED",validationStatus:"VALID",
  classificationSource:"MANUAL",startPage:1,endPage:1
});
function addDoc(item,type,id) {
  const bytes=Buffer.from("Synthetic fixture content " + id);
  const fileName=id+".pdf";
  return repo.saveDocument(item.case_id,{
    id,fileName,mimeType:"application/pdf",size:bytes.length,
    documentType:type,classification:{documentType:type,confidence:1,reason:"Synthetic"},
    state:"PARSED",logicalDocuments:[section(id+"S",id,type)],
  },bytes,fileName);
}
function baseHome() {
  const item=createBlankHabCase();
  item.policy.client_code="SYNH01";item.policy.company="Pembridge";item.policy.effective_date=now;
  item.insured.name="SYNTHETIC HOME PERSON";item.habitational_risk.risk_address="1 Fake Sample Road";
  return item;
}
function baseChange() {
  const item=createBlankPolicyChangeCase();
  item.policy.client_code="SYNP01";item.policy.company="Intact";item.policy.effective_date=now;
  item.insured.name="SYNTHETIC POLICY PERSON";
  item.policy_change.transaction_types=["CANCELLATION"];
  item.policy_change.requested_action="Cancellation";item.policy_change.change_effective_date=now;
  return item;
}
try {
  // ZIP is real standards-conforming bytes, not JSON renamed to .bdzip.
  const sample=createBdzip([{path:"case.json",bytes:Buffer.from("{}")},{path:"manifest.json",bytes:Buffer.from("{}")}]);
  assert.equal(sample.subarray(0,4).toString("hex"),"504b0304");
  assert.equal(readBdzip(sample).get("case.json").toString("utf8"),"{}");
  const corrupted=Buffer.from(sample);corrupted[39]^=1;
  assert.throws(()=>readBdzip(corrupted),/CRC|Malformed|header/i);
  assert.throws(()=>createBdzip([{path:"../case.json",bytes:Buffer.from("")}]),/Unsafe/);
  assert.throws(()=>createBdzip([{path:"case.json",bytes:Buffer.from("")},{path:"case.json",bytes:Buffer.from("")}]),/Duplicate/);

  const auto=createBlankAutoCase();auto.policy.company="Pembridge";
  auto.vehicles=[{id:"V-1",year:2026,make:"HONDA",model:"CRV",vin:"TESTVIN0000000001",
    owned:true,leased:false,primary_use:"Pleasure",annual_km:8000,commute_km:0,
    business_use_percent:0,winter_tires:false,parking:"Driveway",garaging_address:"",
    ownership:{received:true,registered_owner:"SYNTHETIC",address:"SAMPLE",vin:"TESTVIN0000000001",
      year:2026,make:"HONDA",model:"CRV",leased:false,lessor:null,lienholder:null}},
    {id:"V-2",year:2026,make:"HONDA",model:"CRV",vin:"TESTVIN0000000002",
    owned:true,leased:false,primary_use:"Pleasure",annual_km:8000,commute_km:0,
    business_use_percent:0,winter_tires:false,parking:"Driveway",garaging_address:"",
    ownership:{received:true,registered_owner:"SYNTHETIC",address:"SAMPLE",vin:"TESTVIN0000000002",
      year:2026,make:"HONDA",model:"CRV",leased:false,lessor:null,lienholder:null}}];
  const onlyFirstOwnership={
    id:"OWN1",fileName:"synthetic_ownership.pdf",mimeType:"application/pdf",size:8,
    sourceHash:"hash-1",currentSourceHash:"hash-1",documentType:"OWNERSHIP",
    classification:{documentType:"OWNERSHIP",confidence:1,reason:"Fixture"},state:"PARSED",
    logicalDocuments:[section("OWN1S","OWN1","OWNERSHIP")],
    parsedSources:[{documentId:"OWN1",logicalDocumentId:"OWN1S",documentType:"OWNERSHIP",
      parsedAt:now,confidence:1,data:{vin:"TESTVIN0000000001"},warnings:[],fieldEvidence:{}}]
  };
  const ownershipCheck=evaluateIntakeProfile(auto,[onlyFirstOwnership]);
  assert(ownershipCheck.blockers.some(b=>b.code==="INTAKE_VEHICLE_OWNERSHIP"&&b.vehicle_id==="V-2"));
  assert(!ownershipCheck.blockers.some(b=>b.code==="INTAKE_VEHICLE_OWNERSHIP"&&b.vehicle_id==="V-1"));
  auto.policy.company="Economical";
  assert(evaluateIntakeProfile(auto,[]).blockers.some(b=>b.code==="INTAKE_ECONOMICAL_GROUP_UNCONFIRMED"));

  const home=baseHome();
  repo.upsertCase({case:home},"CREATE_CASE");
  addDoc(home,"HAB_APPLICATION","HABSIGNED");
  addDoc(home,"HAB_QUOTE","HABQUOTE");
  assert.throws(()=>pilot.exportCase(home.case_id,{id:"PILOT-BROKER-1",name:"Synthetic Broker One"}),/hard blockers/);
  const pending=repo.getCase(home.case_id);
  const signed=repo.saveSignedCase(home.case_id,{
    ...pending,signed_document_id:"HABSIGNED",signed_logical_document_id:"HABSIGNEDS"
  },"SIGNED_VERIFIED");
  assert.equal(signed.signed,true);
  const comparison={verified:true,applicationDocumentId:"HABSIGNED",applicationLogicalDocumentId:"HABSIGNEDS",
    quoteDocumentId:"HABQUOTE",quoteLogicalDocumentId:"HABQUOTES",
    applicationNames:["SYNTHETIC HOME PERSON"],quoteNames:["SYNTHETIC HOME PERSON"]};
  assert(evaluateIntakeProfile(repo.getCase(home.case_id),repo.listDocuments(home.case_id)).blockers.some(b=>b.code==="INTAKE_INSURED_NAME_EVIDENCE"));
  repo.saveNamedInsuredComparison(home.case_id,{...comparison,quoteNames:["SYNTHETIC HOME PERSON","SYNTHETIC SECOND PERSON"]});
  assert(evaluateIntakeProfile(repo.getCase(home.case_id),repo.listDocuments(home.case_id)).blockers.some(b=>b.code==="INTAKE_INSURED_NAME_MISMATCH"));
  repo.saveNamedInsuredComparison(home.case_id,comparison);
  assert(!evaluateIntakeProfile(repo.getCase(home.case_id),repo.listDocuments(home.case_id)).blockers.some(b=>b.code.startsWith("INTAKE_INSURED_NAME")));

  const original=pilot.exportCase(home.case_id,{id:"PILOT-BROKER-1",name:"Synthetic Broker One"});
  assert.match(original.filename,/^SYNH01-\d{8}-Pembridge-home\.bdzip$/);
  assert.equal(original.manifest.system,"new-business");
  assert.equal(original.manifest.preflight.passed,true);
  const unpacked=readBdzip(original.archive);
  assert(unpacked.has("case.json")); assert(unpacked.has("document-records.json"));
  assert.equal([...unpacked.keys()].filter(p=>p.startsWith("documents/")).length,2);
  const imported=pilot.importArchive(original.archive,original.filename);
  assert.equal(imported.imported,true);
  assert.notEqual(imported.case_id,home.case_id);
  const received=repo.getCase(imported.case_id);
  assert.equal(received.signed,true);
  assert(repo.signedEvidenceStillValid(received));
  assert.equal(repo.listDocuments(imported.case_id).length,2);
  assert.equal(pilot.listInbox("new-business").length,1);
  assert.equal(pilot.listInbox("policy-change").length,0);
  const duplicate=pilot.importArchive(original.archive,original.filename);
  assert.equal(duplicate.duplicate,true);
  assert.equal(pilot.listInbox("new-business").length,1);
  assert.throws(()=>pilot.updateTask(imported.package_id,"AUDITOR-2","claim"),/first local pilot Auditor/);
  const claimed=pilot.updateTask(imported.package_id,"AUDITOR-1","claim");
  assert.equal(claimed.status,"in_progress");
  assert.equal(claimed.assignee,"AUDITOR-1");
  assert.throws(()=>pilot.updateTask(imported.package_id,"AUDITOR-2","complete"),/first local pilot Auditor/);
  const complete=pilot.updateTask(imported.package_id,"AUDITOR-1","complete");
  assert.equal(complete.status,"completed");
  assert.throws(()=>pilot.updateTask(imported.package_id,"AUDITOR-1","claim"),/already completed/);

  // Tampered payload with unchanged manifest hash gets rejected before writing a Case.
  const altered=readBdzip(original.archive);
  const source=[...altered.keys()].find(p=>p.startsWith("documents/"));
  const tamperedBytes=Buffer.from(altered.get(source));
  tamperedBytes[0]^=1; // identical size; ZIP CRC recomputed, manifest SHA remains stale
  altered.set(source,tamperedBytes);
  const rebuilt=createBdzip([...altered].map(([path,bytes])=>({path,bytes})));
  const casesBefore=repo.listCases().length;
  assert.throws(()=>pilot.importArchive(rebuilt,original.filename),/SHA-256 mismatch/);
  assert.equal(repo.listCases().length,casesBefore);
  altered.set(source,unpacked.get(source)); // restore source for isolated allowlist test
  const badId=JSON.parse(altered.get("manifest.json").toString("utf8"));
  badId.package_id="another-unique-package-id";badId.broker.id="STRANGER";
  altered.set("manifest.json",Buffer.from(JSON.stringify(badId)));
  assert.throws(()=>pilot.importArchive(createBdzip([...altered].map(([path,bytes])=>({path,bytes})))),/Broker ID/);

  const policyChange=baseChange();
  repo.upsertCase({case:policyChange},"CREATE_CASE");
  addDoc(policyChange,"CANCELLATION_REQUEST","CANCEL_DOC");
  const auth=repo.saveTransactionAuthorization(policyChange.case_id,{
    verified:true,documentId:"CANCEL_DOC",logicalDocumentId:"CANCEL_DOCS",
    signers:[{name:"SYNTHETIC POLICY PERSON",documentId:"CANCEL_DOC",logicalDocumentId:"CANCEL_DOCS",signaturePage:1,verified:true}]
  },"PILOT-BROKER-2");
  assert.equal(auth.transaction_authorization.verified,true);
  const cancelPackage=pilot.exportCase(policyChange.case_id,{id:"PILOT-BROKER-2",name:"Synthetic Broker Two"});
  assert.match(cancelPackage.filename,/^SYNP01-\d{8}-Intact-cancellation\.bdzip$/);
  assert.equal(cancelPackage.manifest.system,"policy-change");
  const importedCancel=pilot.importArchive(cancelPackage.archive,cancelPackage.filename);
  assert.equal(importedCancel.system,"policy-change");
  assert.equal(pilot.listInbox("policy-change").length,1);
  const receivedChange=repo.getCase(importedCancel.case_id);
  assert(repo.transactionAuthorizationStillValid(receivedChange));
  // A package whose filename is misleading is still routed by the manifest.
  assert.equal(pilot.listInbox("new-business").length,1);

  const joint=baseChange();
  joint.insured.co_insured=[{name:"SYNTHETIC SECOND PERSON"}];
  repo.upsertCase({case:joint},"CREATE_CASE");
  addDoc(joint,"CANCELLATION_REQUEST","JOINT_REQ");
  const jointRequest={verified:true,documentId:"JOINT_REQ",logicalDocumentId:"JOINT_REQS"};
  const signer={name:"SYNTHETIC POLICY PERSON",documentId:"JOINT_REQ",logicalDocumentId:"JOINT_REQS",signaturePage:1,verified:true};
  const signer2={...signer,name:"SYNTHETIC SECOND PERSON"};
  assert.throws(()=>repo.saveTransactionAuthorization(joint.case_id,jointRequest),/distinct verified signature/);
  assert.throws(()=>repo.saveTransactionAuthorization(joint.case_id,{...jointRequest,signers:[signer,signer]}),/distinct verified signature/);
  assert.throws(()=>repo.saveTransactionAuthorization(joint.case_id,{...jointRequest,signers:[signer,{...signer2,verified:false}]}),/manual confirmation/);
  assert.throws(()=>repo.saveTransactionAuthorization(joint.case_id,{...jointRequest,signers:[signer,{...signer2,signaturePage:4}]}),/valid page/);
  const verifiedJoint=repo.saveTransactionAuthorization(joint.case_id,{...jointRequest,signers:[signer,signer2]});
  assert.equal(verifiedJoint.transaction_authorization.signers.length,2);
  assert(repo.transactionAuthorizationStillValid(verifiedJoint));
  repo.upsertCase({case:{...verifiedJoint,insured:{...verifiedJoint.insured,co_insured:[{name:"SYNTHETIC DIFFERENT PERSON"}]}}});
  assert.equal(repo.getCase(joint.case_id).transaction_authorization,undefined);
  const changed=baseChange();repo.upsertCase({case:changed},"CREATE_CASE");
  const changeEvidence=addDoc(changed,"CANCELLATION_REQUEST","CHANGED_REQ");
  repo.saveTransactionAuthorization(changed.case_id,{verified:true,documentId:"CHANGED_REQ",logicalDocumentId:"CHANGED_REQS",signers:[
    {name:"SYNTHETIC POLICY PERSON",documentId:"CHANGED_REQ",logicalDocumentId:"CHANGED_REQS",signaturePage:1,verified:true}]});
  repo.updateDocument("CHANGED_REQ",{...changeEvidence,documentType:"OTHER",logicalDocuments:changeEvidence.logicalDocuments.map(s=>({...s,documentType:"OTHER"}))});
  assert.equal(repo.getCase(changed.case_id).transaction_authorization,undefined);
  const mvrTest=createBlankAutoCase();mvrTest.drivers=[{name:"SYNTHETIC DRIVER",mvr_received:""}];
  assert(!evaluateIntakeProfile(mvrTest,[]).blockers.some(b=>b.code==="MVR_RECEIVED_DATE_MISSING"));
  const noAuth=baseChange();
  assert(evaluateIntakeProfile(noAuth,[]).blockers.some(b=>b.code==="INTAKE_CHANGE_AUTHORIZATION"));
  noAuth.policy_change.transaction_types=["ADD_VEHICLE"];
  assert(evaluateIntakeProfile(noAuth,[]).blockers.some(b=>b.code==="INTAKE_CHANGE_TARGET_UNCONFIRMED"));
  console.log("Broker/Auditor pilot submission and authoritative inbox: PASS");
} finally {
  db.close();rmSync(root,{recursive:true,force:true});
}

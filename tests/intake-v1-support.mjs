// Synthetic tests for v1.0 selected OPCFs, discounts, physical damage and quote age.
// All source bytes and policyholders are invented. No real customer documents.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { createBlankPolicyChangeCase } from "../lib/case-factories.ts";
import { checkOpcfSupport, checkDiscountSupport, evaluateIntakeWarnings,
  selectedOpcfCodes } from "../lib/intake-support-evidence.ts";
import { evaluateIntakeProfile } from "../lib/intake-profile.ts";

const temp=mkdtempSync(join(tmpdir(),"bd-intake-v1-rules-"));
const paths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:temp});
const db=openDatabase(paths.database);
const repo=new LocalRepositories(db,paths);
let sequence=0;
function blank(){
  const item=createBlankPolicyChangeCase();
  item.case_id="SYNTHETIC-"+(++sequence);
  item.policy.company="Intact";item.policy.client_code="SYN"+sequence;
  item.policy.effective_date="2026-10-16";item.insured.name="SYNTHETIC POLICY PERSON";
  item.policy_change.transaction_types=["ENDORSEMENT_CHANGE"];
  item.policy_change.requested_action="Endorsement Change";
  item.policy_change.change_effective_date="2026-10-16";
  item.vehicles=[{id:"V-1",vin:"SYNTHETICVIN00001",year:2011,make:"Honda",model:"CR-V",winter_tires:true},
    {id:"V-2",vin:"SYNTHETICVIN00002",year:2012,make:"Honda",model:"Civic",winter_tires:false}];
  item.drivers=[{id:"DR-1",name:"SYNTHETIC DRIVER",driver_training:true,retired:true,
    telematics:{enabled:false,app:"",phone:"",email:"",discount_percent:0},convictions:[],
    mvr_received:"2026-10-15",g1_date:"",g2_date:"",g_date:""}];
  return item;
}
const section=(id,type)=>({id:id+"SEC",physicalFileId:id,documentType:type,title:"Synthetic",
  presenceStatus:"FOUND",parseStatus:"PARSED",validationStatus:"VALID",
  classificationSource:"MANUAL",startPage:1,endPage:1});
function addDoc(item,type,id){
  const bytes=Buffer.from("Synthetic placeholder: "+id);
  return repo.saveDocument(item.case_id,{id,fileName:id+".pdf",mimeType:"application/pdf",
    documentType:type,classification:{documentType:type,confidence:1,reason:"synthetic"},
    state:"PARSED",logicalDocuments:[section(id,type)]},bytes,id+".pdf");
}
const proof=(purpose,code,subjectKey,id,signaturePage,signerName)=>({
  action:"verify",confirmed:true,purpose,code,subjectKey,documentId:id,
  logicalDocumentId:id+"SEC",
  ...(signaturePage===undefined?{}:{signaturePage,signerName})
});
try{
  const endorsement=blank();
  assert.deepEqual(selectedOpcfCodes(endorsement),[]); // A PDF filename alone is never a selection.
  endorsement.policy_change.endorsement_changes=[{
    endorsement:"OPCF 43",action:"ADD",new_status:"REQUESTED",vehicle:"V-2"
  }];
  repo.upsertCase({case:endorsement},"CREATE_CASE");
  assert(checkOpcfSupport(endorsement,[]).some(x=>x.code==="INTAKE_OPCF43_PROOF"));
  addDoc(endorsement,"BILL_OF_SALE","BILL_V1");
  repo.saveIntakeProof(endorsement.case_id,proof("OPCF43","43","V-1","BILL_V1"));
  assert(checkOpcfSupport(repo.getCase(endorsement.case_id),repo.listDocuments(endorsement.case_id))
    .some(x=>x.code==="INTAKE_OPCF43_PROOF"&&x.vehicle_id==="V-2"));
  addDoc(endorsement,"LEASE_DOCUMENT","LEASE_V2");
  assert.throws(()=>repo.saveIntakeProof(endorsement.case_id,
    proof("OPCF43","43","V-2","BILL_V1")),/cannot prove/);
  assert.throws(()=>repo.saveIntakeProof(endorsement.case_id,
    proof("OPCF43","43","V-2","MISSING")),/hashed and classified/);
  repo.saveIntakeProof(endorsement.case_id,proof("OPCF43","43","V-2","LEASE_V2"));
  assert(!checkOpcfSupport(repo.getCase(endorsement.case_id),repo.listDocuments(endorsement.case_id)).length);
  const signedCodes=["28A","49","19","13C"];
  const modified=repo.getCase(endorsement.case_id);
  modified.policy_change.endorsement_changes=[
    {endorsement:"OPCF 43",action:"ADD",new_status:"REQUESTED",vehicle:"V-2"},
    ...signedCodes.map(code=>({endorsement:"OPCF "+code,action:"ADD",new_status:"REQUESTED",vehicle:"V-2"})),
    {endorsement:"OPCF 49",action:"REMOVE",new_status:"REMOVED"}];
  repo.upsertCase({case:modified});
  assert.equal(selectedOpcfCodes(repo.getCase(endorsement.case_id)).length,5);
  assert.equal(checkOpcfSupport(repo.getCase(endorsement.case_id),repo.listDocuments(endorsement.case_id))
    .filter(x=>x.code==="INTAKE_OPCF_SIGNED_PROOF").length,4);
  addDoc(endorsement,"OPCF_FORM","SIGNED_OPCFS");
  assert.throws(()=>repo.saveIntakeProof(endorsement.case_id,
    proof("SIGNED_OPCF","28A","V-2","SIGNED_OPCFS",2,"SYNTHETIC POLICY PERSON")),
    /signature page/);
  for(const code of signedCodes)repo.saveIntakeProof(endorsement.case_id,
    proof("SIGNED_OPCF",code,"V-2","SIGNED_OPCFS",1,"SYNTHETIC POLICY PERSON"));
  assert(!checkOpcfSupport(repo.getCase(endorsement.case_id),repo.listDocuments(endorsement.case_id)).length);
  const actual=repo.listDocuments(endorsement.case_id).find(x=>x.id==="SIGNED_OPCFS");
  repo.updateDocument("SIGNED_OPCFS",{...actual,documentType:"OTHER",
    logicalDocuments:actual.logicalDocuments.map(x=>({...x,documentType:"OTHER"}))});
  assert(!(repo.getCase(endorsement.case_id).intake_support_evidence??[])
    .some(x=>x.purpose==="SIGNED_OPCF"));
  assert(checkOpcfSupport(repo.getCase(endorsement.case_id),repo.listDocuments(endorsement.case_id))
    .some(x=>x.code==="INTAKE_OPCF_SIGNED_PROOF"));

  // Only discounts confirmed as selected create blockers; factual retired/tires flags do not.
  const discounts=blank();
  repo.upsertCase({case:discounts},"CREATE_CASE");
  assert.equal(checkDiscountSupport(repo.getCase(discounts.case_id),[]).length,0);
  const declarations=[
    {kind:"DRIVER_TRAINING",subject_key:"DR-1"},{kind:"STUDENT",subject_key:"DR-1"},
    {kind:"WINTER_TIRES",subject_key:"V-1"},{kind:"ANTI_THEFT",subject_key:"V-2"},
    {kind:"RETIREE",subject_key:"DR-1"}];
  repo.saveIntakeDiscountReview(discounts.case_id,{selections:declarations});
  assert.equal(checkDiscountSupport(repo.getCase(discounts.case_id),[])
    .filter(x=>x.code==="INTAKE_DISCOUNT_PROOF").length,5);
  assert.throws(()=>repo.saveIntakeDiscountReview(discounts.case_id,
    {selections:[{kind:"WINTER_TIRES",subject_key:"DR-1"}]}),/distinct current driver or vehicle/);
  const dproofs=[
    ["DRIVER_TRAINING","DR-1","DRIVER_TRAINING_CERTIFICATE","TRAINING"],
    ["STUDENT","DR-1","STUDENT_PROOF","STUDENT_CARD"],
    ["WINTER_TIRES","V-1","WINTER_TIRE_PROOF","WINTER_CLAIM"],
    ["ANTI_THEFT","V-2","ANTI_THEFT_PROOF","ANTI_THEFT_INSTALL"],
    ["RETIREE","DR-1","RETIREMENT_PROOF","RETIREE_DECLARATION"]
  ];
  for(const [kind,key,type,id] of dproofs){
    addDoc(discounts,type,id);
    repo.saveIntakeProof(discounts.case_id,proof("DISCOUNT",kind,key,id));
  }
  assert(!checkDiscountSupport(repo.getCase(discounts.case_id),
    repo.listDocuments(discounts.case_id)).length);
  repo.deleteDocument("STUDENT_CARD");
  assert(checkDiscountSupport(repo.getCase(discounts.case_id),repo.listDocuments(discounts.case_id))
    .some(x=>x.code==="INTAKE_DISCOUNT_PROOF"&&/STUDENT/.test(x.message)));
  assert(!(repo.getCase(discounts.case_id).intake_support_evidence??[]).some(x=>x.code==="STUDENT"));
  // The same independent intake evaluator is invoked for Broker and Auditor preflights.
  assert(evaluateIntakeProfile(repo.getCase(discounts.case_id),repo.listDocuments(discounts.case_id))
    .blockers.some(x=>x.code==="INTAKE_DISCOUNT_PROOF"));

  // Warning boundaries are pure, deterministic and do not enter the blocker list.
  const warn=blank();
  warn.vehicles=[{...warn.vehicles[0],year:2011}];
  warn.intake_warning_facts={quote_issued_date:"2026-09-14",quote_bound:false,
    vehicle_physical_damage:[{vehicle_key:"V-1",selected:true}]};
  let warnings=evaluateIntakeWarnings(warn,[],"2026-10-16");
  assert(warnings.some(x=>x.code==="INTAKE_OLD_VEHICLE_PHYSICAL_DAMAGE"&&x.vehicle_id==="V-1"));
  assert(warnings.some(x=>x.code==="INTAKE_QUOTE_AGE"));
  assert(!evaluateIntakeWarnings({...warn,vehicles:[{...warn.vehicles[0],year:2012}]},
    [],"2026-10-16").some(x=>x.code==="INTAKE_OLD_VEHICLE_PHYSICAL_DAMAGE"));
  assert(!evaluateIntakeWarnings({...warn,intake_warning_facts:{
    ...warn.intake_warning_facts,quote_bound:true,vehicle_physical_damage:[]}},
    [],"2026-10-16").length);
  assert(!evaluateIntakeWarnings({...warn,intake_warning_facts:{
    quote_bound:false,vehicle_physical_damage:[]}},[],"2026-10-16").length);

  repo.upsertCase({case:warn},"CREATE_CASE");
  repo.saveIntakeWarningFacts(warn.case_id,warn.intake_warning_facts);
  addDoc(warn,"VEHICLE_PHOTO","PHOTO_FOR_OLD");
  assert.throws(()=>repo.saveIntakeProof(warn.case_id,
    proof("OLD_VEHICLE","PHYSICAL_DAMAGE","V-1","MISSING_PHOTO")),/hashed and classified/);
  repo.saveIntakeProof(warn.case_id,proof("OLD_VEHICLE","PHYSICAL_DAMAGE","V-1","PHOTO_FOR_OLD"));
  assert(!evaluateIntakeWarnings(repo.getCase(warn.case_id),repo.listDocuments(warn.case_id),"2026-10-16")
    .some(x=>x.code==="INTAKE_OLD_VEHICLE_PHYSICAL_DAMAGE"));
  const max={...warn,policy:{...warn.policy,company:"Max"},
    intake_warning_facts:{quote_issued_date:"2026-08-18",quote_bound:false}};
  assert(!evaluateIntakeWarnings(max,[],"2026-10-16").some(x=>x.code==="INTAKE_QUOTE_AGE"));
  max.intake_warning_facts.quote_issued_date="2026-08-16";
  assert(evaluateIntakeWarnings(max,[],"2026-10-16").some(x=>x.code==="INTAKE_QUOTE_AGE"));
  // Manual coverage/rate inputs cannot fabricate proof via an ordinary Case JSON update.
  const malicious={...repo.getCase(discounts.case_id),intake_support_evidence:[
    {purpose:"DISCOUNT",code:"STUDENT",subject_key:"DR-1",document_id:"FAKE",source_sha256:"FAKE",
     verified_at:new Date().toISOString(),verified_by:"FAKE"}]};
  repo.upsertCase({case:malicious});
  assert(!repo.getCase(discounts.case_id).intake_support_evidence.some(x=>x.document_id==="FAKE"));
  console.log("BrokerDesk v1 selected OPCF, discount proof and warning regressions: PASS");
} finally {
  db.close();rmSync(temp,{recursive:true,force:true});
}

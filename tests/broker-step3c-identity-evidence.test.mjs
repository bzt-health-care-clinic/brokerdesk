/**
 * BrokerDesk Step 3C — real repository + authoritative Intake regression.
 * All identities, records and bytes are synthetic. No external OCR.
 *
 * This deliberately tests the post-extraction integrity path, not PDF parsing.
 * Use Node 24, the same runtime as the BDZIP pilot.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,appendFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {openDatabase} from "../local-server/database.mjs";
import {resolveDataPaths} from "../local-server/paths.mjs";
import {LocalRepositories} from "../local-server/repositories.mjs";
import {SubmissionPilotService} from "../local-server/submission-service.mjs";
import {projectBrokerReviewedCase} from "../local-server/reviewed-case-projection-stage3b.mjs";
import {authoritativeIntake} from "../local-server/intake-bridge.mjs";
import {createBlankAutoCase} from "../lib/case-factories.ts";

const BROKER_ID = "PILOT-BROKER-1";
const ORIGINAL_VIN = "1HGCM82633A004352";
const CORRECTED_VIN = "1HGCM82633A004353";
const SECOND_VIN = "1HGCM82633A004354";
const INSURED = "JOHN DOE";
const today = new Date().toISOString().slice(0,10);

const activeSection=(id,fileId,type,subjectId)=>({
  id,physicalFileId:fileId,documentType:type,title:`Synthetic ${type}`,
  ...(subjectId?{subjectId,subjectType:"VEHICLE"}:{}),
  presenceStatus:"FOUND",parseStatus:"PARSED",validationStatus:"VALID",
  classificationSource:"MANUAL",startPage:1,endPage:1
});
const codeSet = result => new Set((result.blockers??[]).map(x=>x.code));
const has = (result, code) => codeSet(result).has(code);
const ensureNo = (result, codes) => {
  for(const code of codes) assert.equal(has(result,code),false,
    `${code} unexpectedly blocked: ${JSON.stringify(result.blockers)}`);
};
const projectionReview = (item,fields) => ({
  source_case_id:item.case_id,case_type:item.case_type,company:item.policy.company,
  review_status:"DRAFT",
  sections:[{id:"vehicles",status:"CONFIRMED",confirmation:{brokerId:BROKER_ID}}],
  fields:Object.entries(fields).map(([id,value])=>({id,value}))
});

function makeFixture(){
  const root=mkdtempSync(join(tmpdir(),"brokerdesk-step3c-"));
  const paths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:join(root,"broker")});
  const db=openDatabase(paths.database);
  const repo=new LocalRepositories(db,paths);
  const item=createBlankAutoCase();
  item.policy.company="Intact";
  item.policy.client_code="SYNTHETIC-3C";
  item.policy.quote_number="SYN-Q-3C";
  item.policy.auto_quote_number="SYN-Q-3C";
  item.policy.effective_date=today;
  item.policy.mailing_address="100 Example Lane, Toronto, ON";
  item.insured.name=INSURED;
  item.insured.co_insured=[];
  item.drivers=[{
    id:"SYN-DRIVER-1",name:INSURED,dob:"1985-02-14",
    licence_number:"D1234-56789-01234",licence_class:"G",
    licence_province:"ON",telematics:{enabled:false},
    convictions:[],mvr_convictions:[],mvr_received:today
  }];
  item.vehicles=[{
    id:"SYN-VEHICLE-1",year:2003,make:"HONDA",model:"ACCORD",
    vin:ORIGINAL_VIN,primary_use:"pleasure",annual_km:12000,
    ownership:{
      received:true,vin:ORIGINAL_VIN,year:2003,make:"HONDA",model:"ACCORD",
      registered_owner:INSURED,additional_owners:[],
      address:"100 Example Lane, Toronto, ON",leased:false,
      lessor:null,lienholder:null
    }
  }];
  repo.upsertCase({case:item},"CREATE_CASE");
  const docs={};

  function upload(type,id,sectionId,opts={}){
    // Unique bytes are on disk and are re-hashed by the real repository.
    // They are intentionally NOT parseable PDFs: parser accuracy is out of scope.
    const bytes=Buffer.from(`SYNTHETIC TEST FIXTURE | ${type} | ${opts.vin??""} | ${id}\n`);
    const record={
      id,fileName:`${id}.pdf`,mimeType:"application/pdf",
      size:bytes.length,documentType:type,state:"PARSED",
      classification:{documentType:type,confidence:1,reason:"synthetic-test"},
      logicalDocuments:[activeSection(sectionId,id,type,opts.subjectId)],
      ...(type==="OWNERSHIP"?{
        parsedSources:[{
          documentId:id,documentType:"OWNERSHIP",
          logicalDocumentId:sectionId,data:{vin:opts.vin},
          parsedAt:new Date().toISOString(),confidence:1,
          warnings:[],fieldEvidence:{}
        }]
      }:{})
    };
    const result=repo.saveDocument(item.case_id,record,bytes,`${id}.pdf`);
    docs[type]={id,sectionId,record:result,bytes};
    return result;
  }
  upload("AUTO_APPLICATION","SYNAPP3C","SYNAPP3CSEC");
  upload("AUTO_QUOTE","SYNQUO3C","SYNQUO3CSEC");
  upload("OWNERSHIP","SYNOWN3C","SYNOWN3CSEC",{
    vin:ORIGINAL_VIN,subjectId:"SYN-VEHICLE-1"
  });
  upload("MVR","SYNMVR3C","SYNMVR3CSEC");
  upload("DASH","SYNDASH3C","SYNDASH3CSEC");

  repo.saveSignedCase(item.case_id,{
    ...repo.getCase(item.case_id),
    signed_document_id:docs.AUTO_APPLICATION.id,
    signed_logical_document_id:docs.AUTO_APPLICATION.sectionId
  },"SIGNED_VERIFIED");
  repo.saveNamedInsuredComparison(item.case_id,{
    applicationDocumentId:docs.AUTO_APPLICATION.id,
    applicationLogicalDocumentId:docs.AUTO_APPLICATION.sectionId,
    quoteDocumentId:docs.AUTO_QUOTE.id,
    quoteLogicalDocumentId:docs.AUTO_QUOTE.sectionId,
    applicationNames:["DOE, JOHN"],
    quoteNames:["JOHN DOE"]
  },BROKER_ID);

  const broker=new SubmissionPilotService(db,paths,repo,{reviewedV04:true});
  return {
    root,paths,db,repo,broker,docs,caseId:item.case_id,upload,
    get item(){return repo.getCase(item.case_id);},
    intake(projected){
      return authoritativeIntake(projected??repo.getCase(item.case_id),
        repo.listDocuments(item.case_id));
    },
    close(){db.close();rmSync(root,{recursive:true,force:true});}
  };
}
function withFixture(body){
  const fixture=makeFixture();
  try{return body(fixture);}finally{fixture.close();}
}
function project(item,fields) {
  const result=projectBrokerReviewedCase(item,projectionReview(item,fields));
  assert.deepEqual(result.issues,[],`Projection issues: ${result.issues.join("; ")}`);
  return result.item;
}

test("baseline synthetic originals: signed, insured names and Ownership are recognized",()=>{
  withFixture(f=>{
    const result=f.intake();
    ensureNo(result,[
      "INTAKE_SIGNED_APPLICATION","INTAKE_INSURED_NAME_EVIDENCE",
      "INTAKE_INSURED_NAME_MISMATCH","INTAKE_VEHICLE_OWNERSHIP",
      "VIN_MISMATCH","OWNER_MISMATCH"
    ]);
    assert.equal(f.item.signed,true);
    assert.equal(f.docs.OWNERSHIP.record.sourceHash.length,64);
  });
});
test("corrected VIN alone cannot silently borrow the old Ownership",()=>{
  withFixture(f=>{
    const before=f.item;
    const projected=project(before,{
      "vehicle:SYN-VEHICLE-1.vin":CORRECTED_VIN
    });
    assert.equal(projected.vehicles[0].vin,CORRECTED_VIN);
    assert.equal(before.vehicles[0].vin,ORIGINAL_VIN);
    const result=f.intake(projected);
    assert.equal(has(result,"INTAKE_VEHICLE_OWNERSHIP") || has(result,"VIN_MISMATCH"),true,
      `VIN correction escaped the Ownership gate: ${JSON.stringify(result.blockers)}`);
    assert.equal(f.item.vehicles[0].vin,ORIGINAL_VIN);
  });
});
test("reconfirmed updated Ownership can support the corrected VIN",()=>{
  withFixture(f=>{
    // Simulate a Broker explicitly updating the Case Ownership facts and
    // uploading a separate synthetic replacement source containing the new VIN.
    // This is not an automatic inference from an existing old-VIN document.
    const sourceCase=f.item;
    sourceCase.vehicles[0].ownership.vin=CORRECTED_VIN;
    f.repo.upsertCase({case:sourceCase},"UPDATE_CASE");
    f.upload("OWNERSHIP","SYNOWN3CNEW","SYNOWN3CNEWSEC",{
      vin:CORRECTED_VIN,subjectId:"SYN-VEHICLE-1"
    });
    // Withdraw the old Ownership document rather than accepting two contradictory
    // active VIN documents for the same car.
    f.repo.deleteDocument("SYNOWN3C");
    const outgoing=project(f.item,{
      "vehicle:SYN-VEHICLE-1.vin":CORRECTED_VIN
    });
    const result=f.intake(outgoing);
    ensureNo(result,["INTAKE_VEHICLE_OWNERSHIP","VIN_MISMATCH"]);
    assert.equal(f.item.vehicles[0].vin,ORIGINAL_VIN,
      "The Broker's stored vehicle VIN must not be silently overwritten.");
  });
});
test("stable Driver ID permits Licence correction without assigning another Driver",()=>{
  withFixture(f=>{
    const before=f.item;
    const changed="D9988-77777-00001";
    const outgoing=project(before,{
      "driver:SYN-DRIVER-1.licenceNumber":changed
    });
    assert.equal(outgoing.drivers[0].id,before.drivers[0].id);
    assert.equal(outgoing.drivers[0].licence_number,changed);
    assert.equal(before.drivers[0].licence_number,"D1234-56789-01234");
    ensureNo(f.intake(outgoing),[
      "INTAKE_SIGNED_APPLICATION","INTAKE_VEHICLE_OWNERSHIP"
    ]);
  });
});
test("name order and punctuation changes do not require repeated Broker confirmation",()=>{
  withFixture(f=>{
    const outgoing=project(f.item,{"policy.insured":"DOE, JOHN"});
    ensureNo(f.intake(outgoing),[
      "INTAKE_INSURED_NAME_EVIDENCE","INTAKE_INSURED_NAME_MISMATCH"
    ]);
  });
});
test("materially different policyholder name is blocked against signed Quote/Application",()=>{
  withFixture(f=>{
    const outgoing=project(f.item,{"policy.insured":"JANE SMITH"});
    const result=f.intake(outgoing);
    assert.equal(has(result,"INTAKE_INSURED_NAME_MISMATCH"),true,
      `Different policyholder should be blocked: ${JSON.stringify(result.blockers)}`);
  });
});
test("physical modification of signed source bytes invalidates the recorded signature",()=>{
  withFixture(f=>{
    const evidence=f.repo.documentPath(f.docs.AUTO_APPLICATION.id);
    assert(evidence?.path);
    appendFileSync(evidence.path,Buffer.from("\nSYNTHETIC-CHANGED-BYTES\n"));
    const result=f.intake();
    assert.equal(has(result,"INTAKE_SIGNED_APPLICATION"),true,
      `Tampered source must fail: ${JSON.stringify(result.blockers)}`);
    assert.equal(result.passed,false);
  });
});
test("modified Ownership file bytes invalidate its source proof",()=>{
  withFixture(f=>{
    const evidence=f.repo.documentPath(f.docs.OWNERSHIP.id);
    assert(evidence?.path);
    appendFileSync(evidence.path,Buffer.from("\nSYNTHETIC-ALTERED-OWNERSHIP\n"));
    const result=f.intake();
    assert.equal(has(result,"INTAKE_VEHICLE_OWNERSHIP"),true,
      `Modified Ownership must fail: ${JSON.stringify(result.blockers)}`);
  });
});
test("withdrawn Ownership section is never accepted as valid proof",()=>{
  withFixture(f=>{
    const current=f.repo.listDocuments(f.caseId).find(d=>d.id===f.docs.OWNERSHIP.id);
    assert(current);
    f.repo.updateDocument(f.docs.OWNERSHIP.id,{
      ...current,withdrawnSectionRanges:[{startPage:1,endPage:1}]
    });
    const result=f.intake();
    assert.equal(has(result,"INTAKE_VEHICLE_OWNERSHIP"),true,
      `Withdrawn Ownership must fail: ${JSON.stringify(result.blockers)}`);
  });
});
test("second vehicle cannot inherit the first vehicle's Ownership",()=>{
  withFixture(f=>{
    const outgoing=structuredClone(f.item);
    outgoing.vehicles.push({
      id:"SYN-VEHICLE-2",vin:SECOND_VIN,year:2003,
      make:"HONDA",model:"ACCORD",primary_use:"pleasure",
      annual_km:9000
    });
    const result=f.intake(outgoing);
    assert.equal(has(result,"INTAKE_VEHICLE_OWNERSHIP"),true,
      `A second vehicle without Ownership must block: ${JSON.stringify(result.blockers)}`);
    assert.ok(result.blockers.some(x=>
      x.code==="INTAKE_VEHICLE_OWNERSHIP" && x.vehicle_id==="SYN-VEHICLE-2"));
  });
});

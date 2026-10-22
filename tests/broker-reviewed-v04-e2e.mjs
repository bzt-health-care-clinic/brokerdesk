// Real BrokerDesk repository/database/package path, synthetic contents only.
// Broker v0.4 is opt-in; Auditor accepts v0.3 & v0.4 regardless of toggle.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../local-server/database.mjs';
import { resolveDataPaths } from '../local-server/paths.mjs';
import { LocalRepositories } from '../local-server/repositories.mjs';
import { SubmissionPilotService } from '../local-server/submission-service.mjs';
import { BrokerReviewService } from '../local-server/broker-review-integration.mjs';
import { createBlankPolicyChangeCase } from '../lib/case-factories.ts';
import { createBdzip, readBdzip } from '../local-server/bdzip.mjs';

const now=new Date().toISOString().slice(0,10);
const root=mkdtempSync(join(tmpdir(),'brokerdesk-v04-real-e2e-'));
const brokerPaths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:join(root,'broker')});
const auditorPaths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:join(root,'auditor')});
const db=openDatabase(brokerPaths.database), brokerRepo=new LocalRepositories(db,brokerPaths);
const audb=openDatabase(auditorPaths.database), auditorRepo=new LocalRepositories(audb,auditorPaths);
const broker=new SubmissionPilotService(db,brokerPaths,brokerRepo,{reviewedV04:true});
const auditor=new SubmissionPilotService(audb,auditorPaths,auditorRepo,{reviewedV04:false});
const sha=x=>createHash('sha256').update(x).digest('hex');
const section=(id,physicalFileId,type)=>({id,physicalFileId,documentType:type,title:'Synthetic signed request',
  presenceStatus:'FOUND',parseStatus:'PARSED',validationStatus:'VALID',classificationSource:'MANUAL',startPage:1,endPage:1});
let createdId;
try {
  const item=createBlankPolicyChangeCase();
  item.policy.company='Intact';item.policy.client_code='SYNV04';
  item.policy.policy_number='SYNTHETIC-POLICY-04';item.policy.effective_date=now;
  item.insured.name='SYNTHETIC POLICY PERSON';item.insured.co_insured=[];
  item.policy_change.transaction_types=['CANCELLATION'];
  item.policy_change.requested_action='Cancellation';
  item.policy_change.change_effective_date=now;
  item.policy_change.requested_changes=[{id:'synthetic-change',type:'CANCELLATION',
    subject_name:'Whole policy',effective_date:now,new_value:'Cancel on requested effective date'}];
  item.policy_change.notes=`Hi U/W,\nAs insured's request, please cancel the auto policy.\nEffective date: ${now}.`;
  createdId=item.case_id;
  brokerRepo.upsertCase({case:item},'CREATE_CASE');
  const bytes=Buffer.from('SYNTHETIC ONLY - policyholder signed cancellation request - not a real PDF.');
  const id='SYNREQ04',sec='SYNREQ04SEC';
  brokerRepo.saveDocument(item.case_id,{id,fileName:'synthetic-request.pdf',mimeType:'application/pdf',
    size:bytes.length,documentType:'CANCELLATION_REQUEST',state:'PARSED',
    classification:{documentType:'CANCELLATION_REQUEST',confidence:1,reason:'synthetic'},
    logicalDocuments:[section(sec,id,'CANCELLATION_REQUEST')]},bytes,'synthetic-request.pdf');
  brokerRepo.saveTransactionAuthorization(item.case_id,{verified:true,documentId:id,logicalDocumentId:sec,
    signers:[{name:'SYNTHETIC POLICY PERSON',documentId:id,logicalDocumentId:sec,signaturePage:1,verified:true}]});
  const review=new BrokerReviewService(db,brokerRepo);
  assert.equal(broker.preflight(item.case_id).passed,false,'v0.4 rejects missing Broker review');
  assert.throws(()=>broker.exportCase(item.case_id,{id:'PILOT-BROKER-1',name:'Synthetic Broker'}),/blockers|hard|review/i);
  let state=review.create(item.case_id,{actor:'PILOT-BROKER-1'});
  const originalRemarks=item.policy_change.notes;
  const correctedRemarks=`Hi U/W,\nAs insured's request, please cancel the auto policy.\nEffective date: ${now}.\nBroker confirmed corrected Remarks.`;
  assert(state.review.fields.some(field=>field.id==='remarks.text'),
    'Policy Change Remarks must be present in the Broker Review.');
  state=review.edit(item.case_id,{actor:'PILOT-BROKER-1',
    expectedRevision:state.review.revision,fieldId:'remarks.text',value:correctedRemarks});
  assert.equal(brokerRepo.getCase(item.case_id).policy_change.notes,originalRemarks,
    'Editing Broker Review must not overwrite the source Case.');
  for(const section of state.review.sections){
    try{state=review.confirm(item.case_id,{actor:'PILOT-BROKER-1',expectedRevision:state.review.revision,sectionId:section.id});}
    catch(e){console.error('REVIEW_SECTION_BLOCKED',section.id,e.blockers??e.message);throw e;}
  }
  assert(state.ready,`All Broker sections must be ready. ${JSON.stringify(state.fieldIssues)}`);
  const bundle=broker.exportCase(item.case_id,{id:'PILOT-BROKER-1',name:'Synthetic Broker'});
  assert.equal(bundle.manifest.package_version,'0.4-reviewed-keyin');
  const files=readBdzip(bundle.archive);
  assert(files.has('reviewed-keyin.json'));
  assert.equal(bundle.manifest.reviewed_keyin.sha256,sha(files.get('reviewed-keyin.json')));
  const original=JSON.parse(files.get('reviewed-keyin.json').toString());
  const outboundCase=JSON.parse(files.get('case.json').toString());
  assert.equal(outboundCase.policy_change.notes,correctedRemarks,
    'Step 3B must project confirmed Remarks into the actual archive Case.');
  assert.equal(brokerRepo.getCase(item.case_id).policy_change.notes,originalRemarks,
    'Step 3B export must not mutate Broker local Case.');
  assert.equal(original.fields.find(f=>f.id==='remarks.text')?.value,correctedRemarks,
    'The immutable Broker snapshot must match its projected Case.');
  assert.equal(original.review_status,'BROKER_CONFIRMED');
  assert.equal(original.finalized_by,'PILOT-BROKER-1');
  assert.equal(review.read(item.case_id).review.review_status,'BROKER_CONFIRMED');
  const imported=auditor.importArchive(bundle.archive,bundle.filename);
  assert.equal(imported.imported,true);
  assert.equal(imported.system,'policy-change');
  assert.equal(auditorRepo.getCase(imported.case_id).policy_change.notes,correctedRemarks,
    'Auditor Case must receive the same corrected Remarks.');
  assert.equal(auditor.importArchive(bundle.archive,bundle.filename).duplicate,true);
  const sheet=auditor.readReviewedKeyin(imported.case_id);
  assert.equal(sheet.sheet.brokerReview,'BROKER_CONFIRMED');
  assert.equal(sheet.reviewedHash,original.snapshot_sha256);
  assert.equal(sheet.sheet.sourceCaseId,imported.case_id);
  const view=JSON.parse(audb.prepare('SELECT auditor_view_json FROM imported_reviewed_keyin WHERE imported_case_id=?').get(imported.case_id).auditor_view_json);
  assert.notEqual(view.source_case_id,item.case_id);
  assert(view.source_files.every(f=>f.id!==id),'Auditor document IDs must be remapped');
  assert(view.source_files.length>0);
  const tampered=new Map(files);const changed=Buffer.from(tampered.get('reviewed-keyin.json'));changed[32]^=1;
  tampered.set('reviewed-keyin.json',changed);
  const malicious=createBdzip([...tampered].map(([path,bytes])=>({path,bytes})));
  const countBefore=auditorRepo.listCases().length;
  assert.throws(()=>auditor.importArchive(malicious,bundle.filename),/SHA-256 mismatch|reviewed/i);
  assert.equal(auditorRepo.listCases().length,countBefore,'Tampered archive must not create an Auditor Case');
  // A second opt-out (v0.3) submission does not acquire a forged Broker review.
  const legacy=new SubmissionPilotService(db,brokerPaths,brokerRepo,{reviewedV04:false});
  const older=legacy.exportCase(item.case_id,{id:'PILOT-BROKER-1',name:'Synthetic Broker'});
  assert.equal(older.manifest.package_version,'0.3-pilot');
  assert(!readBdzip(older.archive).has('reviewed-keyin.json'));
  const legacyImport=auditor.importArchive(older.archive,older.filename);
  assert.equal(legacyImport.imported,true);
  assert.throws(()=>auditor.readReviewedKeyin(legacyImport.case_id),{status:404});
  console.log('Actual BrokerDesk broker-verified v0.4 BDZIP -> Auditor import, ID remap, legacy and tamper rejection: PASS');
} finally {
  db.close();audb.close();rmSync(root,{recursive:true,force:true});
}

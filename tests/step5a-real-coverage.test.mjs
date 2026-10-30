import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {measureStep5A, STEP5A_DOMAINS, STEP5A_SCHEMA} from '../lib/step5a-real-coverage.mjs';

const commit='08e0a6d1176d15dee1d6576967ffa9f481ab0f5c';
const proof=Buffer.from('PURE SYNTHETIC TEST DATA, NOT A CUSTOMER PDF');
const digest=createHash('sha256').update(proof).digest('hex');
const id='document-FAKE';
const entries=[
  ['VIN','vehicle:V1.vin',1,'ownership','1HGBH41JXMN109186'],
  ['OWNERSHIP','vehicle:V1.leased',1,'ownership',false],
  ['DRIVER_ASSIGNMENT','vehicle:V1.driverAssignments',5,'coverage',
    [{driverId:'D1',role:'PRINCIPAL'},{driverId:'D2',role:'OCCASIONAL'}]],
  ['MVR_COUNT','report:mvr:document-FAKE::mvr.summary',3,'mvr',
    {hasConvictions:false,convictions:[]}],
  ['DASH_COUNT','report:dash:document-FAKE::dash.summary',2,'dash',
    {hasClaims:true,claims:[{id:'synthetic-event'}]}],
  ['QUOTE_NUMBER','policy.quoteNumber',4,'quote','SYN-QUOTE-123'],
  ['EFFECTIVE_DATE','policy.effectiveDate',4,'quote','2026-10-30'],
  ['COVERAGE','vehicle:V1.liability',5,'coverage',2000000],
  ['OPCF','vehicle:V1.opcf',5,'coverage',[]],
  ['MIXED_SEGMENT','policy.insurer',4,'quote','SYNTHETIC INSURER'],
  ['NEEDS_REVIEW','vehicle:V2.vin',1,'ownership',null]
];
function sampleInput(sourceHash=digest){
  const logicalDocuments=[
    {id:'ownership',documentType:'OWNERSHIP',startPage:1,endPage:1,presenceStatus:'FOUND'},
    {id:'dash',documentType:'DASH',startPage:2,endPage:2,presenceStatus:'FOUND'},
    {id:'mvr',documentType:'MVR',startPage:3,endPage:3,presenceStatus:'FOUND'},
    {id:'quote',documentType:'AUTO_QUOTE',startPage:4,endPage:4,presenceStatus:'FOUND'},
    {id:'coverage',documentType:'AUTO_APPLICATION',startPage:5,endPage:5,presenceStatus:'FOUND'}
  ];
  const fields=entries.map(([category,fieldId,physicalPage,logicalDocumentId,value])=>({
    id:fieldId,section:'policy',origin:category==='NEEDS_REVIEW'?'CASE_UNVERIFIED':'EXTRACTED',
    value,conflict:category==='NEEDS_REVIEW',evidence:category==='NEEDS_REVIEW'?[]:[{
      documentId:id,sourceHash,page:physicalPage,logicalDocumentId
    }]
  }));
  const uniqueFields=new Map(fields.map(field=>[field.id,field]));
  const checks=entries.map(([category,fieldId,physicalPage,logicalDocumentId,value])=>({
    category,fieldId,physicalPage,logicalDocumentId,documentId:id,
    originalChecked:true,groundTruth:category==='NEEDS_REVIEW'?'UNKNOWN':
      category==='MVR_COUNT'?'EXPLICIT_ZERO':'PRESENT',
    ...(category==='MVR_COUNT'?{expectedCount:0,countDeclaration:'EXPLICIT_FULL_REPORT'}:
        category==='DASH_COUNT'?{expectedCount:1,countDeclaration:'EXPLICIT_FULL_REPORT'}:
        category==='NEEDS_REVIEW'?{}:{expectedValue:value})
  }));
  const ledger={schemaVersion:'5B-07-v1',blockingIssues:[],unassigned:[],
    reports:[
      {reportId:'r-mvr',documentId:id,logicalDocumentId:'mvr',sourceHash,documentType:'MVR',declaredCounts:1},
      {reportId:'r-dash',documentId:id,logicalDocumentId:'dash',sourceHash,documentType:'DASH',declaredCounts:1}
    ],
    drivers:[{reportedCounts:[
      {reportId:'r-mvr',kind:'conviction',count:0,page:3,sourceHash},
      {reportId:'r-dash',kind:'claim',count:1,page:2,sourceHash}
    ]}]
  };
  return {schema_version:STEP5A_SCHEMA,dataset:'SYNTHETIC_FIXTURE',target_commit:commit,
    samples:[{sample_id:'S01',case_type:'new_auto',
      review:{schema_version:1,case_type:'new_auto',review_status:'DRAFT',
        sections:[{id:'policy',status:'PENDING'}],fields:[...uniqueFields.values()],
        expected_field_ids:[...uniqueFields.keys()],
        source_files:[{id,sha256:sourceHash}],driver_history_integrity:ledger},
      records:[{id,sourceHash,hashVerified:true,logicalDocuments,
        packagePages:[1,2,3,4,5].map(page=>({page,extractionStatus:'COMPLETE'}))}],checks}]};
}
const status=(result,code)=>result.totals.statuses[code];

test('all eleven mandatory domains measured; synthetic never claims real acceptance',()=>{
  const r=measureStep5A(sampleInput(),{expectedCommit:commit});
  assert.equal(r.status,'SYNTHETIC_ONLY');
  assert.deepEqual(r.unmeasured_categories,[]);
  assert.deepEqual(r.categories.map(c=>c.category),STEP5A_DOMAINS);
  assert.equal(r.sample_count,1);
  assert.equal(status(r,'AUTO_CORRECT_PROVEN'),10);
  assert.equal(status(r,'REVIEW_REQUIRED'),1);
  assert.equal(r.totals.measured,11);
  assert.equal(r.totals.source_known_fields,10);
  assert.equal(r.totals.needs_review_safety_checks,1);
  assert.equal(r.totals.auto_correct_rate_percent,100);
  assert.equal(r.real_sample_accuracy_certified,false);
});
test('real results are pending human thresholds and signoff, not certified automatically',()=>{
  const s=sampleInput();s.dataset='REAL_PRIVATE';
  const r=measureStep5A(s,{expectedCommit:commit});
  assert.equal(r.status,'REAL_MEASURED_AWAITING_BUSINESS_THRESHOLDS_AND_SIGNOFF');
  assert.equal(r.business_thresholds_defined,false);
  assert.equal(r.real_sample_accuracy_certified,false);
});
test('explicit zero MVR count requires physical report ledger proof',()=>{
  const s=sampleInput();s.samples[0].review.driver_history_integrity.drivers[0].reportedCounts=[];
  const r=measureStep5A(s);assert.equal(status(r,'AUTO_CORRECT_UNPROVEN'),2);
});
test('missing full-report count evidence is not inferred from pulled date',()=>{
  const s=sampleInput();s.samples[0].checks.find(c=>c.category==='MVR_COUNT').countDeclaration='SIX_YEAR_ONLY';
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_UNPROVEN'),1);
});
test('broken source file SHA fails closed even if value is right',()=>{
  const s=sampleInput();s.samples[0].records[0].sourceHash='b'.repeat(64);
  const r=measureStep5A(s);assert.ok(status(r,'UNVERIFIED')>=1);
});
test('unknown local source byte verification is never a pass',()=>{
  const s=sampleInput();s.samples[0].records[0].hashVerified=false;
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_PROVEN'),0);
});
test('logical section mismatch does not borrow evidence from another section',()=>{
  const s=sampleInput();s.samples[0].checks.find(c=>c.category==='VIN').logicalDocumentId='quote';
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_UNPROVEN'),1);
});
test('out-of-range physical page does not qualify as bound evidence',()=>{
  const s=sampleInput();s.samples[0].checks.find(c=>c.category==='VIN').physicalPage=5;
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_UNPROVEN'),1);
});
test('withdrawn physical source section is not active evidence',()=>{
  const s=sampleInput();s.samples[0].records[0].withdrawnSectionRanges=[{startPage:1,endPage:1}];
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_UNPROVEN'),2);
});
test('bad quote # counts as wrong even if sourced',()=>{
  const s=sampleInput();s.samples[0].review.fields.find(f=>f.id==='policy.quoteNumber').value='WRONG-QUOTE';
  assert.equal(status(measureStep5A(s),'INCORRECT'),1);
});
test('assignment role swapped cannot compare by position or entity count',()=>{
  const s=sampleInput();
  s.samples[0].review.fields.find(f=>f.id==='vehicle:V1.driverAssignments').value=[
    {driverId:'D1',role:'OCCASIONAL'},{driverId:'D2',role:'PRINCIPAL'}];
  assert.equal(status(measureStep5A(s),'INCORRECT'),1);
});
test('assignment row order alone is not an error',()=>{
  const s=sampleInput();
  s.samples[0].review.fields.find(f=>f.id==='vehicle:V1.driverAssignments').value.reverse();
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_PROVEN'),10);
});
test('broker correction does not inflate automatic extraction coverage',()=>{
  const s=sampleInput();s.samples[0].review.fields.find(f=>f.id==='policy.quoteNumber').origin='BROKER_CORRECTED';
  const r=measureStep5A(s);
  assert.equal(status(r,'BROKER_CORRECTED'),1);
  assert.equal(status(r,'AUTO_CORRECT_PROVEN'),9);
});
test('CASE_UNVERIFIED does not count as automatic extraction',()=>{
  const s=sampleInput();s.samples[0].review.fields.find(f=>f.id==='policy.quoteNumber').origin='CASE_UNVERIFIED';
  assert.equal(status(measureStep5A(s),'UNVERIFIED'),1);
});
test('unknown evidence cannot silently become clean No or zero',()=>{
  const s=sampleInput();const field=s.samples[0].review.fields.find(f=>f.id==='vehicle:V2.vin');
  field.value=false;field.conflict=false;
  const r=measureStep5A(s);
  assert.equal(status(r,'FALSE_CLEAN'),1);
  assert.equal(r.status,'SYNTHETIC_ONLY');
});
test('unverified truth is not scored as an automatic correct field',()=>{
  const s=sampleInput();const t=s.samples[0].checks.find(c=>c.category==='VIN');t.originalChecked=false;
  assert.equal(status(measureStep5A(s),'UNVERIFIED'),1);
});
test('not applicable and untested categories cannot make a full real coverage claim',()=>{
  const s=sampleInput();s.dataset='REAL_PRIVATE';
  s.samples[0].checks=s.samples[0].checks.slice(0,1);
  const r=measureStep5A(s);
  assert.equal(r.unmeasured_categories.length,10);
  assert.equal(r.status,'REAL_MEASUREMENT_INCOMPLETE_OR_FAILED');
});
test('empty real sample is clearly NOT_RUN, never pass',()=>{
  const s=sampleInput();s.dataset='REAL_PRIVATE';s.samples=[];
  assert.equal(measureStep5A(s).status,'NO_REAL_SAMPLES');
});
test('source exact zero must not be absent count or an inferred zero',()=>{
  const s=sampleInput();s.samples[0].checks.find(c=>c.category==='MVR_COUNT').expectedCount=null;
  assert.throws(()=>measureStep5A(s),{code:'INVALID_COUNT_TRUTH'});
});
test('cannot double-count duplicate field checks',()=>{
  const s=sampleInput();s.samples[0].checks.push({...s.samples[0].checks[0]});
  assert.throws(()=>measureStep5A(s),{code:'DUPLICATE_CHECK'});
});
test('invalid sample alias containing customer details is rejected',()=>{
  const s=sampleInput();s.samples[0].sample_id='actual-client-name';
  assert.throws(()=>measureStep5A(s),{code:'INVALID_SAMPLE_ID'});
});
test('exact target commit binding catches stale measurement code',()=>{
  const s=sampleInput();
  assert.throws(()=>measureStep5A(s,{expectedCommit:'0'.repeat(40)}),{code:'CODE_SHA_MISMATCH'});
});
test('public output is allowlisted and contains no review values, IDs or hashes',()=>{
  const s=sampleInput();
  const text=JSON.stringify(measureStep5A(s));
  for(const secret of ['1HGBH41JXMN109186','SYN-QUOTE-123','document-FAKE',
      'vehicle:V1.vin',digest,'synthetic-event','2000000','D1','S01'])
    assert(!text.includes(secret), 'Private value leaked into output');
});
test('offline CLI reads actual local source bytes and redacts output',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'step5a-test-'));
  try {
    const s=sampleInput();
    await writeFile(join(dir,'Private Customer One.pdf'),proof);
    await writeFile(join(dir,'review.json'),JSON.stringify(s.samples[0].review));
    const manifest={schema_version:STEP5A_SCHEMA,dataset:'SYNTHETIC_FIXTURE',
      target_commit:commit,samples:[{sample_id:'S01',case_type:'new_auto',
        review_file:'review.json',records:[{id,source_file:'Private Customer One.pdf',
          logical_documents:s.samples[0].records[0].logicalDocuments,
          package_pages:s.samples[0].records[0].packagePages}],checks:s.samples[0].checks}]};
    const input=join(dir,'private-input.json'),out=join(dir,'safe-output.json');
    await writeFile(input,JSON.stringify(manifest));
    const script=fileURLToPath(new URL('../scripts/step5a-measure.mjs',import.meta.url));
    const p=spawnSync(process.execPath,[script,'--input',input,'--output',out,
      '--target-sha',commit],{encoding:'utf8',timeout:15000});
    assert.equal(p.status,2,p.stderr);
    const text=await readFile(out,'utf8');
    const result=JSON.parse(text);
    assert.equal(result.totals.auto_correct_with_proof,10);
    assert(!text.includes('Private Customer One'));
    assert(!text.includes(digest));
    assert(!text.includes('SYN-QUOTE-123'));
    assert(!p.stdout.includes('Private Customer One'));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('domain labels cannot be reassigned to unrelated Key-in fields',()=>{
  const s=sampleInput();
  s.samples[0].checks.find(c=>c.category==='VIN').fieldId='policy.quoteNumber';
  assert.throws(()=>measureStep5A(s),{code:'INVALID_CHECK'});
});
test('mixed segmentation requires more than one independently bounded section',()=>{
  const s=sampleInput();
  const row=s.samples[0].checks.find(c=>c.category==='MIXED_SEGMENT');
  s.samples[0].records[0].logicalDocuments=[
    s.samples[0].records[0].logicalDocuments.find(x=>x.id===row.logicalDocumentId)];
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_UNPROVEN')>=1,true);
});

test('review inventory duplicated or changed cannot support any verified outcome',()=>{
  const s=sampleInput();
  s.samples[0].review.source_files.push({...s.samples[0].review.source_files[0]});
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_PROVEN'),0);
});
test('review expected field inventory is not self-consistent -> unverified',()=>{
  const s=sampleInput();s.samples[0].review.expected_field_ids.pop();
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_PROVEN'),0);
});
test('BROKER_CONFIRMED snapshot with fake digest cannot be counted',()=>{
  const s=sampleInput();const review=s.samples[0].review;
  review.review_status='BROKER_CONFIRMED';review.snapshot_sha256='e'.repeat(64);
  assert.equal(status(measureStep5A(s),'AUTO_CORRECT_PROVEN'),0);
});

test('unknown category cannot be credited without original-source check',()=>{
  const s=sampleInput();
  s.samples[0].checks.find(c=>c.category==='NEEDS_REVIEW').originalChecked=false;
  assert.equal(status(measureStep5A(s),'UNVERIFIED'),1);
});
test('false zero is rejected outside MVR/DASH count domains',()=>{
  const s=sampleInput();
  s.samples[0].checks.find(c=>c.category==='VIN').groundTruth='EXPLICIT_ZERO';
  assert.throws(()=>measureStep5A(s),{code:'INVALID_ZERO_DOMAIN'});
});
test('Needs Review domain must exercise missing or uncertain source facts',()=>{
  const s=sampleInput();
  s.samples[0].checks.find(c=>c.category==='NEEDS_REVIEW').groundTruth='PRESENT';
  assert.throws(()=>measureStep5A(s),{code:'INVALID_NEEDS_REVIEW_TRUTH'});
});

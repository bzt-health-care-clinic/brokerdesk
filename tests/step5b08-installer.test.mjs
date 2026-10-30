/**
 * Step 5B-08 source-contract smoke tests. Anchors were checked against
 * BrokerDesk GitHub feature/broker-auditor-lan-pilot @ eac983c (2026-10-29).
 * These are SYNTHETIC repository fixtures, not a real checkout/build.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const base=fileURLToPath(new URL("..",import.meta.url));
const scripts={
  "06":join(base,"scripts/install-step5b06.mjs"),
  "07":join(base,"scripts/install-step5b07.mjs"),
  "08":join(base,"scripts/install-step5b08.mjs")
};
const source={
"local-server/broker-review-integration.mjs":`
import {deriveStep3eOptions} from "./broker-review-step3e-options.mjs";
import {enrichStep3eRemarks} from "./broker-review-step3e-remarks.mjs";
function sourceIssue(){return null;}
export class BrokerReviewService {
  createOptions(live) {
    const options=deriveStep3eOptions(live.item,live.docs);
    const scratch=createBrokerReview(live.item,{...options,sourceFiles:live.docs.verified});
    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);
    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates};
  }
  bindingStatus(caseId,review,live) {
    const issues=[];
    return issues;
  }
  read(caseId) {
    const live=this.live(caseId);
    const review=this.store.read(caseId);
    if(!review)return {review:null,sourceIssues:live.docs.warnings,ready:false};
    const sourceIssues=this.bindingStatus(caseId,review,live);
    const fieldIssues=review.sections.flatMap(s=>sectionIssues(review,s.id,new Date().toISOString().slice(0,10))
      .map(message=>({sectionId:s.id,message})));
    return {review,sourceIssues,fieldIssues,
      confirmed:review.sections.filter(s=>s.status==="CONFIRMED").length,
      total:review.sections.length,ready:sourceIssues.length===0&&
        reviewExportIssues(review,{submissionDate:new Date().toISOString().slice(0,10)}).length===0};
  }
  checked(caseId,expectedRevision){return {review:{},live:{}};}
  confirm(caseId,body={}) {
    const actor=actorOf(body.actor),expectedRevision=revisionOf(body.expectedRevision);
    const checked=this.checked(caseId,expectedRevision);
    const date=new Date().toISOString().slice(0,10);
    const live=checked.live;
    this.store.confirm(caseId,body.sectionId,{actor,expectedRevision,referenceDate:date});
    return this.read(caseId);
  }
}
`,
"lib/broker-keyin-review.mjs":`
import { createHash } from "node:crypto";
export const REVIEW_SCHEMA_VERSION=1;
export function createBrokerReview(item, options={}) {
 const sourceFiles=[];
  const availableDocs=new Map(sourceFiles.map(f=>[f.id,f.sha256]));
 const fields=[];
 for(const field of fields) {
   field.origin="CASE_UNVERIFIED";
  }
  return {
    schema_version:REVIEW_SCHEMA_VERSION,
    source_files:sourceFiles,
    fields
  };
}
export function sectionFingerprint(review, sectionId) {
 const section={id:sectionId};
 return sha256json({
    schema:review.schema_version, catalog:review.catalog_version,
    caseId:review.source_case_id, company:review.company,
    sourceFiles:review.source_files, sectionId:section.id,
    fields:review.fields.filter(f=>f.section===sectionId).map(fieldDigestData)
  });
}
export function sectionIssues(review,sectionId,referenceDate=null) {
 return [];
}
`,
"local-server/broker-review-step3e-options.mjs":`
const filled=(v)=>v&&typeof v==="object";
const nonblank=(v)=>v!=null;
function coverageFromRows(data) {
 const coverage={};
 for(const entry of data.coverages??[]) {
    const label=entry.name;
    const amount=Number(entry.value);
    if(label==="X"){coverage.example=amount;
   } else if(/^bodily injury\\b/.test(label) && amount!==null)coverage.liability=amount;
 }
 if(Number.isFinite(Number(data.allPerilsDeductible))&&nonblank(data.allPerilsDeductible))
   coverage.allPerils={present:true,deductible:data.allPerilsDeductible};
 return coverage;
}
export function deriveStep3eOptions(item,docs) {
 for(const context of docs.sources??[]){
    const s=context.observation,data=s?.data;
   if(!filled(data))continue;
 }
 return {};
}
`,
"lib/keyin-field-catalog.mjs":`
export const KEYIN_CATALOG_VERSION = "2026-10-22-v1.3";
export function buildKeyinCatalog(item,options={}) {
 const fields=[];
 const coverage={};
 const base = [
      ["liability", "Liability", coverage.liability, "number"],
 ];
 for(const [name,title,value,type] of base)fields.push(
       text("coverage", name, title, value,
        name !== "opcf44", { ...extra, type }));
 return {fields,sections:[]};
}
`,
"local-server/broker-review-source.mjs":`
const fieldSources={
  annualKm:["annualKm"],commuteOneWayKm:["commuteKm","commuteOneWayKm"],
  winterTires:["winterTires"],liability:["liability"],
};
`,
"local-server/reviewed-keyin-package.mjs":`
import {step3eConsistencyIssues} from "./broker-review-step3e-compat.mjs";
export function validateReviewedKeyinPackage(snapshot,item,records,submittedAt) {
  const issues=[
    ...verifyBrokerSnapshot(snapshot,{submissionDate:String(submittedAt??"").slice(0,10)}),
    ...reviewedCaseConsistencyIssues(snapshot,item)
  ];
  return [...new Set(issues)];
}
`,
"lib/broker-review-client.ts":`
export interface BrokerReviewStatus {
  review:BrokerReview|null;
  sourceIssues:string[];
  fieldIssues:string[];
}
`,
"app/broker-review/page.tsx":`
export default function BrokerReview(){
 return <div>
    {notice&&<div role="status" className="rounded bg-slate-100 p-3">{notice}</div>}
  </div>;
}
`
};
// Fixed upstream fixture contains the source line 06 patches (06's string
// must appear in the actual file; its exact meaning isn't executed here).
// FieldCatalog fixture is checked against the anchor rather than parsed.

function setup(){
 const root=mkdtempSync(join(tmpdir(),"brokerdesk-step5b08-installer-"));
 for(const [rel,text] of Object.entries(source)){
  const path=join(root,rel);mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,text);
 }
 for(const part of ["06","07","08"]) {
  const path=join(root,`lib/step5b${part}-`+({
   "06":"vehicle-isolation.mjs","07":"driver-history.mjs",
   "08":"keyin-coverage.mjs"
  })[part]);
  mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,"export const synthetic=true;\n");
 }
 return root;
}
const exec=(root,number,dry=false)=>
  spawnSync(process.execPath,[scripts[number],...(dry?["--dry-run"]:[])],{
   cwd:root,encoding:"utf8"
  });
const actualFiles=[
  "local-server/broker-review-integration.mjs",
  "lib/broker-keyin-review.mjs",
  "local-server/reviewed-keyin-package.mjs",
  "lib/broker-review-client.ts",
  "app/broker-review/page.tsx"
];
function install6and7(root) {
 const a=exec(root,"06");
 assert.equal(a.status,0,a.stderr);
 const b=exec(root,"07");
 assert.equal(b.status,0,b.stderr);
}
test("06→07→08 staged installers work for actual three-parameter sectionIssues API",()=>{
 const root=setup();
 try {
  for(const n of ["06","07","08"]){
   const dry=exec(root,n,true);
   assert.equal(dry.status,0,`${n}: ${dry.stderr}`);
   const actual=exec(root,n);
   assert.equal(actual.status,0,`${n}: ${actual.stderr}`);
  }
  const review=readFileSync(join(root,"lib/broker-keyin-review.mjs"),"utf8");
  assert.match(review,/sectionIssues\(review,sectionId,referenceDate=null\)/);
  assert.match(review,/step5b07Guard=driverHistorySectionIssues\(review,sectionId\)/);
  assert.match(review,/driverHistoryIntegrity:review.driver_history_integrity\?\?null/);
  for(const rel of actualFiles)
   assert.ok(readFileSync(join(root,rel),"utf8").includes("STEP5B08_KEYIN_COVERAGE"),rel);
  const integration=readFileSync(join(root,actualFiles[0]),"utf8");
  assert.match(integration,/coverageStatus\(review,live\)/);
  assert.match(integration,/keyinCoverage\.reconciliationIssues\.length===0/);
  const pkg=readFileSync(join(root,actualFiles[2]),"utf8");
  assert.match(pkg,/keyinPackageIntegrityIssues\(snapshot,item,records\)/);
  for(const rel of actualFiles.slice(0,3)){
   const verified=spawnSync(process.execPath,["--check",join(root,rel)],{encoding:"utf8"});
   assert.equal(verified.status,0,`${rel}: ${verified.stderr}`);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("08 dry run is read-only, then install is idempotent",()=>{
 const root=setup();
 try {
  install6and7(root);
  const before=actualFiles.map(rel=>readFileSync(join(root,rel),"utf8"));
  const dry=exec(root,"08",true);
  assert.equal(dry.status,0,dry.stderr);
  assert.deepEqual(actualFiles.map(rel=>readFileSync(join(root,rel),"utf8")),before);
  assert.equal(exec(root,"08").status,0);
  const applied=actualFiles.map(rel=>readFileSync(join(root,rel),"utf8"));
  const twice=exec(root,"08");
  assert.equal(twice.status,0,twice.stderr);
  assert.match(twice.stdout,/ALREADY INSTALLED/);
  assert.deepEqual(actualFiles.map(rel=>readFileSync(join(root,rel),"utf8")),applied);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("08 aborts atomically for unknown upstream anchor",()=>{
 const root=setup();
 try{
  install6and7(root);
  const target=join(root,"lib/broker-review-client.ts");
  writeFileSync(target,readFileSync(target,"utf8").replace(
   "export interface BrokerReviewStatus {","export interface ReviewStatus {"));
  const before=actualFiles.map(rel=>readFileSync(join(root,rel),"utf8"));
  const out=exec(root,"08");
  assert.notEqual(out.status,0);
  assert.match(out.stderr,/ABORTED/);
  assert.deepEqual(actualFiles.map(rel=>readFileSync(join(root,rel),"utf8")),before);
  assert.equal(actualFiles.some(rel=>existsSync(join(root,rel+".step5b08.tmp"))),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("08 rejects partial marker even if the other four source files look pristine",()=>{
 const root=setup();
 try {
  install6and7(root);
  const target=join(root,actualFiles[0]);
  writeFileSync(target,readFileSync(target,"utf8")+"\n// STEP5B08_KEYIN_COVERAGE\n");
  const result=exec(root,"08");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Partial 5B-08 installation/);
  assert.equal(actualFiles.slice(1).every(rel=>
   !readFileSync(join(root,rel),"utf8").includes("STEP5B08_KEYIN_COVERAGE")),true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("08 requires fully installed 07, never silently installs on 06 alone",()=>{
 const root=setup();
 try{
  assert.equal(exec(root,"06").status,0);
  const result=exec(root,"08");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Step 5B-07 must be installed/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("07 3-argument signature preserves referenceDate and handles marker idempotently",()=>{
 const root=setup();
 try{
  assert.equal(exec(root,"06").status,0);
  assert.equal(exec(root,"07").status,0);
  const second=exec(root,"07");
  assert.equal(second.status,0,second.stderr);
  assert.match(second.stdout,/ALREADY INSTALLED/);
  const review=readFileSync(join(root,"lib/broker-keyin-review.mjs"),"utf8");
  assert.match(review,/sectionIssues\(review,sectionId,referenceDate=null\)/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

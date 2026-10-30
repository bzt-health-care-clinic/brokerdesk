import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync}
  from "node:fs";
import {join,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const anchors=JSON.parse(readFileSync(join(root,
  "tests/fixtures/step5b05-06-source-anchors.json"),"utf8"));
const paths=Object.keys(anchors);
const MARK="STEP5B07_DRIVER_HISTORY_INTEGRITY";
function fixture(){
 const folder=mkdtempSync(join(tmpdir(),"broker-step5b07-"));
 for(const [rel,content] of Object.entries(anchors)){
   const target=join(folder,rel);
   mkdirSync(dirname(target),{recursive:true});
   const extra=rel==="lib/broker-keyin-review.mjs"
     ? '\nexport function sectionIssues(review,sectionId){return ["existing issue"];}\n' : "";
   writeFileSync(target,content+extra);
 }
 for(const rel of [
  "lib/step5b06-vehicle-isolation.mjs",
  "lib/step5b07-driver-history.mjs",
  "scripts/install-step5b06.mjs",
  "scripts/install-step5b07.mjs"
 ]) {
   const file=join(folder,rel);
   mkdirSync(dirname(file),{recursive:true});
   copyFileSync(join(root,rel),file);
 }
 return folder;
}
const run=(folder,step,dry=false)=>spawnSync(process.execPath,
 [`scripts/install-step5b${step}.mjs`,...(dry?["--dry-run"]:[])],
 {cwd:folder,encoding:"utf8",timeout:10000});
const read=(folder,rel)=>readFileSync(join(folder,rel),"utf8");
const all=(folder)=>Object.fromEntries(paths.map(p=>[p,read(folder,p)]));
test("07 refuses installation before 06 and never partially edits upstream",()=>{
 const folder=fixture();
 try{
  const before=all(folder);
  const result=run(folder,"07");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/anchor mismatch/);
  assert.deepEqual(all(folder),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("06 then 07: dry-run and preflight are read-only",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  const before=all(folder);
  const result=run(folder,"07",true);
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/DRY RUN OK/);
  assert.deepEqual(all(folder),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("07 patches only integration and review: keeps 06 vehicle isolation and DCPD",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  const before=all(folder);
  const result=run(folder,"07");
  assert.equal(result.status,0,result.stderr);
  const after=all(folder);
  assert.deepEqual(Object.keys(after).filter(x=>after[x]!==before[x]).sort(),
    ["lib/broker-keyin-review.mjs","local-server/broker-review-integration.mjs"]);
  assert.match(after["local-server/broker-review-integration.mjs"],
    /driverHistoryIntegrity:history/);
  assert.match(after["lib/broker-keyin-review.mjs"],
    /driver_history_integrity:options\.driverHistoryIntegrity/);
  assert.match(after["lib/broker-keyin-review.mjs"],/step5b07Guard/);
  assert.match(after["lib/broker-keyin-review.mjs"],/sourceConflictFields/);
  assert.match(after["lib/keyin-field-catalog.mjs"],/DCPD Deductible/);
  assert.match(after["local-server/broker-review-step3e-options.mjs"],/dcpdDeductible/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("07 repeated installer and dry-run are idempotent",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  assert.equal(run(folder,"07").status,0);
  const before=all(folder);
  assert.equal(run(folder,"07").status,0);
  assert.equal(run(folder,"07",true).status,0);
  assert.deepEqual(all(folder),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("07 fails atomically on renamed sectionIssues hook",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  const rel="lib/broker-keyin-review.mjs";
  writeFileSync(join(folder,rel),read(folder,rel)
    .replace("export function sectionIssues(","export function renamedSectionIssues("));
  const before=all(folder);
  const result=run(folder,"07");
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/sectionIssues signature missing/);
  assert.deepEqual(all(folder),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("07 detects partial marker, refusing a false installed status",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  const rel="lib/broker-keyin-review.mjs";
  writeFileSync(join(folder,rel),read(folder,rel)+"\n// "+MARK);
  const before=all(folder);
  const result=run(folder,"07",true);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Partial Step 5B-07/);
  assert.deepEqual(all(folder),before);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("review sectionIssues gate preserves existing behavior when ledger clean",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  assert.equal(run(folder,"07").status,0);
  const script=`
    import {sectionIssues} from "./lib/broker-keyin-review.mjs";
    const bad=sectionIssues({driver_history_integrity:{blockingIssues:[{code:"MISSING"}]}},"coverage");
    const good=sectionIssues({driver_history_integrity:{blockingIssues:[]}},"coverage");
    if(bad.length!==1||!/needs source reconciliation/.test(bad[0]))process.exit(3);
    if(good.length!==1||good[0]!=="existing issue")process.exit(4);
  `;
  const result=spawnSync(process.execPath,["--input-type=module","-e",script],
    {cwd:folder,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("07 installs after the Step 5B-01 manual Quote guard and Step 5B-06",()=>{
 const folder=fixture();
 try{
  const rel="lib/broker-keyin-review.mjs";
  writeFileSync(join(folder,rel),read(folder,rel).replace(
    `    if (unique.size===1) {
      field.value=deep(candidates[0].value);
      field.origin="EXTRACTED";
    }`,
    `    if (unique.size===1) {
      const existingQuote=field.id==="policy.quoteNumber"&&field.value;
      if(existingQuote)field.conflict=true;
      else {field.value=deep(candidates[0].value);field.origin="EXTRACTED";}
    }`
  ));
  assert.equal(run(folder,"06").status,0);
  assert.equal(run(folder,"07").status,0);
  const content=read(folder,rel);
  assert.match(content,/existingQuote/);
  assert.match(content,/sourceConflictFields\.has\(field\.id\)/);
  assert.match(content,/driver_history_integrity/);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test("synthetic 06→07 createOptions to Review section gate carries evidence end-to-end",()=>{
 const folder=fixture();
 try{
  assert.equal(run(folder,"06").status,0);
  // Only the synthetic adapter module is stubbed: no actual repository is touched.
  // Keep the exact 06-anchored createOptions() text for the 07 installer.
  writeFileSync(join(folder,"local-server/broker-review-step3e-options.mjs"),
    'export function deriveStep3eOptions(){return {coverageByVehicle:{}};}\n');
  const intRel="local-server/broker-review-integration.mjs";
  writeFileSync(join(folder,intRel),
    'const buildExplicitReviewCandidates=()=>({candidates:[]});\n'
    +read(folder,intRel));
  const revRel="lib/broker-keyin-review.mjs";
  writeFileSync(join(folder,revRel),
    'const REVIEW_SCHEMA_VERSION=1;\n'
    +read(folder,revRel));
  assert.equal(run(folder,"07").status,0);
  const script=`
    import {createOptions} from "./local-server/broker-review-integration.mjs";
    import {createBrokerReview,sectionIssues} from "./lib/broker-keyin-review.mjs";
    const H="e".repeat(64);
    const item={drivers:[{id:"case-driver",name:"Alex Chen",
      licence_number:"S12345678901234"}],vehicles:[]};
    const observation={documentType:"DASH",documentId:"synthetic-d",
      logicalDocumentId:"section-1",page:1,
      data:{driver:{name:"Alex Chen",licenceNumber:"S12345678901234",page:1},
       claims:[{claimNumber:"C1",page:2}],reportedClaimCount:2},
       fieldEvidence:{reportedClaimCount:[{page:1,documentId:"synthetic-d",
        logicalDocumentId:"section-1",sourceHash:H,
        text:"TOTAL REPORTED CLAIMS (ENTIRE REPORT): 2"}]}};
    const context={record:{id:"synthetic-d",sourceHash:H,
      packagePages:[{page:1,text:"TOTAL REPORTED CLAIMS (ENTIRE REPORT): 2"},
        {page:2,text:"Claim C1"}]},hash:H,observation};
    const live={item,docs:{sources:[context],verified:[{id:"synthetic-d",sha256:H}]}};
    const options=createOptions(live);
    if(options.driverHistoryIntegrity.totals.claimObservations!==1)process.exit(10);
    const review=createBrokerReview(item,options);
    if(!review.driver_history_integrity)process.exit(11);
    if(!sectionIssues(review,"drivers").some(x=>/reconciliation/.test(x)))process.exit(12);
    if(review.driver_history_integrity.totals.claimObservations!==1)process.exit(13);
    observation.data.reportedClaimCount=1;
    observation.fieldEvidence.reportedClaimCount[0].text=
      "TOTAL REPORTED CLAIMS (ENTIRE REPORT): 1";
    context.record.packagePages[0].text="TOTAL REPORTED CLAIMS (ENTIRE REPORT): 1";
    const good=createBrokerReview(item,createOptions(live));
    if(sectionIssues(good,"drivers").length!==1
      ||sectionIssues(good,"drivers")[0]!=="existing issue")process.exit(14);
  `;
  const result=spawnSync(process.execPath,["--input-type=module","-e",script],
    {cwd:folder,encoding:"utf8",timeout:10000});
  assert.equal(result.status,0,result.stderr);
 }finally{rmSync(folder,{recursive:true,force:true});}
});

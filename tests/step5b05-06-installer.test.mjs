import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync}
  from "node:fs";
import {join,dirname,resolve} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const anchorFiles=JSON.parse(readFileSync(
 join(root,"tests/fixtures/step5b05-06-source-anchors.json"),"utf8"));
const paths=Object.keys(anchorFiles);
function fixture(){
 const tmp=mkdtempSync(join(tmpdir(),"broker-step5b-install-"));
 for(const [rel,content] of Object.entries(anchorFiles)){
   const target=join(tmp,rel);mkdirSync(dirname(target),{recursive:true});
   writeFileSync(target,content,"utf8");
 }
 for(const rel of ["lib/step5b05-diagnostics.ts","lib/step5b06-vehicle-isolation.mjs",
  "scripts/install-step5b05.mjs","scripts/install-step5b06.mjs"]){
    const target=join(tmp,rel);mkdirSync(dirname(target),{recursive:true});
    copyFileSync(join(root,rel),target);
 }
 return tmp;
}
function run(dir,step,dry=false){
 return spawnSync(process.execPath,[
  `scripts/install-step5b${step}.mjs`,...(dry?["--dry-run"]:[])
 ],{cwd:dir,encoding:"utf8",timeout:10000});
}
test("Step 5B-05/06 dry runs are strictly read-only",()=>{
 const folder=fixture();
 try{
   const before=Object.fromEntries(paths.map(p=>[p,readFileSync(join(folder,p),"utf8")]));
   for(const step of ["05","06"])assert.equal(run(folder,step,true).status,0);
   for(const [name,content] of Object.entries(before))
     assert.equal(readFileSync(join(folder,name),"utf8"),content);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("5B-05 modifies only diagnostics component",()=>{
 const folder=fixture();
 try{
   assert.equal(run(folder,"05").status,0);
   const updated=readFileSync(join(folder,"components/ingestion-panel.tsx"),"utf8");
   assert.match(updated,/buildDocumentDiagnostics\(record\)/);
   assert.doesNotMatch(updated,/requestSucceeded: record\.raw\.metadata\.requestSucceeded \?\? false/);
   assert.ok(paths.filter(p=>p!=="components/ingestion-panel.tsx").every(
     p=>readFileSync(join(folder,p),"utf8")===anchorFiles[p]));
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("5B-06 installs five guarded files, no duplicate insertion",()=>{
 const folder=fixture();
 try{
   assert.equal(run(folder,"06").status,0);
   const updated=Object.fromEntries(paths.map(p=>[p,readFileSync(join(folder,p),"utf8")]));
   assert.match(updated["lib/broker-keyin-review.mjs"],/sourceConflictFields\.has\(field\.id\)/);
   assert.match(updated["lib/keyin-field-catalog.mjs"],/DCPD Deductible/);
   assert.match(updated["local-server/broker-review-integration.mjs"],/analyzeVehicleSourceConflicts/);
   assert.equal(run(folder,"06").status,0);
   for(const [p,content] of Object.entries(updated))
     assert.equal(readFileSync(join(folder,p),"utf8"),content);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("5B-06 aborts atomically if any of the five anchors differs",()=>{
 const folder=fixture();
 try{
   const bad="local-server/broker-review-source.mjs";
   writeFileSync(join(folder,bad),"/* mismatched upstream; needs manual rebase */");
   const original=Object.fromEntries(paths.map(p=>[p,readFileSync(join(folder,p),"utf8")]));
   const out=run(folder,"06");
   assert.notEqual(out.status,0);
   for(const [p,content] of Object.entries(original))
     assert.equal(readFileSync(join(folder,p),"utf8"),content);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test("5B-05 partial marker cannot masquerade as installed",()=>{
 const folder=fixture();
 try{
   const source=join(folder,"components/ingestion-panel.tsx");
   writeFileSync(source,readFileSync(source,"utf8")+"\n// STEP5B05_DIAGNOSTICS partial");
   assert.notEqual(run(folder,"05",true).status,0);
 }finally{rmSync(folder,{recursive:true,force:true});}
});


test("Step 5B-06 composes with the earlier 5B-01 Quote Number protection",()=>{
 const folder=fixture();
 try {
   const file=join(folder,"lib/broker-keyin-review.mjs");
   const before=readFileSync(file,"utf8");
   const oldBranch=`    if (unique.size===1) {
      field.value=deep(candidates[0].value);
      field.origin="EXTRACTED";
    }`;
   const previouslyPatched=`    if (unique.size===1) {
      // Step 5B-01: a previously entered Case Quote # is not silently replaced
      const existingQuote = field.id === "policy.quoteNumber" &&
        field.value !== null && field.value !== undefined &&
        String(field.value).trim() !== "";
      if (existingQuote && String(field.value).trim().toUpperCase() !==
          String(candidates[0].value).trim().toUpperCase()) {
        field.conflict=true;
      } else {
        field.value=deep(candidates[0].value);
        field.origin="EXTRACTED";
      }
    }`;
   assert.ok(before.includes(oldBranch));
   writeFileSync(file,before.replace(oldBranch,previouslyPatched));
   const result=run(folder,"06");
   assert.equal(result.status,0,result.stderr);
   const after=readFileSync(file,"utf8");
   assert.ok(after.includes(previouslyPatched));
   assert.match(after,/sourceConflictFields\.has\(field\.id\)/);
   assert.equal(run(folder,"06",true).status,0);
 } finally{rmSync(folder,{recursive:true,force:true});}
});

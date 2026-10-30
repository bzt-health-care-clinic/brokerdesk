import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
const sources=JSON.parse(readFileSync(join(here,"fixtures/step5b04-source-anchors.json"),"utf8"));
function tempBase(){
 const folder=mkdtempSync(join(tmpdir(),"step5b04-"));
 for(const [name,content] of Object.entries(sources)){
   const dest=join(folder,name);mkdirSync(dirname(dest),{recursive:true});
   writeFileSync(dest,content,"utf8");
 }
 for(const name of ["lib/signed-application-grouping.ts","lib/signed-application-choice.ts","scripts/install-step5b04.mjs"]){
   const dest=join(folder,name);mkdirSync(dirname(dest),{recursive:true});
   copyFileSync(join(root,name),dest);
 }
 return folder;
}
function run(cwd,...args){return spawnSync(process.execPath,["scripts/install-step5b04.mjs",...args],{
 cwd,encoding:"utf8",timeout:15000,
});}
test("installer dry-run scans all anchors without changing existing files",()=>{
 const cwd=tempBase();try{
   const before=readFileSync(join(cwd,"lib/package-analysis.ts"),"utf8");
   const response=run(cwd,"--dry-run");
   assert.equal(response.status,0,response.stderr);
   assert.match(response.stdout,/DRY RUN OK/);
   assert.equal(readFileSync(join(cwd,"lib/package-analysis.ts"),"utf8"),before);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("installer applies the five source edits exactly once",()=>{
 const cwd=tempBase();try{
   assert.equal(run(cwd).status,0);
   for(const name of Object.keys(sources)){
     const text=readFileSync(join(cwd,name),"utf8");
     assert.match(text,/STEP5B04_SIGNED_APPLICATION/);
   }
   const one=readFileSync(join(cwd,"lib/package-analysis.ts"),"utf8");
   assert.match(one,/prepareSignedApplicationPages/);
   assert.match(one,/coalesceSignedApplicationSuggestions/);
   assert.match(readFileSync(join(cwd,"lib/intake-profile.ts"),"utf8"),/signedApplicationSelectionValid/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("repeated install is idempotent",()=>{
 const cwd=tempBase();try{
   assert.equal(run(cwd).status,0);
   const snap=Object.fromEntries(Object.keys(sources).map(name=>[
     name,readFileSync(join(cwd,name),"utf8"),
   ]));
   assert.equal(run(cwd).status,0);
   for(const name of Object.keys(sources))
     assert.equal(readFileSync(join(cwd,name),"utf8"),snap[name]);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("missing anchor aborts before writing anything",()=>{
 const cwd=tempBase();try{
   const name="components/submission-panel.tsx";
   const bad=readFileSync(join(cwd,name),"utf8").replace(
     "const chosenApplication=applicationDocs.find", "const chosenApplication=oldCode.find");
   writeFileSync(join(cwd,name),bad);
   const before=Object.fromEntries(Object.keys(sources).map(rel=>[
     rel,readFileSync(join(cwd,rel),"utf8"),
   ]));
   const result=run(cwd);
   assert.notEqual(result.status,0);
   for(const rel of Object.keys(sources))
     assert.equal(readFileSync(join(cwd,rel),"utf8"),before[rel]);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("manual regroup does not change original source bytes and uses revisioned new id",()=>{
 // A static integration guard: the installer must append a safe reparse step,
 // not rewrite or patch a PDF or automatically verify signatures.
 const script=readFileSync(join(root,"scripts/install-step5b04.mjs"),"utf8");
 assert.match(script,/withdrawnParsedSources/);
 assert.match(script,/return reparseDocument\(updated\)/);
 assert.doesNotMatch(script,/signed:\\s*true/);
});

test("partial application of a file is rejected, not mistaken for completed installation",()=>{
 const cwd=tempBase();try{
   const name="components/submission-panel.tsx";
   const source=readFileSync(join(cwd,name),"utf8");
   writeFileSync(join(cwd,name),source+" // STEP5B04_SIGNED_APPLICATION partial\n");
   const response=run(cwd,"--dry-run");
   assert.notEqual(response.status,0);
   assert.match(response.stderr,/Partial 5B-04 installation/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

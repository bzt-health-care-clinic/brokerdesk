import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";

const installer=resolve("scripts/install-auditor-step4b.mjs");
const oldImport='import { AuditorReviewedKeyinPanel } from "@/components/auditor-reviewed-keyin-panel"; // STEP3_AUDITOR_SHEET';
const oldUsage='return <AuditorReviewedKeyinPanel review={reviewedState.data}/>;';
function setup(variant="valid"){
  const root=mkdtempSync(join(tmpdir(),"brokerdesk-step4b-installer-"));
  mkdirSync(join(root,"components"),{recursive:true});
  mkdirSync(join(root,"lib"),{recursive:true});
  for(const file of ["components/auditor-structured-keyin-panel.tsx",
    "lib/auditor-structured-sheet.mjs","lib/auditor-structured-sheet.d.mts"])
    writeFileSync(join(root,file),"// synthetic fixture only");
  const path=join(root,"components/auditor-worksheet-panel.tsx");
  const contents=variant==="invalid"?
    "// Unexpected worksheet implementation" : `${oldImport}\nfunction demo(){\n${oldUsage}\n}`;
  writeFileSync(path,contents);
  return {root,path,contents};
}
const run=(root,...args)=>spawnSync(process.execPath,[installer,"--root",root,...args],{
  encoding:"utf8",timeout:10000});
test("dry-run validates anchors without writing",()=>{
  const f=setup();
  try{
    const result=run(f.root,"--dry-run");
    assert.equal(result.status,0,result.stderr);
    assert.match(result.stdout,/dry-run OK/);
    assert.equal(readFileSync(f.path,"utf8"),f.contents);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});
test("install changes only two expected worksheet anchors and is idempotent",()=>{
  const f=setup();
  try{
    const first=run(f.root);
    assert.equal(first.status,0,first.stderr);
    const installed=readFileSync(f.path,"utf8");
    assert.match(installed,/AuditorStructuredKeyinPanel/);
    assert.doesNotMatch(installed,/AuditorReviewedKeyinPanel/);
    const again=run(f.root);
    assert.equal(again.status,0,again.stderr);
    assert.match(again.stdout,/already installed/);
    assert.equal(readFileSync(f.path,"utf8"),installed);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("changed worksheet code refuses to install without modifying file",()=>{
  const f=setup("invalid");
  try{
    const result=run(f.root);
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/anchor mismatch/);
    assert.equal(readFileSync(f.path,"utf8"),f.contents);
  }finally{rmSync(f.root,{recursive:true,force:true});}
});

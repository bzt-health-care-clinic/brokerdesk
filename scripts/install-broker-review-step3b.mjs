/**
 * Safe step 3B installer. Checks Git commit ancestry and clean target files,
 * performs both patches in memory, then writes using rollback on failure.
 * --dry-run checks and previews, but does not touch existing files.
 */
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {resolve} from "node:path";
import {execFileSync,spawnSync} from "node:child_process";
import {patchStage3bSubmission,patchStage3bWorkflow} from "./broker-review-step3b-patch.mjs";

const root=process.cwd(),dry=process.argv.includes("--dry-run");
const required=[
  "local-server/submission-service.mjs",
  "local-server/reviewed-case-projection-stage3b.mjs",
  ".github/workflows/lan-pilot-submission.yml",
  "tests/broker-reviewed-case-projection-step3b.test.mjs",
  "tests/broker-reviewed-case-installer-step3b.test.mjs",
  "tests/broker-reviewed-case-compat-step3b.test.mjs"
];
for(const file of required)
  if(!existsSync(resolve(root,file)))throw Error("Required Step 3B file missing: "+file);
if(Number(process.versions.node.split(".")[0])<22)throw Error("Node.js 22+ required.");
const branch=execFileSync("git",["branch","--show-current"],{encoding:"utf8",cwd:root}).trim();
if(!branch || branch==="main"||branch==="master")
  throw Error("Refusing to modify main, master or a detached HEAD.");
if(spawnSync("git",["merge-base","--is-ancestor","18b9ebc","HEAD"],{cwd:root}).status!==0)
  throw Error("Step 3B requires commit 18b9ebc in branch ancestry.");
const sourcePath="local-server/submission-service.mjs";
const workflowPath=".github/workflows/lan-pilot-submission.yml";
const original=new Map([sourcePath,workflowPath].map(file=>
  [file,readFileSync(resolve(root,file),"utf8")]));
const a=patchStage3bSubmission(original.get(sourcePath));
const b=patchStage3bWorkflow(original.get(workflowPath));
const changes=new Map([
  [sourcePath,a],
  [workflowPath,b]
].filter(([,result])=>result.modified).map(([file,result])=>[file,result.code]));
if(!changes.size){console.log("Step 3B integration already installed. No changes.");process.exit(0);}
if(!a.modified||!b.modified)
  throw Error("Partial Step 3B integration detected; repair manually. No changes made.");
const dirty=execFileSync("git",["status","--porcelain","--",sourcePath,workflowPath],
  {cwd:root,encoding:"utf8"}).trim();
if(dirty)throw Error("Commit or stash target-file edits before Step 3B:\n"+dirty);
if(dry){console.log("Step 3B dry-run: anchors valid; would patch "+
  [...changes.keys()].join(", "));process.exit(0);}
try {
  for(const [file,body] of changes)writeFileSync(resolve(root,file),body,"utf8");
} catch(error){
  for(const [file,body] of original)
    try{writeFileSync(resolve(root,file),body,"utf8");}catch{}
  throw error;
}
console.log("Step 3B installed; v0.4 remains opt-in; existing Broker Case unchanged.");

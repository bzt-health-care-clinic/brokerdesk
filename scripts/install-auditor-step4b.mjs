#!/usr/bin/env node
/**
 * Step 4B anchored installer; does not overwrite Step 4A or earlier modules.
 * Usage:
 *   node scripts/install-auditor-step4b.mjs --dry-run
 *   node scripts/install-auditor-step4b.mjs
 * Optional --root PATH is only for isolated installer tests.
 */
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {resolve,join} from "node:path";
const args=process.argv.slice(2);
const dryRun=args.includes("--dry-run");
const rootFlag=args.indexOf("--root");
if(rootFlag>=0 && !args[rootFlag+1])throw new Error("--root requires a directory.");
const root=resolve(rootFlag>=0?args[rootFlag+1]:process.cwd());
const relative="components/auditor-worksheet-panel.tsx";
const path=join(root,relative);
const required=[
  "components/auditor-structured-keyin-panel.tsx",
  "lib/auditor-structured-sheet.mjs",
  "lib/auditor-structured-sheet.d.mts",
];
for(const file of [relative,...required]){
  if(!existsSync(join(root,file)))throw new Error(`Step 4B requires ${file} under repository root.`);
}
const oldImport='import { AuditorReviewedKeyinPanel } from "@/components/auditor-reviewed-keyin-panel"; // STEP3_AUDITOR_SHEET';
const newImport='import { AuditorStructuredKeyinPanel } from "@/components/auditor-structured-keyin-panel"; // STEP4B_AUDITOR_SHEET';
const oldUsage='return <AuditorReviewedKeyinPanel review={reviewedState.data}/>;';
const newUsage='return <AuditorStructuredKeyinPanel review={reviewedState.data}/>;';
const input=readFileSync(path,"utf8");
const count=(haystack,needle)=>haystack.split(needle).length-1;
if(count(input,newImport)===1 && count(input,newUsage)===1 &&
   count(input,oldImport)===0 && count(input,oldUsage)===0){
  console.log("Step 4B already installed; no files changed.");
  process.exit(0);
}
if(count(input,oldImport)!==1 || count(input,oldUsage)!==1 ||
   count(input,newImport)!==0 || count(input,newUsage)!==0)
  throw new Error("Unexpected worksheet code: Step 4B anchor mismatch. No changes made.");
const output=input.replace(oldImport,newImport).replace(oldUsage,newUsage);
if(dryRun){
  console.log(`Step 4B dry-run OK: ${relative} will switch to structured Auditor panel.`);
  process.exit(0);
}
writeFileSync(path,output,"utf8");
console.log(`Step 4B installed: ${relative}. Existing Step 3 panel and v0.3 remain unchanged.`);

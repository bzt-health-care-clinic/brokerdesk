#!/usr/bin/env node
/**
 * 5B-08 cumulative guarded installer for BrokerDesk PR #3 eac983c,
 * AFTER 5B-01..07. No git write, network, schema migration or CI.
 *
 * 5B-08 aligns with real Broker Review service, v0.4 package validator,
 * typed UI client, Broker Review page, and confirmation fingerprints.
 */
import {readFileSync as nativeReadFileSync,writeFileSync as nativeWriteFileSync,existsSync,renameSync,unlinkSync} from "node:fs";
// Installer-only newline adapter: exact anchors are checked against Git-blob LF,
// while original Windows CRLF source bytes are preserved on writes and rollback.
const sourceNewlines = new Map();
const sourceKey = path => String(path).replace(/\.step5b\d{2}\.tmp$/, "");
function readFileSync(path, ...args) {
  const value = nativeReadFileSync(path, ...args);
  if (typeof value !== "string") return value;
  sourceNewlines.set(sourceKey(path), value.includes("\r\n") ? "\r\n" : "\n");
  return value.replace(/\r\n/g, "\n");
}
function writeFileSync(path, value, ...args) {
  const ending = sourceNewlines.get(sourceKey(path));
  const source = ending === "\r\n" && typeof value === "string"
    ? value.replace(/\r?\n/g, "\r\n") : value;
  return nativeWriteFileSync(path, source, ...args);
}

import {resolve} from "node:path";
const root=resolve(process.cwd()),dry=process.argv.includes("--dry-run");
const MARK="STEP5B08_KEYIN_COVERAGE";
const integration="local-server/broker-review-integration.mjs";
const packagePath="local-server/reviewed-keyin-package.mjs";
const review="lib/broker-keyin-review.mjs";
const client="lib/broker-review-client.ts";
const page="app/broker-review/page.tsx";
const files=[integration,packagePath,review,client,page];
function once(text,needle,replacement,rel){
  const count=text.split(needle).length-1;
  if(count!==1)throw Error(`${rel}: expected exactly one upstream anchor: ${needle.slice(0,70)} (${count} found).`);
  return text.replace(needle,replacement);
}
const patch={
  [integration]:source=>{
    let s=once(source,
      'import {enrichStep3eRemarks} from "./broker-review-step3e-remarks.mjs";',
      'import {enrichStep3eRemarks} from "./broker-review-step3e-remarks.mjs";\n'
      +'import {buildKeyinCatalog} from "../lib/keyin-field-catalog.mjs"; // '+MARK+'\n'
      +'import {assessKeyinCoverage} from "../lib/step5b08-keyin-coverage.mjs";',
      integration);
    s=once(s,
      '  bindingStatus(caseId,review,live) {',
      `  // ${MARK}: derive the *complete* dynamic catalog from the current Case
  // and verified original source observations, never from the draft's own
  // mutable expected_field_ids array.
  coverageStatus(review,live) {
    const canonical=buildKeyinCatalog(live.item,deriveStep3eOptions(live.item,live.docs));
    const verified=new Set(live.docs.verified.map(x=>x.id));
    return assessKeyinCoverage(review,{
      expectedFields:canonical.fields,expectedSections:canonical.sections,
      records:live.docs.records.filter(x=>verified.has(x.id)),
      caseDriverIds:(live.item.drivers??[]).map(d=>d.id).filter(Boolean),
      expectedExact:true,verifyRequired:true
    });
  }
  bindingStatus(caseId,review,live) {`,integration);
    s=once(s,
      '    return issues;\n  }\n  read(caseId) {',
      '    issues.push(...this.coverageStatus(review,live).structuralIssues); // '+MARK+'\n'
      +'    return [...new Set(issues)];\n  }\n  read(caseId) {',integration);
    s=once(s,
      '    const sourceIssues=this.bindingStatus(caseId,review,live);\n    const fieldIssues=',
      '    const sourceIssues=this.bindingStatus(caseId,review,live);\n'
      +'    const keyinCoverage=this.coverageStatus(review,live); // '+MARK+'\n'
      +'    const fieldIssues=',integration);
    s=once(s,
      '    return {review,sourceIssues,fieldIssues,',
      '    return {review,sourceIssues,fieldIssues,keyinCoverage,',integration);
    s=once(s,
      'total:review.sections.length,ready:sourceIssues.length===0&&',
      'total:review.sections.length,ready:sourceIssues.length===0&&'+
      'keyinCoverage.reconciliationIssues.length===0&&'+
      'keyinCoverage.fieldIssues.length===0&&',integration);
    s=once(s,
      '    const checked=this.checked(caseId,expectedRevision);\n    const date=new Date().toISOString().slice(0,10);',
      '    const checked=this.checked(caseId,expectedRevision);\n'
      +'    const coverage=this.coverageStatus(checked.review,checked.live); // '+MARK+'\n'
      +'    if(["history","final"].includes(body.sectionId) && (coverage.reconciliationIssues.length||coverage.fieldIssues.length))\n'
      +'      throw err("Source-event/Key-in reconciliation required.",422,[...coverage.reconciliationIssues,...coverage.fieldIssues]);\n'
      +'    const date=new Date().toISOString().slice(0,10);',integration);
    return s;
  },
  [packagePath]:source=>{
    let s=once(source,
      'import {step3eConsistencyIssues} from "./broker-review-step3e-compat.mjs";',
      'import {step3eConsistencyIssues} from "./broker-review-step3e-compat.mjs";\n'
      +'import {keyinPackageIntegrityIssues} from "../lib/step5b08-keyin-coverage.mjs"; // '+MARK,
      packagePath);
    s=once(s,
      '    ...reviewedCaseConsistencyIssues(snapshot,item)\n  ];',
      '    ...reviewedCaseConsistencyIssues(snapshot,item),\n'
      +'    ...keyinPackageIntegrityIssues(snapshot,item,records) // '+MARK+'\n  ];',
      packagePath);
    return s;
  },
  [review]:source=>{
    return once(source,
      '    sourceFiles:review.source_files, sectionId:section.id,',
      '    sourceFiles:review.source_files,\n'
      +'    driverHistoryIntegrity:review.driver_history_integrity??null, // '+MARK+'\n'
      +'    sectionId:section.id,',
      review);
  },
  [client]:source=>{
    let s=once(source,'export interface BrokerReviewStatus {',
      `// ${MARK}: counts are catalog-level, not OCR accuracy or carrier coverage.
export interface BrokerKeyinCoverage {
  schemaVersion:string;
  totals:{catalogFields:number;required:number;missing:number;
    requiredMissing:number;sourceBound:number;brokerEdited:number;
    caseUnverified:number;conflicts:number;physicalReports:number};
  sections:Array<{id:string;total:number;missing:number;requiredMissing:number}>;
  fields:Array<{id:string;section:string;required:boolean;state:string;
    origin:string|null;evidenceCount:number}>;
  structuralIssues:string[];
  reconciliationIssues:string[];
  fieldIssues:string[];
  warnings:string[];
}
export interface BrokerReviewStatus {`,client);
    s=once(s,
      '  review:BrokerReview|null;\n  sourceIssues:string[];',
      '  review:BrokerReview|null;\n'
      +'  keyinCoverage?:BrokerKeyinCoverage|null;\n'
      +'  sourceIssues:string[];',
      client);
    return s;
  },
  [page]:source=>{
    let s=once(source,
      '    {notice&&<div role="status" className="rounded bg-slate-100 p-3">{notice}</div>}',
      `    {notice&&<div role="status" className="rounded bg-slate-100 p-3">{notice}</div>}
    {data?.keyinCoverage&&<section className="border rounded-xl p-4 space-y-2"
      aria-label="Key-in catalog coverage" data-testid="step5b08-coverage">
      <h2 className="font-semibold">Key-in field inventory · 5B-08</h2>
      <p className="text-sm">
        {data.keyinCoverage.totals.catalogFields} fields in this Case ·
        {" "}{data.keyinCoverage.totals.sourceBound} source-bound ·
        {" "}{data.keyinCoverage.totals.brokerEdited} Broker edited ·
        {" "}{data.keyinCoverage.totals.requiredMissing} required fields blank ·
        {" "}{data.keyinCoverage.totals.conflicts} conflicts ·
        {" "}{data.keyinCoverage.totals.physicalReports} physical MVR/DASH reports
      </p>
      <p className="text-xs text-slate-600">
        Counts refer to the current BrokerDesk field catalog, not carrier-specific
        Key-in coverage, OCR accuracy, or business acceptance.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">View section inventory and source reconciliation</summary>
        <div className="text-sm space-y-1 mt-2">
          {data.keyinCoverage.sections.map(s=><p key={s.id}>
            {s.id}: {s.total} fields, {s.requiredMissing} required blank
          </p>)}
          {data.keyinCoverage.reconciliationIssues.map((issue,i)=>
            <p key={i} className="text-amber-700">{issue}</p>)}
          {data.keyinCoverage.warnings.map((issue,i)=>
            <p key={"warning-"+i} className="text-slate-600">{issue}</p>)}
        </div>
      </details>
    </section>}{/* ${MARK} */}`,page);
    return s;
  }
};
const expected={
 [integration]:["coverageStatus(review,live)","keyinCoverage=this.coverageStatus(review,live)"],
 [packagePath]:["keyinPackageIntegrityIssues(snapshot,item,records)"],
 [review]:["driverHistoryIntegrity:review.driver_history_integrity??null"],
 [client]:["interface BrokerKeyinCoverage","keyinCoverage?:BrokerKeyinCoverage|null"],
 [page]:['data-testid="step5b08-coverage"']
};
function verify(rel,text){return text.includes(MARK)&&expected[rel].every(token=>text.includes(token));}
try {
  if(!existsSync(resolve(root,"lib/step5b08-keyin-coverage.mjs")))
    throw Error("Missing Step 5B-08 coverage module.");
  // Fail closed if the cumulative step 07 patch has not been applied.
  for(const [file,tag] of [
    [integration,"STEP5B07_DRIVER_HISTORY_INTEGRITY"],
    [review,"STEP5B07_DRIVER_HISTORY_INTEGRITY"]]){
    if(!existsSync(resolve(root,file)) || !readFileSync(resolve(root,file),"utf8").includes(tag))
      throw Error(`Step 5B-07 must be installed before 08: ${file}.`);
  }
  const states=files.map(rel=>{
    const file=resolve(root,rel);
    if(!existsSync(file))throw Error(`Required target missing: ${rel}`);
    const original=readFileSync(file,"utf8");
    return {rel,file,original,marked:original.includes(MARK)};
  });
  if(states.some(x=>x.marked)){
    if(!states.every(x=>x.marked&&verify(x.rel,x.original)))
      throw Error("Partial 5B-08 installation detected. Rebase explicitly.");
    console.log("STEP5B08 ALREADY INSTALLED");process.exit(0);
  }
  const changes=states.map(s=>({...s,updated:patch[s.rel](s.original)}));
  if(changes.some(x=>!verify(x.rel,x.updated)||x.original===x.updated))
    throw Error("5B-08 patch completeness preflight failed.");
  if(dry){console.log("STEP5B08 DRY RUN OK; 5 real repository interfaces.");process.exit(0);}
  const staged=[];
  try{
    for(const x of changes){
      const tmp=x.file+".step5b08.tmp";writeFileSync(tmp,x.updated,"utf8");
      staged.push({...x,tmp,applied:false});
    }
    for(const x of staged){renameSync(x.tmp,x.file);x.applied=true;}
  }catch(e){
    for(const x of staged.reverse()){
      try{if(x.applied)writeFileSync(x.file,x.original,"utf8");}catch{}
      try{if(existsSync(x.tmp))unlinkSync(x.tmp);}catch{}
    }
    throw e;
  }
  console.log("STEP5B08 INSTALLED: 5 real source files. Integration/Windows CI pending.");
}catch(e){console.error("STEP5B08 ABORTED: "+e.message);process.exitCode=1;}

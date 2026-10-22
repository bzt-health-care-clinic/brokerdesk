/**
 * Step 3 v0.4 integration, for the public 119c76e descendant.
 * Only patches 4 existing integration files + the ZIP validator.
 * Uses exact one-off anchors. --dry-run validates without writing.
 *
 * Deployed v0.3 behavior stays the default. Enable
 * BROKERDESK_REVIEWED_KEYIN_V04=1 ONLY for a verified test Broker.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root=process.cwd(),dry=process.argv.includes("--dry-run");
if(Number(process.versions.node.split(".")[0])<22)
  throw new Error("Node.js 22+ is required.");
const newFiles=[
  "local-server/reviewed-keyin-stage3.mjs",
  "local-server/reviewed-keyin-package.mjs",
  "local-server/broker-review-integration.mjs",
  "lib/auditor-reviewed-client.ts",
  "components/auditor-reviewed-keyin-panel.tsx"
];
for (const name of newFiles)
  if(!existsSync(resolve(root,name)))throw new Error("Required dependency missing: "+name);
const ancestors=spawnSync("git",["merge-base","--is-ancestor","119c76e","HEAD"],{cwd:root});
if(ancestors.status!==0)
  throw new Error("Step 3 requires commit 119c76e in branch history. No changes made.");
const targets=[
  "local-server/bdzip.mjs",
  "local-server/submission-service.mjs",
  "local-server/server.mjs",
  "components/auditor-worksheet-panel.tsx",
  ".github/workflows/lan-pilot-submission.yml"
];
const markers=[
  ["local-server/bdzip.mjs","reviewed-keyin\\.json"],
  ["local-server/submission-service.mjs","STEP3_V04_IMPORT"],
  ["local-server/server.mjs","STEP3_REVIEWED_READ_ROUTE"],
  ["components/auditor-worksheet-panel.tsx","STEP3_AUDITOR_SHEET"],
  [".github/workflows/lan-pilot-submission.yml","STEP3_V04_CI"]
];
const completed=markers.every(([file,marker])=>readFileSync(resolve(root,file),"utf8").includes(marker));
if(completed){console.log("Step 3 integration already installed.");process.exit(0);}
if(markers.some(([file,marker])=>readFileSync(resolve(root,file),"utf8").includes(marker)))
  throw new Error("Partially installed Step 3 markers; review changes manually. No changes made.");
const dirty=execFileSync("git",["status","--porcelain","--",...targets],
  {cwd:root,encoding:"utf8"});
if(dirty.trim())throw new Error("Commit or stash existing-file changes before Step 3:\n"+dirty);
const staged=new Map();
function replaceOne(file,anchor,replacement){
  const source=staged.get(file)??readFileSync(resolve(root,file),"utf8");
  const occurrences=source.split(anchor).length-1;
  if(occurrences!==1)throw new Error(`${file}: anchor occurs ${occurrences} times (expected 1). Nothing was written.`);
  staged.set(file,source.replace(anchor,replacement));
}
function insertBefore(file,anchor,text){replaceOne(file,anchor,text+anchor);}
function insertAfter(file,anchor,text){replaceOne(file,anchor,anchor+text);}

// Authorize the NEW top-level archive entry without relaxing ZIP traversal safety.
replaceOne("local-server/bdzip.mjs",
  "manifest\\.json|case\\.json|document-records\\.json|documents\\/",
  "manifest\\.json|case\\.json|document-records\\.json|reviewed-keyin\\.json|documents\\/");

// Export / import. Legacy v0.3 remains accepted; the opt-in export path is STRICT.
insertAfter("local-server/submission-service.mjs",
  'import { createBdzip, readBdzip } from "./bdzip.mjs";',
  `
import { BrokerReviewService } from "./broker-review-integration.mjs"; // STEP3_V04_IMPORT
import {
  REVIEWED_V04, prepareReviewedExport, validateArchiveReviewedSnapshot,
  freezeReviewedExportInTransaction, ensureAuditorReviewedSchema, prepareAuditorReviewedRecord,
  saveAuditorReviewedRecord, loadAuditorReviewedRecord
} from "./reviewed-keyin-stage3.mjs";`);
insertAfter("local-server/submission-service.mjs",
  '    this.pilotAuditor = options.pilotAuditor ?? "AUDITOR-1";',
  `
    this.reviewedV04 = options.reviewedV04 === true ||
      (options.reviewedV04 ?? process.env.BROKERDESK_REVIEWED_KEYIN_V04) === "1";
    this.brokerReview = new BrokerReviewService(db, repositories);
    ensureAuditorReviewedSchema(db);`);

replaceOne("local-server/submission-service.mjs",
  '    return authoritativeIntake(item, this.repo.listDocuments(item.case_id));',
  `    const intake = authoritativeIntake(item, this.repo.listDocuments(item.case_id));
    if (!this.reviewedV04 || !intake.passed) return intake;
    const reviewStatus = this.brokerReview.read(item.case_id);
    if (reviewStatus.review && reviewStatus.ready &&
        reviewStatus.sourceIssues.length===0 && reviewStatus.fieldIssues.length===0)
      return intake;
    const reasons = [...reviewStatus.sourceIssues,
      ...reviewStatus.fieldIssues.map(x=>x.message),
      ...(reviewStatus.review?.sections??[])
        .filter(section=>section.status!=="CONFIRMED")
        .map(section=>section.id+": Broker has not confirmed this page."),
      ...(reviewStatus.review?[]:["Broker Review has not been created."])];
    if(!reasons.length)
      reasons.push("Broker Review confirmation is stale or incomplete; reopen the Review pages.");
    return {...intake,passed:false,blockers:[...intake.blockers,
      ...reasons.slice(0,30).map(message=>({code:"BROKER_KEYIN_REVIEW",message}))]};
  `);
insertAfter("local-server/submission-service.mjs",
  '    if (!preflight.passed) throw bad("Intake has unresolved hard blockers; package was not generated.", 422, preflight.blockers);',
  `
    const submittedAt = now();
    let reviewedExport = null;
    if (this.reviewedV04) {
      const reviewStatus = this.brokerReview.read(item.case_id);
      if (!reviewStatus.review || !reviewStatus.ready ||
          reviewStatus.sourceIssues.length || reviewStatus.fieldIssues.length)
        throw bad("Broker must confirm every Key-in Review section before export.",422,
          [...reviewStatus.sourceIssues,...reviewStatus.fieldIssues.map(x=>x.message),
            ...(reviewStatus.review ? [] : ["Broker Review is missing."])].map(message=>({
              code:"REVIEWED_KEYIN",message
            })));
      reviewedExport = prepareReviewedExport(reviewStatus.review,
        item, sourceRecords, brokerId, submittedAt);
    }`);
// The payload array is patched by replacing a unique two-line segment.
replaceOne("local-server/submission-service.mjs",
  '      ...files,\n    ];',
  '      ...files,\n      ...(reviewedExport ? [reviewedExport.entry] : []),\n    ];');
replaceOne("local-server/submission-service.mjs",
  '      package_version: "0.3-pilot",',
  '      package_version: reviewedExport ? REVIEWED_V04 : "0.3-pilot",');
replaceOne("local-server/submission-service.mjs",
  '      submitted_at: now(), app_version:',
  '      submitted_at: submittedAt, app_version:');
insertBefore("local-server/submission-service.mjs",
  '      preflight: { passed: true, blockers: [], warnings: preflight.warnings },',
  '      ...(reviewedExport ? { reviewed_keyin: reviewedExport.manifestReview } : {}),\n');
insertAfter("local-server/submission-service.mjs",
  '    const archive = createBdzip([...payloads, { path: "manifest.json", bytes: json(manifest) }]);',
  `
    // Commit the Review freeze, outbound package record, and audit atomically.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (reviewedExport?.requiresFinalize)
        freezeReviewedExportInTransaction(this.db,reviewedExport,item.case_id,brokerId);
    }`);
insertBefore("local-server/submission-service.mjs",
  '    return { filename, archive, manifest };',
  `      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
`);
replaceOne("local-server/submission-service.mjs",
  'manifest.package_version !== "0.3-pilot" ||',
  '!["0.3-pilot",REVIEWED_V04].includes(manifest.package_version) ||');
insertBefore("local-server/submission-service.mjs",
  '    const profile = authoritativeIntake(item, records);',
  '    const reviewedSnapshot = validateArchiveReviewedSnapshot(parts,manifest,item,records);\n');
replaceOne("local-server/submission-service.mjs",
  'return { manifest, item, records, parts, profile, manifestHash: hash(parts.get("manifest.json")) };',
  'return { manifest, item, records, parts, profile, reviewedSnapshot, manifestHash: hash(parts.get("manifest.json")) };');
replaceOne("local-server/submission-service.mjs",
  'const { manifest, item, records, parts, profile, manifestHash } = this.validateArchive(archive);',
  'const { manifest, item, records, parts, profile, reviewedSnapshot, manifestHash } = this.validateArchive(archive);');
insertBefore("local-server/submission-service.mjs",
  '    const mapReferences = value => {',
  '    const reviewedRecord = reviewedSnapshot ? prepareAuditorReviewedRecord(reviewedSnapshot,mapping,caseId) : null;\n');
insertBefore("local-server/submission-service.mjs",
  '        this.db.prepare("INSERT INTO inbox_tasks(package_id,status,effective_date,warnings_json,updated_at) VALUES(?,?,?,?,?)")',
  '        if (reviewedRecord) saveAuditorReviewedRecord(this.db,manifest.package_id,caseId,reviewedRecord);\n');
insertBefore("local-server/submission-service.mjs",
  '  listInbox(system) {',
  '  readReviewedKeyin(caseId) { return loadAuditorReviewedRecord(this.db,safeId(caseId)); }\n');

// Auditor mode reads imported immutable sheet, not a Broker-side draft.
insertBefore("local-server/server.mjs",
  '    const preflight = url.pathname.match(/^\\/cases\\/([A-Za-z0-9_-]+)\\/preflight$/);',
  `    // STEP3_REVIEWED_READ_ROUTE: legacy v0.3 imports return 404 and remain unconfirmed.
    const confirmedSheet = url.pathname.match(/^\\/cases\\/([A-Za-z0-9_-]+)\\/reviewed-keyin$/);
    if (confirmedSheet && request.method === "GET") {
      if (brokerOnly) return sendJson(response,request,403,{error:"Auditor mode required."});
      return sendJson(response,request,200,pilot.readReviewedKeyin(confirmedSheet[1]));
    }
`);

// Prefer Broker-confirmed data for new packages; fallback to legacy source
// worksheet ONLY when the imported package did not have a reviewed snapshot.
replaceOne("components/auditor-worksheet-panel.tsx",
  'import { useMemo, useState } from "react";',
  'import { useEffect, useMemo, useState } from "react";');
insertAfter("components/auditor-worksheet-panel.tsx",
  'import { localRepositories } from "@/lib/local-repositories";',
  `
import { fetchAuditorReviewedKeyin, type ReviewedKeyinResponse } from "@/lib/auditor-reviewed-client";
import { AuditorReviewedKeyinPanel } from "@/components/auditor-reviewed-keyin-panel"; // STEP3_AUDITOR_SHEET`);
insertAfter("components/auditor-worksheet-panel.tsx",
  '  const hasContent=sheet.sections.some(section=>section.rows.some(row=>row.status!=="missing"));',
  `
  type ReviewState = {caseId:string;kind:"loading"|"legacy"} |
    {caseId:string;kind:"ready";data:ReviewedKeyinResponse} |
    {caseId:string;kind:"error";message:string};
  const [reviewedState,setReviewedState]=useState<ReviewState>({caseId:data.case_id,kind:"loading"});
  useEffect(()=>{
    let active=true;
    if(process.env.NEXT_PUBLIC_BROKERDESK_MODE==="broker"){
      setReviewedState({caseId:data.case_id,kind:"legacy"});
      return ()=>{active=false;};
    }
    setReviewedState({caseId:data.case_id,kind:"loading"});
    void fetchAuditorReviewedKeyin(data.case_id).then(result=>{
      if(active)setReviewedState(result?{caseId:data.case_id,kind:"ready",data:result}:
        {caseId:data.case_id,kind:"legacy"});
    }).catch(error=>{
      if(active)setReviewedState({caseId:data.case_id,kind:"error",
        message:error instanceof Error?error.message:"Imported worksheet unavailable."});
    });
    return ()=>{active=false;};
  },[data.case_id]);
  if(reviewedState.caseId!==data.case_id||reviewedState.kind==="loading")
    return <p role="status">Loading imported Auditor worksheet...</p>;
  if(reviewedState.kind==="ready")
    return <AuditorReviewedKeyinPanel review={reviewedState.data}/>;
  if(reviewedState.kind==="error")
    return <p role="alert">Unable to verify imported Broker worksheet: {reviewedState.message}</p>;
`);


// CI must exercise the new opt-in package path independently from v0.3 tests.
insertBefore(".github/workflows/lan-pilot-submission.yml",
  '      - name: Geometric Applied, MVR and DASH parser regression (synthetic only)',
  `      # STEP3_V04_CI: reviewed snapshot bridge, SQLite, and BDZIP checks.
      - name: Broker reviewed v0.4 package and Auditor import
        run: |
          node --check local-server/reviewed-keyin-stage3.mjs
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
          node --test tests/broker-reviewed-bdzip-step3.test.mjs
          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`);

if(dry){
  console.log("Step 3 dry-run: would modify "+[...staged.keys()].join(", "));
  process.exit(0);
}
const originals=new Map([...staged.keys()].map(file=>
  [file,readFileSync(resolve(root,file),"utf8")]));
try {
  for(const [file,contents] of staged)
    writeFileSync(resolve(root,file),contents,"utf8");
} catch(error) {
  for(const [file,contents] of originals) {
    try { writeFileSync(resolve(root,file),contents,"utf8"); } catch {}
  }
  throw error;
}
console.log("Step 3 v0.4 adapter installed in "+[...staged.keys()].join(", "));
console.log("Opt-in for test Broker: BROKERDESK_REVIEWED_KEYIN_V04=1; legacy remains default.");

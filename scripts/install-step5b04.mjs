#!/usr/bin/env node
/**
 * Step 5B-04 cumulative, anchored installer. Apply AFTER 5B-01/02/03.
 * Dry-run prevalidates EVERY source target. No write on mismatch.
 * Existing source files are never overwritten wholesale; the helper modules
 * are supplied separately in lib/. No Git, cloud or original-PDF changes.
 */
import { readFileSync as nativeReadFileSync, existsSync, writeFileSync as nativeWriteFileSync, renameSync, unlinkSync } from "node:fs";
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

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dry=process.argv.includes("--dry-run");
const mark="STEP5B04_SIGNED_APPLICATION";
const one=(t,old,updated,label)=>{
  const count=t.split(old).length-1;
  if(count!==1)throw Error(`${label}: expected one source anchor; found ${count}. Nothing changed.`);
  return t.replace(old,updated);
};
const block=(t,begin,end,replacement,label)=>{
  const n=t.indexOf(begin);
  if(n<0||t.indexOf(begin,n+1)!==-1)throw Error(`${label}: start anchor missing/ambiguous.`);
  const stop=t.indexOf(end,n+begin.length);
  if(stop<0||t.indexOf(end,stop+end.length)!==-1)
    throw Error(`${label}: end anchor missing/ambiguous.`);
  return t.slice(0,n)+replacement+t.slice(stop+end.length);
};

const patches=[
  ["lib/package-analysis.ts",t=>{
    t=one(t,
      'import { trustedOcrPage } from "./ocr-page-geometry.ts";',
      `import { trustedOcrPage } from "./ocr-page-geometry.ts";
import { coalesceSignedApplicationSuggestions, prepareSignedApplicationPages } from "./signed-application-grouping.ts"; // ${mark}`,
      "Package grouping helper import");
    t=one(t,
      '  return { manual, suggestions };\n}',
      '  return { manual, suggestions: coalesceSignedApplicationSuggestions(record, pages, suggestions) };\n}',
      "Signed application suggestion consolidation");
    // Keep the existing PDF worker intact (Step 5B-03).
    // Restrict G4Sign cover reclassification and never consume a Quote/MVR.
    const start='    // A G4Sign/signed-application package is one application with many pages,';
    const end='    const { manual, suggestions } = discoverLogicalSections(record, pages);';
    t=block(t,start,end,
      `    // ${mark}: cover-anchored grouping, never swallow distinct attachments.
    const signedPacket=prepareSignedApplicationPages(record,pages);
    pages.splice(0,pages.length,...signedPacket.pages);
    record=signedPacket.record;
    const { manual, suggestions } = discoverLogicalSections(record, pages);`,
      "Signed packet family classifier");
    t=one(t,
      'suggestions.some(s => isDriverReport(s.documentType) && s.suggestionStatus === "PENDING")',
      'suggestions.some(s => (isDriverReport(s.documentType) || s.documentType === "AUTO_APPLICATION" || s.documentType === "HAB_APPLICATION") && s.suggestionStatus === "PENDING")',
      "Pending signed group requires review");
    return t;
  }],
  ["lib/local-reparse.ts",t=>{
    t=one(t,
      'import { sectionRevision } from "./active-evidence.ts";',
      `import { sectionRevision } from "./active-evidence.ts";
import { signedApplicationRegroupCandidate, isApplicationType } from "./signed-application-grouping.ts"; // ${mark}`,
      "Explicit regroup import");
    t=one(t,
      '  if (next.suggestedSections?.some(s => isDriverReport(s.documentType) && s.suggestionStatus === "PENDING")) warnings.push({ code: "REPORT_BOUNDARY_REVIEW", severity: "medium", message: "Report boundaries need confirmation; proposed sections are not active evidence." });',
      `  if (next.suggestedSections?.some(s => isDriverReport(s.documentType) && s.suggestionStatus === "PENDING")) warnings.push({ code: "REPORT_BOUNDARY_REVIEW", severity: "medium", message: "Report boundaries need confirmation; proposed sections are not active evidence." });
  if (next.suggestedSections?.some(s => isApplicationType(s.documentType) && s.suggestionStatus === "PENDING")) warnings.push({ code: "SIGNED_APPLICATION_BOUNDARY_REVIEW", severity: "medium", message: "Signed application contains fragmented, uncertain, or unreadable pages; regroup and review original before confirming." });`,
      "Pending application warnings");
    const functionCode=`
/**
 * ${mark}: explicit migration of older automatically fragmented application
 * sections. Never migrate user-manual sections, withdrawn evidence or old
 * confirmations. Old parsed values/corrections are archived, then the new
 * single physical range is reparsed from locally saved page text.
 */
export async function regroupSignedApplication(record: UploadedDocumentRecord): Promise<UploadedDocumentRecord> {
  const proposed=signedApplicationRegroupCandidate(record);
  if(!proposed)throw new Error("Cannot safely regroup: verify original cover, resolve OCR failures or manual section conflicts first.");
  const oldIds=new Set((record.logicalDocuments??[])
    .filter(s=>isApplicationType(s.documentType)).map(s=>s.id));
  const existing=(record.logicalDocuments??[]).filter(s=>!oldIds.has(s.id));
  if(existing.some(s=>s.presenceStatus==="FOUND" && (s.startPage??1)<=proposed.endPage! &&
      (s.endPage??s.startPage??1)>=proposed.startPage!))
    throw new Error("An independent document overlaps the proposed application pages.");
  const sources=[...(record.parsedSources??[]),...(record.parsed?[record.parsed]:[])];
  // A legacy unbound application parse is also stale after regroup. Otherwise
  // one-section fallback could accidentally revive facts from the old range.
  const staleSource=(source:typeof sources[number])=>
    Boolean(source.logicalDocumentId && oldIds.has(source.logicalDocumentId)) ||
    (!source.logicalDocumentId && isApplicationType(source.documentType));
  const withdrawn=sources.filter(staleSource);
  const updated:UploadedDocumentRecord={
    ...record,
    logicalDocuments:[...existing,proposed],
    suggestedSections:[...(record.suggestedSections??[])
      .filter(s=>!isApplicationType(s.documentType)),proposed],
    parsed:undefined,
    parsedSources:sources.filter(s=>!staleSource(s)),
    withdrawnParsedSources:[...(record.withdrawnParsedSources??[]),...withdrawn],
    state:"NEEDS_REVIEW",
  };
  // The old section ID/range is deliberately gone: any signed/name comparison
  // fingerprint referencing it fails the existing intake evidence gate.
  return reparseDocument(updated);
}
`;
    return t+functionCode;
  }],
  ["lib/intake-profile.ts",t=>{
    t=one(t,
      'import { isSignedEvidenceStillValid } from "./signed-verification.ts";',
      `import { isSignedEvidenceStillValid } from "./signed-verification.ts";
import { signedApplicationSelectionValid } from "./signed-application-choice.ts"; // ${mark}`,
      "Intake complete application import");
    t=one(t,
      '      !isSignedEvidenceStillValid(records, item).valid)',
      `      !isSignedEvidenceStillValid(records, item).valid ||
      (signedRecord && !signedApplicationSelectionValid(signedRecord, item.signed_logical_document_id).valid))`,
      "Intake must reject partial G4Sign binding");
    return t;
  }],
  ["components/submission-panel.tsx",t=>{
    t=one(t,
      'import { appendSuggestedPolicyholder, parsedPolicyholderSuggestions } from "@/lib/intake-name-suggestions";',
      `import { appendSuggestedPolicyholder, parsedPolicyholderSuggestions } from "@/lib/intake-name-suggestions";
import { signedApplicationChoices } from "@/lib/signed-application-choice"; // ${mark}`,
      "Broker chooser import");
    t=one(t,
      '  const applicationDocs=newBusinessOptions.filter(o=>o.type.endsWith("_APPLICATION"));',
      `  const applicationDocs=useMemo(()=>signedApplicationChoices(records,data.case_type),[records,data.case_type]);
  const verifiedApplicationDocs=applicationDocs.filter(o=>o.selectable);`,
      "Group legacy fragments in chooser");
    t=one(t,
      'const chosenApplication=applicationDocs.find(o=>o.id===applicationChoice) ??',
      'const chosenApplication=verifiedApplicationDocs.find(o=>o.id===applicationChoice) ??',
      "Do not select partial application");
    t=one(t,
      'applicationDocs.find(o=>o.documentId===data.signed_document_id &&',
      'verifiedApplicationDocs.find(o=>o.documentId===data.signed_document_id &&',
      "Use only valid application binding");
    t=one(t,
      'value={applicationChoice||applicationDocs.find(o=>o.documentId===data.signed_document_id&&o.logicalId===data.signed_logical_document_id)?.id||""}',
      'value={applicationChoice||verifiedApplicationDocs.find(o=>o.documentId===data.signed_document_id&&o.logicalId===data.signed_logical_document_id)?.id||""}',
      "Do not select invalid older section");
    t=one(t,
      '{applicationDocs.map(o=><option value={o.id} key={o.id}>{o.label}</option>)}',
      '{applicationDocs.map(o=><option value={o.id} key={o.id} disabled={!o.selectable}>{o.label}</option>)}',
      "Fragmented application explanation");
    t=one(t,
      'disabled={busy||!data.signed||!applicationDocs.length||!quoteDocs.length}',
      'disabled={busy||!data.signed||!verifiedApplicationDocs.length||!quoteDocs.length}',
      "Do not confirm names against partial app");
    return t;
  }],
  ["components/ingestion-panel.tsx",t=>{
    t=one(t,
      'import { hasReusableText, reparseDocument, updateLogicalSections } from "@/lib/local-reparse";',
      `import { hasReusableText, reparseDocument, updateLogicalSections, regroupSignedApplication } from "@/lib/local-reparse"; // ${mark}`,
      "Regroup operation import");
    t=one(t,
      '  async function reprocess(record: UploadedDocumentRecord) {',
      `  async function regroupApplication(record: UploadedDocumentRecord) {
    if(!window.confirm("Regroup this signed application into one physical section? Old signed/name confirmations will need to be repeated. Confirm only after reviewing source pages."))return;
    try{
      const updated=await regroupSignedApplication(record);
      const saved=await repository.update(updated);
      onChange(records.map(item=>item.id===record.id?saved:item));
      onAudit?.("SIGNED_APPLICATION_REGROUP",record.id);
      window.alert("Application regrouped. Reconfirm names and signatures against the full original source before submitting.");
    }catch(error){window.alert(error instanceof Error?error.message:"Cannot regroup this source safely.");}
  }
  async function reprocess(record: UploadedDocumentRecord) {`,
      "Regroup action handler");
    t=one(t,
      '<details className="section-manager"><summary>Manage sections</summary><Button',
      `<details className="section-manager"><summary>Manage sections</summary>
        {(record.logicalDocuments??[]).filter(s=>["AUTO_APPLICATION","HAB_APPLICATION"].includes(s.documentType)).length>1&&
          <Button variant="outline" size="sm" onClick={()=>void regroupApplication(record)}>
            Regroup Signed Application
          </Button>}
        <Button`,
      "Old G4Sign regroup button");
    return t;
  }],
];
const alreadyInstalledProof={
  "lib/package-analysis.ts":["coalesceSignedApplicationSuggestions(record, pages, suggestions)","prepareSignedApplicationPages(record,pages)"],
  "lib/local-reparse.ts":["export async function regroupSignedApplication","SIGNED_APPLICATION_BOUNDARY_REVIEW"],
  "lib/intake-profile.ts":["signedApplicationSelectionValid(signedRecord, item.signed_logical_document_id)"],
  "components/submission-panel.tsx":["const verifiedApplicationDocs=applicationDocs.filter","disabled={!o.selectable}"],
  "components/ingestion-panel.tsx":["async function regroupApplication","Regroup Signed Application"],
};
const pending=[];
try{
  for(const [rel,transform] of patches){
    const path=resolve(root,rel);
    if(!existsSync(path))throw Error(`Required project file missing: ${rel}`);
    const original=readFileSync(path,"utf8");
    if(original.includes(mark)){
      const missing=(alreadyInstalledProof[rel]??[]).filter(fragment=>!original.includes(fragment));
      if(missing.length)throw Error(`Partial 5B-04 installation in ${rel}; missing: ${missing.join(", ")}`);
      pending.push({path,rel,skip:true});continue;
    }
    const updated=transform(original);
    if(updated===original||!updated.includes(mark))throw Error(`No change made: ${rel}`);
    pending.push({path,rel,updated,original,skip:false});
  }
  // Confirm that helper modules were extracted, not installed from the internet.
  for(const rel of ["lib/signed-application-grouping.ts","lib/signed-application-choice.ts"])
    if(!existsSync(resolve(root,rel)))throw Error(`Missing new helper: ${rel}`);
  if(dry){
    console.log(`STEP5B04 DRY RUN OK: ${pending.map(p=>p.rel+(p.skip?" (already)":"")).join(", ")}`);process.exit(0);
  }
  // Stage temporary files; each existing module has a backup in memory for
  // a best-effort rollback if the OS fails during the rename sequence.
  const changed=[];
  try{
    for(const item of pending.filter(p=>!p.skip)){
      const staged=item.path+".step5b04.tmp";
      writeFileSync(staged,item.updated,"utf8");
      changed.push({...item,staged,applied:false});
    }
    for(const item of changed){renameSync(item.staged,item.path);item.applied=true;}
  }catch(error){
    for(const item of changed.reverse()){
      try{if(item.applied)writeFileSync(item.path,item.original,"utf8");}catch{}
      try{if(existsSync(item.staged))unlinkSync(item.staged);}catch{}
    }
    throw error;
  }
  console.log(`STEP5B04 INSTALL OK: ${changed.length} updated; ${pending.filter(p=>p.skip).length} already installed.`);
}catch(error){
  console.error("STEP5B04 ABORTED: "+(error instanceof Error?error.message:String(error)));
  process.exitCode=1;
}

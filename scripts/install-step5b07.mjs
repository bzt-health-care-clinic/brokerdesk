#!/usr/bin/env node
/**
 * Step 5B-07 guarded installer: append an evidence ledger and fail-closed
 * Broker Review gate AFTER Step 5B-06. No DB migration/network/PDF access.
 *
 * Requires exact upstream snippets; unknown source layout => abort without
 * writing files. For unresolved histories, confirmation is blocked globally
 * until the report can be reconciled from trusted source evidence.
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
const MARK="STEP5B07_DRIVER_HISTORY_INTEGRITY";
const integration="local-server/broker-review-integration.mjs";
const review="lib/broker-keyin-review.mjs";
const files=[integration,review];
function once(content,needle,replacement,rel){
  const parts=content.split(needle);
  if(parts.length!==2)throw Error(`${rel}: upstream anchor mismatch (${parts.length-1}).`);
  return parts.join(replacement);
}
const change={
  [integration]:source=>{
    let s=once(source,
      'import {analyzeVehicleSourceConflicts} from "../lib/step5b06-vehicle-isolation.mjs";',
      'import {analyzeVehicleSourceConflicts} from "../lib/step5b06-vehicle-isolation.mjs";\n'
       +'import {analyzeDriverHistory} from "../lib/step5b07-driver-history.mjs"; // '+MARK,
      integration);
    s=once(s,
      '    const isolation=analyzeVehicleSourceConflicts(live.item,live.docs.sources);\n'
       +'    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates,\n'
       +'      conflictingFieldIds:isolation.conflictingFieldIds};',
      '    const isolation=analyzeVehicleSourceConflicts(live.item,live.docs.sources);\n'
       +'    const history=analyzeDriverHistory(live.item,live.docs.sources??[]); // '+MARK+'\n'
       +'    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates,\n'
       +'      conflictingFieldIds:isolation.conflictingFieldIds,\n'
       +'      driverHistoryIntegrity:history};',
      integration);
    return s;
  },
  [review]:source=>{
    let s='import {driverHistorySectionIssues} from "./step5b07-driver-history.mjs"; // '+MARK+'\n'+source;
    s=once(s,
      '  return {\n    schema_version:REVIEW_SCHEMA_VERSION,',
      '  return {\n'
       +'    driver_history_integrity:options.driverHistoryIntegrity??null, // '+MARK+'\n'
       +'    schema_version:REVIEW_SCHEMA_VERSION,',
      review);
    // Do not guess the section model. A real sectionIssues(review,id) hook is
    // required; if renamed, refuse installation for explicit rebase.
    const pattern=/(export\s+function\s+sectionIssues\s*\(\s*([a-zA-Z_$][\w$]*)\s*,\s*([a-zA-Z_$][\w$]*)(?:\s*,\s*[a-zA-Z_$][\w$]*\s*=\s*null)?\s*\)\s*\{)/g;
    const matches=[...s.matchAll(pattern)];
    if(matches.length!==1)throw Error(`${review}: sectionIssues signature missing or ambiguous`);
    const [match,header,reviewParam,idParam]=matches[0];
    const insert=header+'\n'
      +`  const step5b07Guard=driverHistorySectionIssues(${reviewParam},${idParam}); // ${MARK}\n`
      +'  if(step5b07Guard.length)return step5b07Guard;\n';
    s=s.replace(match,insert);
    return s;
  }
};
function installedValid(rel,source){
  if(rel===integration)
    return source.includes('driverHistoryIntegrity:history')
      &&source.includes('analyzeDriverHistory(live.item,live.docs.sources??[])')
      &&source.includes('import {analyzeDriverHistory}');
  return source.includes('driver_history_integrity:options.driverHistoryIntegrity??null')
    &&source.includes('const step5b07Guard=driverHistorySectionIssues(')
    &&source.includes('if(step5b07Guard.length)return step5b07Guard')
    &&source.includes('import {driverHistorySectionIssues}');
}
try{
  if(!existsSync(resolve(root,"lib/step5b07-driver-history.mjs")))
    throw Error("Missing lib/step5b07-driver-history.mjs");
  const state=files.map(rel=>{
    const file=resolve(root,rel);
    if(!existsSync(file))throw Error(`Missing ${rel}`);
    const source=readFileSync(file,"utf8");
    return {rel,file,source,marked:source.includes(MARK)};
  });
  if(state.some(s=>s.marked)){
    if(!state.every(s=>s.marked&&installedValid(s.rel,s.source)))
      throw Error("Partial Step 5B-07 installation detected; inspect and rebase.");
    console.log("STEP5B07 ALREADY INSTALLED");process.exit(0);
  }
  const patch=state.map(s=>({...s,updated:change[s.rel](s.source)}));
  if(patch.some(s=>s.source===s.updated||!installedValid(s.rel,s.updated)))
    throw Error("Step 5B-07 completeness preflight failed.");
  if(dry){console.log("STEP5B07 DRY RUN OK; 2 anchored source modules.");process.exit(0);}
  const staged=[];
  try{
    for(const s of patch){
      const tmp=s.file+".step5b07.tmp";
      writeFileSync(tmp,s.updated,"utf8");
      staged.push({...s,tmp,applied:false});
    }
    for(const s of staged){renameSync(s.tmp,s.file);s.applied=true;}
  }catch(e){
    for(const s of staged.reverse()){
      try{if(s.applied)writeFileSync(s.file,s.source,"utf8");}catch{}
      try{if(existsSync(s.tmp))unlinkSync(s.tmp);}catch{}
    }
    throw e;
  }
  console.log("STEP5B07 INSTALLED: 2 files changed.");
}catch(e){console.error("STEP5B07 ABORTED: "+e.message);process.exitCode=1;}

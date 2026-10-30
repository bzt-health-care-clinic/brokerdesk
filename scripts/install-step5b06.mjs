#!/usr/bin/env node
/** Step 5B-06 cumulative safe installer; no PDF data or GitHub network access. */
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
const MARK="STEP5B06_VEHICLE_ISOLATION";
const files=[
"local-server/broker-review-integration.mjs",
"lib/broker-keyin-review.mjs",
"local-server/broker-review-step3e-options.mjs",
"lib/keyin-field-catalog.mjs",
"local-server/broker-review-source.mjs"
];
function replaceOnce(text,needle,next,rel){
 const pieces=text.split(needle);
 if(pieces.length!==2)throw Error(`${rel}: source anchor mismatch (${pieces.length-1} occurrences).`);
 return pieces.join(next);
}
const changes={
"local-server/broker-review-integration.mjs":s=>{
 const rel=files[0];
 s=replaceOnce(s,'import {deriveStep3eOptions} from "./broker-review-step3e-options.mjs";',
   'import {deriveStep3eOptions} from "./broker-review-step3e-options.mjs";\n'+
   'import {analyzeVehicleSourceConflicts} from "../lib/step5b06-vehicle-isolation.mjs"; // '+MARK,rel);
 return replaceOnce(s,
   '    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);\n    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates};',
   '    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);\n'+
   '    const isolation=analyzeVehicleSourceConflicts(live.item,live.docs.sources);\n'+
   '    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates,\n'+
   '      conflictingFieldIds:isolation.conflictingFieldIds};',rel);
},
"lib/broker-keyin-review.mjs":s=>{
 const rel=files[1];
 s=replaceOnce(s,
 '  const availableDocs=new Map(sourceFiles.map(f=>[f.id,f.sha256]));',
 '  const availableDocs=new Map(sourceFiles.map(f=>[f.id,f.sha256]));\n'+
 '  const sourceConflictFields=new Set(options.conflictingFieldIds??[]); // '+MARK,rel);
 // Anchor at the end of createBrokerReview's field loop, NOT inside its
 // unique-candidate branch: Step 5B-01 already rewrites that branch to
 // preserve manually confirmed Quote Numbers.
 return replaceOnce(s,
 '  }\n  return {\n    schema_version:REVIEW_SCHEMA_VERSION,',
 '    // Verified Active Quote observations disagree: require explicit Broker correction.\n'+
 '    if(sourceConflictFields.has(field.id)){\n'+
 '      field.conflict=true;field.value=null;field.origin="CASE_UNVERIFIED";\n'+
 '    }\n  }\n  return {\n    schema_version:REVIEW_SCHEMA_VERSION,',rel);
},
"local-server/broker-review-step3e-options.mjs":s=>{
 const rel=files[2];
 s=replaceOnce(s,
 '   if(!filled(data))continue;',
 '   if(!filled(data)||s?.excluded===true||data?.excluded===true)continue; // '+MARK,rel);
 s=replaceOnce(s,
 '   } else if(/^bodily injury\\b/.test(label) && amount!==null)coverage.liability=amount;',
 '   } else if(/^direct compensation\\b/.test(label) && amount!==null)coverage.dcpdDeductible=amount;\n'+
 '   else if(/^bodily injury\\b/.test(label) && amount!==null)coverage.liability=amount;',rel);
 return replaceOnce(s,
 ' if(Number.isFinite(Number(data.allPerilsDeductible))&&nonblank(data.allPerilsDeductible))',
 ' if(Number.isFinite(Number(data.dcpdDeductible))&&nonblank(data.dcpdDeductible))\n'+
 '     coverage.dcpdDeductible=Number(data.dcpdDeductible);\n'+
 ' if(Number.isFinite(Number(data.allPerilsDeductible))&&nonblank(data.allPerilsDeductible))',rel);
},
"lib/keyin-field-catalog.mjs":s=>{
 const rel=files[3];
 s=replaceOnce(s,
 'export const KEYIN_CATALOG_VERSION = "2026-10-22-v1.3";',
 'export const KEYIN_CATALOG_VERSION = "2026-10-29-v1.4"; // '+MARK,rel);
 s=replaceOnce(s,
 '      ["liability", "Liability", coverage.liability, "number"],',
 '      ["liability", "Liability", coverage.liability, "number"],\n'+
 '      ["dcpdDeductible", "DCPD Deductible", coverage.dcpdDeductible, "number"],',rel);
 return replaceOnce(s,
 '        name !== "opcf44", { ...extra, type }));',
 '        !["opcf44","dcpdDeductible"].includes(name), { ...extra, type }));',rel);
},
"local-server/broker-review-source.mjs":s=>{
 const rel=files[4];
 return replaceOnce(s,
 '  annualKm:["annualKm"],commuteOneWayKm:["commuteKm","commuteOneWayKm"],\n  winterTires:["winterTires"],liability:["liability"],',
 '  annualKm:["annualKm"],commuteOneWayKm:["commuteKm","commuteOneWayKm"],\n'+
 '  winterTires:["winterTires"],liability:["liability"],\n'+
 '  dcpdDeductible:["dcpdDeductible"], // '+MARK,rel);
}
};
try {
 const helper="lib/step5b06-vehicle-isolation.mjs";
 if(!existsSync(resolve(root,helper)))throw Error(`Missing ${helper}.`);
 const pending=[];
 for(const rel of files){
   const file=resolve(root,rel);
   if(!existsSync(file))throw Error(`Missing ${rel}`);
   const original=readFileSync(file,"utf8");
   if(original.includes(MARK)){
      // Every touched module must have actual behavior, not only a marker.
      const check={
        "local-server/broker-review-integration.mjs":"conflictingFieldIds:isolation.conflictingFieldIds",
        "lib/broker-keyin-review.mjs":"sourceConflictFields.has(field.id)",
        "local-server/broker-review-step3e-options.mjs":"dcpdDeductible",
        "lib/keyin-field-catalog.mjs":"DCPD Deductible",
        "local-server/broker-review-source.mjs":"dcpdDeductible:["
      }[rel];
      if(!original.includes(check))throw Error(`Partial Step 5B-06 installation: ${rel}`);
      pending.push({rel,file,skip:true});continue;
   }
   let updated=changes[rel](original);
   if(!updated.includes(MARK)||updated===original)throw Error(`No safe edit in ${rel}`);
   if(rel==="lib/broker-keyin-review.mjs"&&!updated.includes("sourceConflictFields.has(field.id)"))
     throw Error("Missing Broker conflict guard.");
   pending.push({rel,file,original,updated,skip:false});
 }
 if(dry){console.log("STEP5B06 DRY RUN OK; "+pending.map(x=>x.rel+(x.skip?" (already installed)":"")).join(", "));process.exit(0);}
 const staged=[];
 try{
   for(const c of pending.filter(c=>!c.skip)){
     const temp=c.file+".step5b06.tmp";
     writeFileSync(temp,c.updated,"utf8");staged.push({...c,temp,applied:false});
   }
   for(const c of staged){renameSync(c.temp,c.file);c.applied=true;}
 }catch(error){
   for(const c of staged.reverse()){
     try{if(c.applied)writeFileSync(c.file,c.original,"utf8");}catch{}
     try{if(existsSync(c.temp))unlinkSync(c.temp);}catch{}
   }
   throw error;
 }
 console.log(`STEP5B06 INSTALLED: ${staged.length} files changed.`);
}catch(error){console.error("STEP5B06 ABORTED: "+error.message);process.exitCode=1;}

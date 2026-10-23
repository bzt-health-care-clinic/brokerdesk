#!/usr/bin/env node
/**
 * Step 3E guarded installer for the ce3be68 BrokerDesk baseline.
 * --dry-run validates every anchor and makes zero writes.
 * Idempotent after an existing Step 3E installation.
 */
import {readFileSync,writeFileSync,renameSync,unlinkSync} from "node:fs";
import {resolve} from "node:path";
const root=process.cwd(),dry=process.argv.includes("--dry-run");
const pairs=[
 ["local-server/broker-review-integration.mjs",[
  ['} from "./broker-review-source.mjs";',
   '} from "./broker-review-source.mjs";\nimport {deriveStep3eOptions} from "./broker-review-step3e-options.mjs";\nimport {enrichStep3eRemarks} from "./broker-review-step3e-remarks.mjs";',
   'import {deriveStep3eOptions}'],
  ['  return request;\n}\nexport class BrokerReviewService {',
   '  return enrichStep3eRemarks(review,caseData,request);\n}\nexport class BrokerReviewService {',
   'return enrichStep3eRemarks(review'],
  ['    const scratch=createBrokerReview(live.item,{sourceFiles:live.docs.verified});\n    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);\n    return {sourceFiles:live.docs.verified,candidates:mapped.candidates};',
   '    const options=deriveStep3eOptions(live.item,live.docs);\n    const scratch=createBrokerReview(live.item,{...options,sourceFiles:live.docs.verified});\n    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);\n    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates};',
   'const options=deriveStep3eOptions(']
 ]],
 ["lib/keyin-field-catalog.mjs",[
  ['!identified.has(@B@@D@{doc.category}:@D@{doc.id}@B@))',
   '!identified.has(@B@@D@{doc.category}:@D@{doc.id}@B@) &&\n        !(opts.reportCategoriesPresent??[]).includes(doc.category))',
   '!(opts.reportCategoriesPresent??[]).includes(doc.category)']
 ]],
 ["lib/broker-keyin-review.mjs",[
  ['import { validateRemarks } from "./remarks-generator.mjs";',
   'import { validateRemarks } from "./remarks-generator.mjs";\nimport { validateReportSummary } from "./reviewed-report-schema.mjs";',
   'import { validateReportSummary }'],
  ['    if (field.id==="remarks.text") {',
   '    if (field.id.startsWith("report:") && field.id.endsWith(".summary")) {\n      const kind=field.id.split(":")[1];\n      errors.push(...validateReportSummary(field.value,kind).map(message=>\n        @B@@D@{field.id}: @D@{message}@B@));\n    }\n    if (field.id==="remarks.text") {',
   'errors.push(...validateReportSummary(field.value,kind)']
 ]],
 ["local-server/reviewed-case-projection-stage3b.mjs",[
  ['const clone = x => JSON.parse(JSON.stringify(x));',
   'import {projectStep3eCompatibility} from "./broker-review-step3e-compat.mjs";\nconst clone = x => JSON.parse(JSON.stringify(x));',
   'import {projectStep3eCompatibility}'],
  ['  return {item:projected,changes,issues:[...new Set(issues)]};',
   '  issues.push(...projectStep3eCompatibility(projected,review,changes));\n  return {item:projected,changes,issues:[...new Set(issues)]};',
   'issues.push(...projectStep3eCompatibility(']
 ]],
 ["local-server/reviewed-keyin-package.mjs",[
  ['import { verifyBrokerSnapshot } from "../lib/broker-keyin-review.mjs";',
   'import { verifyBrokerSnapshot } from "../lib/broker-keyin-review.mjs";\nimport {step3eConsistencyIssues} from "./broker-review-step3e-compat.mjs";',
   'import {step3eConsistencyIssues}'],
  ['  return issues;\n}\n\n/**\n * Source references use original broker-side document IDs',
   '  issues.push(...step3eConsistencyIssues(snapshot,item));\n  return issues;\n}\n\n/**\n * Source references use original broker-side document IDs',
   'issues.push(...step3eConsistencyIssues(snapshot,item))']
 ]],
 ["tests/broker-keyin-review.test.mjs",[
  ['summary:"No convictions"','summary:{hasConvictions:false,convictions:[]}',
   'summary:{hasConvictions:false,convictions:[]}'],
  ['summary:"No claims"','summary:{hasClaims:false,claims:[]}',
   'summary:{hasClaims:false,claims:[]}']
 ]],
 ["lib/intake-profile.ts",[
  ['    return Boolean((vehicle.id && section.subjectId === vehicle.id) ||\n      observedVins.includes(vin));',
   '    // Step 3E: subjectId alone is NOT proof of the VIN on an unreadable\n    // Ownership. Manual attestation requires a separately byte-bound flow.\n    return observedVins.includes(vin);',
   'Manual attestation requires a separately byte-bound flow']
 ]]
];
const token=s=>s.replaceAll("@B@",String.fromCharCode(96)).replaceAll("@D@",String.fromCharCode(36,123));
function transform(rel,operations){
 const path=resolve(root,rel),original=readFileSync(path,"utf8");
 let updated=original;
 for(const [oldPart,newPart,marker] of operations){
   if(updated.includes(token(marker)))continue;
   const from=token(oldPart),to=token(newPart),pos=updated.indexOf(from);
   if(pos<0||updated.indexOf(from,pos+from.length)>=0)
     throw new Error("Unsafe or ambiguous Step 3E anchor: "+rel);
   updated=updated.slice(0,pos)+to+updated.slice(pos+from.length);
 }
 return {rel,path,original,updated};
}
try{
 const work=pairs.map(([rel,operations])=>transform(rel,operations));
 for(const w of work)console.log(w.rel+": "+(w.updated===w.original?"already installed":"ready"));
 if(dry)console.log("Step 3E DRY RUN PASS; no files changed.");
 else {
   for(const w of work){
     if(w.updated===w.original)continue;
     const tmp=w.path+".step3e-tmp";
     try{writeFileSync(tmp,w.updated);renameSync(tmp,w.path);}
     catch(e){try{unlinkSync(tmp);}catch{}throw e;}
   }
   console.log("Step 3E installed.");
 }
} catch(error){console.error("Step 3E precheck failed:",error.message);process.exitCode=1;}

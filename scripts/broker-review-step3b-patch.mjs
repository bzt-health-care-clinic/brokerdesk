/** Pure guarded transformations, exercised separately from the real Git installer. */
const must=(ok,msg)=>{if(!ok)throw new Error(msg);};
const replaceExactlyOnce=(source, regex, replacement, context)=>{
  const hits=[...source.matchAll(new RegExp(regex.source,regex.flags.includes("g")?regex.flags:regex.flags+"g"))];
  must(hits.length===1,`${context}: expected one matching code block; got ${hits.length}.`);
  return source.replace(regex,replacement);
};
export function patchStage3bSubmission(source){
  if(source.includes("STEP3B_CASE_PROJECTION"))return {code:source,modified:false};
  must(source.includes("STEP3_V04_IMPORT"),"Step 3A must be installed.");
  must(source.includes("freezeReviewedExportInTransaction"),"Expected Stage 3A transaction guard missing.");
  let s=replaceExactlyOnce(source,
    /^import \{ BrokerReviewService \} from "\.\/broker-review-integration\.mjs";[^\r\n]*/m,
    match=>match+'\nimport { projectBrokerReviewedCase } from "./reviewed-case-projection-stage3b.mjs"; // STEP3B_CASE_PROJECTION',
    "Step 3B import");
  const preStart=s.indexOf("preflight(caseId) {"), exportStart=s.indexOf("exportCase(caseId, broker = {}) {");
  must(preStart>=0 && exportStart>preStart,"Could not safely locate preflight/export methods.");
  let pre=s.slice(preStart,exportStart);
  pre=replaceExactlyOnce(pre,
    /const intake = authoritativeIntake\(item, this\.repo\.listDocuments\(item\.case_id\)\);\s*if \(!this\.reviewedV04 \|\| !intake\.passed\) return intake;\s*const reviewStatus = this\.brokerReview\.read\(item\.case_id\);/,
    `if (!this.reviewedV04)
      return authoritativeIntake(item, this.repo.listDocuments(item.case_id));
    const reviewStatus = this.brokerReview.read(item.case_id);
    const projection = reviewStatus.review && reviewStatus.ready &&
      reviewStatus.sourceIssues.length===0 && reviewStatus.fieldIssues.length===0
      ? projectBrokerReviewedCase(item,reviewStatus.review) : null;
    const intake = authoritativeIntake(projection?.item??item,
      this.repo.listDocuments(item.case_id));
    if (projection?.issues.length)
      return {...intake,passed:false,blockers:[...(intake.blockers??[]),
        ...projection.issues.map(message=>({code:"BROKER_CASE_PROJECTION",message}))]};
    if (!intake.passed) return intake;`,
    "Step 3B preflight");
  s=s.slice(0,preStart)+pre+s.slice(exportStart);
  const nextExport=s.indexOf("exportCase(caseId, broker = {}) {");
  const endExport=s.indexOf("auditAs(action, caseId,",nextExport);
  must(nextExport>=0 && endExport>nextExport,"Could not safely delimit outbound export.");
  let exp=s.slice(nextExport,endExport);
  exp=replaceExactlyOnce(exp,
    /const item = this\.repo\.getCase\(safeId\(caseId\)\);/,
    "let item = this.repo.getCase(safeId(caseId));",
    "Step 3B outbound item");
  exp=replaceExactlyOnce(exp,
    /const preflight = authoritativeIntake\(item, originals\);/,
    `if (this.reviewedV04) {
      const currentReview = this.brokerReview.read(item.case_id);
      if (currentReview.review && currentReview.ready &&
          currentReview.sourceIssues.length===0 && currentReview.fieldIssues.length===0) {
        const projection = projectBrokerReviewedCase(item,currentReview.review);
        if (projection.issues.length) throw bad("Broker-reviewed corrections cannot safely be mapped to the Case.",422,
          projection.issues.map(message=>({code:"BROKER_CASE_PROJECTION",message})));
        item = projection.item;
      }
    }
    const preflight = authoritativeIntake(item, originals);`,
    "Step 3B outbound authoritative intake");
  s=s.slice(0,nextExport)+exp+s.slice(endExport);
  return {code:s,modified:true};
}
export function patchStage3bWorkflow(source){
  if(source.includes("STEP3B_CI"))return {code:source,modified:false};
  must(source.includes("STEP3_V04_CI"),"Step 3A CI marker missing.");
  const code=replaceExactlyOnce(source,
    /^([ \t]*)# STEP3_V04_CI[^\r\n]*/m,
    (line,indent)=>`${indent}# STEP3B_CI: non-destructive reviewed Case projection.
${indent}- name: Broker reviewed Case projection
${indent}  run: |
${indent}    node --check local-server/reviewed-case-projection-stage3b.mjs
${indent}    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
${indent}    node --test tests/broker-reviewed-case-projection-step3b.test.mjs tests/broker-reviewed-case-installer-step3b.test.mjs tests/broker-reviewed-case-compat-step3b.test.mjs
${indent}    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
${line}`,
    "Step 3B workflow");
  return {code,modified:true};
}

import test from "node:test";
import assert from "node:assert/strict";
import {patchStage3bSubmission,patchStage3bWorkflow}
  from "../scripts/broker-review-step3b-patch.mjs";

const source=`import { BrokerReviewService } from "./broker-review-integration.mjs"; // STEP3_V04_IMPORT
function freezeReviewedExportInTransaction(){}
class SubmissionPilotService {
 preflight(caseId) {
    const item = this.repo.getCase(safeId(caseId));
    if (!item) throw bad("Case not found.",404);
    const intake = authoritativeIntake(item, this.repo.listDocuments(item.case_id));
    if (!this.reviewedV04 || !intake.passed) return intake;
    const reviewStatus = this.brokerReview.read(item.case_id);
    if (reviewStatus.review && reviewStatus.ready) return intake;
    return {...intake,passed:false};
 }
 exportCase(caseId, broker = {}) {
    const item = this.repo.getCase(safeId(caseId));
    const originals=this.repo.listDocuments(item.case_id);
    for(const record of originals) {}
    const preflight = authoritativeIntake(item, originals);
    if (!preflight.passed) throw bad("no",422,preflight.blockers);
    const reviewedExport= this.reviewedV04 ? prepareReviewedExport(review, item, [], broker.id, "2026-10-22T00:00:00Z") : null;
    return {item,reviewedExport};
 }
 auditAs(action, caseId, actor,details){}
}
`;
const workflow=`name: Stage3
jobs:
  test:
    steps:
      # STEP3_V04_CI: reviewed snapshot bridge, SQLite, and BDZIP checks.
      - name: Broker reviewed v0.4 package and Auditor import
        run: node --test tests/broker-reviewed-bdzip-step3.test.mjs
`;

test("patches only the intended import and two methods",()=>{
  const p=patchStage3bSubmission(source);
  assert.equal(p.modified,true);
  assert.match(p.code,/projectBrokerReviewedCase/);
  assert.match(p.code,/let item = this.repo.getCase/);
  assert.match(p.code,/const projection = reviewStatus.review/);
  assert.match(p.code,/item = projection.item/);
  assert.equal((p.code.match(/STEP3B_CASE_PROJECTION/g)??[]).length,1);
  assert.match(p.code,/function freezeReviewedExportInTransaction/);
});
test("step 3B patch is idempotent",()=>{
  const once=patchStage3bSubmission(source);
  const twice=patchStage3bSubmission(once.code);
  assert.equal(twice.modified,false);
  assert.equal(twice.code,once.code);
});
test("refuses old v0.3 code without current Step 3A integration",()=>{
  assert.throws(()=>patchStage3bSubmission(source.replace("STEP3_V04_IMPORT","OLD")),/Step 3A/);
});
test("refuses unmatched anchor without partial changes",()=>{
  assert.throws(()=>patchStage3bSubmission(source.replace(
    "const preflight = authoritativeIntake(item, originals);",
    "const intake2=authoritativeIntake(item, originals);"
  )),/expected one/);
});
test("new CI step comes before existing v0.4 step",()=>{
  const p=patchStage3bWorkflow(workflow);
  assert.equal(p.modified,true);
  assert.ok(p.code.indexOf("STEP3B_CI")<p.code.indexOf("STEP3_V04_CI"));
  assert.match(p.code,/broker-reviewed-case-projection-step3b.test.mjs/);
  assert.equal(patchStage3bWorkflow(p.code).modified,false);
});
test("refuses missing CI marker",()=>{
  assert.throws(()=>patchStage3bWorkflow(workflow.replace("STEP3_V04_CI","X")),/marker/);
});

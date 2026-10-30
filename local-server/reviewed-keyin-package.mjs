/**
 * BDZIP reviewed-keyin.json bridge.
 *
 * CURRENT PILOT INTEGRATION NOTE: The existing bdzip.mjs regex and
 * submission-service.mjs still need to be wired to this module, with a package
 * version bump. Do not ship a mixed old/new importer.
 */
import { verifyBrokerSnapshot } from "../lib/broker-keyin-review.mjs";
import {step3eConsistencyIssues} from "./broker-review-step3e-compat.mjs";
import {keyinPackageIntegrityIssues} from "../lib/step5b08-keyin-coverage.mjs"; // STEP5B08_KEYIN_COVERAGE

export const REVIEWED_KEYIN_PACKAGE_PATH = "reviewed-keyin.json";
export const REVIEWED_KEYIN_PACKAGE_VERSION = "0.4-reviewed-keyin";

const fail = (issues) => {
  const error=new Error("Reviewed Key-in package invalid: "+issues.join(" | "));
  error.status=422; error.blockers=issues; return error;
};
const norm = value => String(value??"").trim().replace(/\s+/g," ").toUpperCase();
const normalized = input => String(input??"").trim().replace(/[\s-]/g,"").toUpperCase();
// Policyholder identity comparison uses the same order/punctuation-insensitive
// semantics as the active intake preflight; source spelling is never rewritten.
const namedPersonKey = name => typeof name === "string" ? name.normalize("NFKC")
  .toUpperCase().replace(/[.,'’`\-_/\\()[\]{}:;!?"“”‘]/g," ")
  .split(/\s+/).filter(Boolean).sort().join(" ") : "";
const sameNamedPerson = (left,right) => {
  const a=namedPersonKey(left),b=namedPersonKey(right);
  return Boolean(a&&b&&a.length<=120&&b.length<=120&&a===b);
};

/**
 * Confirm that Broker-reviewed facts relevant to existing Intake gates are
 * consistent with the source Case. This is not a parser accuracy certificate.
 */
export function reviewedCaseConsistencyIssues(snapshot, item) {
  const issues=[];
  if (snapshot?.source_case_id!==item?.case_id)issues.push("Reviewed Case ID mismatch.");
  if (snapshot?.case_type!==item?.case_type)issues.push("Reviewed Case type mismatch.");
  if (snapshot?.company!==item?.policy?.company)issues.push("Reviewed insurer mismatch.");
  const fields=new Map((snapshot?.fields??[]).map(field=>[field.id,field.value]));
  for (const [key,actual] of [
    ["policy.insurer",item.policy?.company],["policy.insured",item.insured?.name],
    ["policy.number",item.policy?.policy_number],
    // Step 5B-01: fail if Broker's reviewed Quote # and outbound Case differ.
    ["policy.quoteNumber",item.policy?.auto_quote_number || item.policy?.hab_quote_number || item.policy?.quote_number]
  ]) {
    const reviewed=fields.get(key);
    if (reviewed !== undefined && reviewed !== null && (key==="policy.insured" ?
      !sameNamedPerson(reviewed,actual) : norm(reviewed)!==norm(actual)))
      issues.push(`Reviewed ${key} disagrees with Case.`);
  }
  for (const driver of item.drivers??[]) {
    const identifier=driver.id||driver.licence_number;
    if (!identifier)continue;
    const reviewed=fields.get(`driver:${identifier}.licenceNumber`);
    if (reviewed!==undefined && normalized(reviewed)!==normalized(driver.licence_number))
      issues.push(`Driver ${identifier} licence differs from Case.`);
  }
  for (const vehicle of item.vehicles??[]) {
    const identifier=vehicle.id||vehicle.vin;
    if (!identifier)continue;
    const reviewed=fields.get(`vehicle:${identifier}.vin`);
    if (reviewed!==undefined && normalized(reviewed)!==normalized(vehicle.vin))
      issues.push(`Vehicle ${identifier} VIN differs from Case.`);
  }
  issues.push(...step3eConsistencyIssues(snapshot,item));
  return issues;
}

/**
 * Source references use original broker-side document IDs during verification.
 * SHA-256 is integrity checking only; this is NOT digital signature validation.
 */
export function validateReviewedKeyinPackage(snapshot,item,records,submittedAt) {
  const issues=[
    ...verifyBrokerSnapshot(snapshot,{submissionDate:String(submittedAt??"").slice(0,10)}),
    ...reviewedCaseConsistencyIssues(snapshot,item),
    ...keyinPackageIntegrityIssues(snapshot,item,records) // STEP5B08_KEYIN_COVERAGE
  ];
  const recordsById=new Map((records??[]).map(r=>[r.id,r]));
  const declaredById=new Map((snapshot.source_files??[]).map(f=>[f.id,f.sha256]));
  if (recordsById.size!==(records??[]).length || declaredById.size!==(snapshot.source_files??[]).length)
    issues.push("Duplicate source-file IDs are not permitted.");
  if (recordsById.size!==declaredById.size)
    issues.push("Source-file inventory differs from Broker confirmation.");
  for (const record of records??[]) {
    if (declaredById.get(record.id)!==record.sourceHash)
      issues.push(`Source hash changed: ${record.id}`);
  }
  for (const field of snapshot.fields??[]) {
    for (const evidence of field.evidence??[]) {
      const record=recordsById.get(evidence.documentId);
      if (!record || record.sourceHash!==evidence.sourceHash)
        issues.push(`Broken source reference: ${field.id}`);
      if (!Number.isSafeInteger(evidence.page) || evidence.page<1)
        issues.push(`Invalid evidence page: ${field.id}`);
      if (evidence.logicalDocumentId &&
          !(record?.logicalDocuments??[]).some(s=>s.id===evidence.logicalDocumentId))
        issues.push(`Broken logical section reference: ${field.id}`);
    }
  }
  return [...new Set(issues)];
}
export function reviewedKeyinPayload(snapshot,item,records,submittedAt) {
  const issues=validateReviewedKeyinPackage(snapshot,item,records,submittedAt);
  if (issues.length)throw fail(issues);
  return {path:REVIEWED_KEYIN_PACKAGE_PATH,
    bytes:Buffer.from(JSON.stringify(snapshot,null,2),"utf8")};
}
/**
 * Return the immutable Broker snapshot and a separate re-mapped view for the
 * Auditor. The original `snapshot_sha256` is not claimed to cover remapped IDs.
 */
export function remapReviewedKeyinForAuditor(snapshot, mapping) {
  const map=id=>mapping.get(id)??id;
  const view=JSON.parse(JSON.stringify(snapshot));
  view.source_case_id=map(view.source_case_id);
  view.source_files=view.source_files.map(f=>({...f,id:map(f.id)}));
  view.fields=view.fields.map(field=>({
    ...field,
    evidence:(field.evidence??[]).map(e=>({
      ...e,documentId:map(e.documentId),
      logicalDocumentId:e.logicalDocumentId?map(e.logicalDocumentId):null
    }))
  }));
  delete view.snapshot_sha256;
  return {
    original_snapshot_sha256:snapshot.snapshot_sha256,
    display_view:view
  };
}
const printable = value => {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value===null || value===undefined) return "Not provided";
  if (typeof value==="number")return String(value);
  if (typeof value==="string")return value;
  if (Array.isArray(value))return value.map(printable).join("; ");
  if (typeof value==="object")return Object.entries(value)
    .map(([k,v])=>`${k}: ${printable(v)}`).join(", ");
  return String(value);
};
export function auditorKeyinSheet(review) {
  return {
    sourceCaseId:review.source_case_id,
    sourceReviewHash:review.original_snapshot_sha256??review.snapshot_sha256??null,
    brokerReview:review.review_status ?? "UNVERIFIED",
    sections:review.sections.map(s=>({
      id:s.id,title:s.title,
      rows:review.fields.filter(f=>f.section===s.id).map(f=>({
        id:f.id,label:f.label,value:printable(f.value),
        originalValue:f.value,source:f.origin,evidencePresent:(f.evidence??[]).length>0
      }))
    }))
  };
}
export function auditorKeyinSheetText(sheet) {
  return sheet.sections.map(section=>[
    section.title,
    ...section.rows.map(row=>`${row.label}: ${row.value}`)
  ].join("\n")).join("\n\n");
}

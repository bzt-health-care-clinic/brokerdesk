/**
 * Broker-side reviewed Key-in workflow.
 * Node-local module; SHA-256 is used to detect accidental content changes,
 * not to authenticate a dishonest Broker. All writes require the local server.
 */
import { createHash } from "node:crypto";
import { buildKeyinCatalog, KEYIN_CATALOG_VERSION } from "./keyin-field-catalog.mjs";
import { validateRemarks } from "./remarks-generator.mjs";
import { validateReportSummary } from "./reviewed-report-schema.mjs";

export const REVIEW_SCHEMA_VERSION = 1;
const deep = value => JSON.parse(JSON.stringify(value));
const supplied = value => value !== null && value !== undefined &&
  !(typeof value === "string" && !value.trim()) &&
  !(Array.isArray(value) && value.length === 0);
const utcDay = text => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text??""))) return null;
  const [y,m,d] = text.split("-").map(Number);
  const n = Date.UTC(y,m-1,d);
  return new Date(n).toISOString().slice(0,10)===text ? n/86400000 : null;
};
const canonical = obj => JSON.stringify(obj,(_,value)=>{
  if (value && !Array.isArray(value) && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]]));
  return value;
});
export const sha256json = obj => createHash("sha256").update(canonical(obj)).digest("hex");
const isoNow = () => new Date().toISOString();
const sectionOf = (review,sectionId) => review.sections.find(s=>s.id===sectionId);
const requireSection = (review,id) => {
  const section=sectionOf(review,id);
  if (!section) throw new Error(`Unknown Broker Key-in section: ${id}`);
  return section;
};
const requireField = (review,id) => {
  const field=review.fields.find(f=>f.id===id);
  if (!field) throw new Error(`Unknown Broker Key-in field: ${id}`);
  return field;
};
function fieldDigestData(field) {
  return { id:field.id, required:field.required, value:field.value,
    origin:field.origin, evidence:field.evidence, conflict:field.conflict };
}
export function sectionFingerprint(review, sectionId) {
  const section = requireSection(review, sectionId);
  return sha256json({
    schema:review.schema_version, catalog:review.catalog_version,
    caseId:review.source_case_id, company:review.company,
    sourceFiles:review.source_files, sectionId:section.id,
    fields:review.fields.filter(f=>f.section===sectionId).map(fieldDigestData)
  });
}
function invalidation(review,sectionIds) {
  for (const id of sectionIds) {
    const s=sectionOf(review,id);
    if (s) {s.status="PENDING";s.confirmation=null;}
  }
}
function ensureVersion(review, expectedRevision) {
  if (expectedRevision !== undefined && review.revision !== expectedRevision) {
    const error=new Error(`Review changed: expected revision ${expectedRevision}, current ${review.revision}.`);
    error.status=409;throw error;
  }
}
/**
 * Options:
 * sourceFiles: verified [{id,sha256}] snapshot; candidates are explicitly
 * source-bound {fieldId,value,documentId,sourceHash,page,active:true}.
 * No association by "only one driver/vehicle" is ever performed.
 */
export function createBrokerReview(item, options = {}) {
  if (!item || !item.case_id) throw new Error("A persisted Case ID is required.");
  const {sections,fields} = buildKeyinCatalog(item,options);
  const sourceFiles=(options.sourceFiles??[]).map(({id,sha256})=>({id,sha256}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  const availableDocs=new Map(sourceFiles.map(f=>[f.id,f.sha256]));
  const assigned=new Map(), unassigned=[];
  for (const candidate of options.candidates??[]) {
    const field=fields.find(f=>f.id===candidate.fieldId);
    const trusted=candidate.active===true && candidate.documentId &&
      availableDocs.get(candidate.documentId)===candidate.sourceHash &&
      Number.isSafeInteger(candidate.page) && candidate.page>0;
    if (!field||!trusted) {unassigned.push(deep(candidate));continue;}
    if (!assigned.has(field.id)) assigned.set(field.id,[]);
    assigned.get(field.id).push(candidate);
  }
  for (const field of fields) {
    const candidates=assigned.get(field.id)??[];
    field.origin="CASE_UNVERIFIED";
    const unique=new Set(candidates.map(c=>canonical(c.value)));
    field.conflict=unique.size>1;
    field.evidence=candidates.map(c=>({documentId:c.documentId,sourceHash:c.sourceHash,
      page:c.page,logicalDocumentId:c.logicalDocumentId??null,
      rawValue:deep(c.value),parserVersion:c.parserVersion??null}));
    if (unique.size===1) {
      field.value=deep(candidates[0].value);
      field.origin="EXTRACTED";
    }
  }
  return {
    schema_version:REVIEW_SCHEMA_VERSION, catalog_version:KEYIN_CATALOG_VERSION,
    source_case_id:item.case_id, case_type:item.case_type,
    company:item.policy?.company??"", revision:1,
    created_at:options.now??isoNow(), updated_at:options.now??isoNow(),
    review_status:"DRAFT", source_files:sourceFiles, unassigned_candidates:unassigned,
    sections, fields, expected_field_ids:fields.map(f=>f.id)
  };
}
/**
 * Edit a final field value; this does NOT modify a PDF, evidence, or the source
 * Case. The Review -> Case compatibility mapping is verified during packaging.
 */
export function editBrokerReviewField(review, fieldId, value, {actor,expectedRevision,now,
  evidence,origin="BROKER_CORRECTED"}={}) {
  ensureVersion(review,expectedRevision);
  if (!actor?.trim()) throw new Error("Broker actor is required.");
  if (!["BROKER_CORRECTED","MANUAL_FROM_SOURCE"].includes(origin))
    throw new Error("Invalid source/origin.");
  const updated=deep(review);
  const field=requireField(updated,fieldId);
  field.value=value===undefined?null:deep(value);
  field.origin=origin;
  if (evidence!==undefined) field.evidence=deep(evidence);
  field.conflict=false; // Broker's explicit resolution supersedes a presented conflict.
  field.corrected_by=actor;field.corrected_at=now??isoNow();
  invalidation(updated,[field.section, ...(field.section==="policy"?
    updated.sections.map(s=>s.id):["changes","vehicles","coverage"].includes(field.section) ?
      ["remarks"] : [])]);
  updated.revision++;updated.updated_at=now??isoNow();updated.review_status="DRAFT";
  return updated;
}
export function updateBrokerReviewSources(review, sourceFiles, {expectedRevision,now}={}) {
  ensureVersion(review,expectedRevision);
  const normalized=sourceFiles.map(({id,sha256})=>({id,sha256}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  if (canonical(normalized)===canonical(review.source_files))return review;
  const updated=deep(review);
  updated.source_files=normalized;
  // Full invalidation is conservative. Future versions can invalidate only
  // affected sections once document-to-section dependency mapping is complete.
  invalidation(updated, updated.sections.map(s=>s.id));
  updated.review_status="DRAFT"; updated.revision++; updated.updated_at=now??isoNow();
  return updated;
}
function currentRequired(review,field) {
  const id=field.id;
  if (id.endsWith(".commuteOneWayKm")) {
    const commute=requireField(review,id.replace(/\.commuteOneWayKm$/, ".commute"));
    return commute.value===true;
  }
  if (id.endsWith(".garagingAddress")) {
    const same=requireField(review,id.replace(/\.garagingAddress$/, ".parkingSameAsMailing"));
    return same.value===false;
  }
  for (const key of ["allPerils","collision","comprehensive"]) {
    if (id.endsWith(`.${key}.deductible`))
      return requireField(review,id.replace(new RegExp(`\\.${key}\\.deductible$`),
        `.${key}.present`)).value===true;
  }
  return field.required===true;
}
function validateAssignments(review,field) {
  const faults=[];
  if (!Array.isArray(field.value)||!field.value.length) return [field.id+": No assigned drivers."];
  const seen=new Set();let principals=0;
  const allowed=new Set(["PRINCIPAL","SECONDARY","OCCASIONAL","NOT_INCLUDED_IN_RATING","EXCLUDED"]);
  const availableDrivers=new Set(review.fields.filter(f=>f.id.startsWith("driver:")&&
    f.id.endsWith(".name")).map(f=>f.id.split(".")[0].slice("driver:".length)));
  for (const entry of field.value) {
    if (!entry || !entry.driverId || !allowed.has(entry.role) ||
        !availableDrivers.has(entry.driverId))
      faults.push(field.id+": Invalid/unknown driver assignment.");
    if (seen.has(entry?.driverId))faults.push(field.id+": Duplicate driver.");
    seen.add(entry?.driverId);
    if (entry?.role==="PRINCIPAL") principals++;
  }
  if (principals>1)faults.push(field.id+": More than one principal driver.");
  if (principals===0)faults.push(field.id+": No principal driver.");
  return faults;
}
export function sectionIssues(review,sectionId,referenceDate=null) {
  requireSection(review,sectionId);
  const errors=[];
  const currentSourceHashes = new Map((review.source_files ?? [])
    .map(source => [source.id, source.sha256]));
  for (const field of review.fields.filter(f=>f.section===sectionId)) {
    for (const proof of field.evidence ?? []) {
      if (!proof?.documentId || currentSourceHashes.get(proof.documentId) !== proof.sourceHash)
        errors.push(`${field.id}: Source evidence is stale or not in current files.`);
    }
    if (field.conflict) errors.push(`${field.id}: Unresolved source conflict.`);
    // The Broker can explicitly confirm that no OPCF was selected; this is
    // not the same as leaving the endorsement list unreviewed.
    const noOpcf = field.id.endsWith(".opcf") &&
      Array.isArray(field.value) && field.value.length === 0;
    if (currentRequired(review,field) && !supplied(field.value) && !noOpcf)
      errors.push(`${field.id}: Broker must provide or confirm this field.`);
    if ((field.id.startsWith("document:")&&field.id.endsWith(".received")) ||
      field.id==="quoteDiscounts.checkedAgainstQuote") {
      if (field.value !== true) errors.push(`${field.id}: Must be confirmed Yes.`);
    }
    // OPCF 44/44R is optional, but an explicit selection on the Quote must
    // agree with the reviewed per-vehicle Yes/No confirmation.
    if (field.id.endsWith(".opcf44")) {
      const endorsements=requireField(review,field.id.slice(0, -".opcf44".length) + ".opcf").value;
      const selected=Array.isArray(endorsements) && endorsements.some(value =>
        ["44","44R","OPCF44","OPCF44R"].includes(String(value).toUpperCase().replaceAll(" ","")));
      if (selected && field.value !== true)
        errors.push(`${field.id}: Quote lists OPCF 44/44R but confirmation is missing.`);
      if (field.value !== null && field.value !== undefined && typeof field.value !== "boolean")
        errors.push(`${field.id}: Endorsement confirmation must be Yes/No.`);
    }
    if (field.id.startsWith("quoteDiscount:") && field.id.endsWith(".evidencePresent")) {
      const selected=requireField(review,field.id.slice(0, -".evidencePresent".length) + ".selected");
      if (selected.value === true && field.value !== true)
        errors.push(`${field.id}: Selected discount requires its proof.`);
    }
    if (field.type==="assignments"&&supplied(field.value))
      errors.push(...validateAssignments(review,field));
    if (field.id.endsWith(".vin") && supplied(field.value) &&
        !/^[A-HJ-NPR-Z0-9]{17}$/i.test(String(field.value).replace(/[\s-]/g,"")))
      errors.push(`${field.id}: Invalid VIN.`);
    if (field.id.endsWith(".year") && field.id.startsWith("vehicle:") &&
        supplied(field.value) && (!Number.isInteger(Number(field.value)) ||
          Number(field.value)<1886 || Number(field.value)>new Date().getUTCFullYear()+2))
      errors.push(`${field.id}: Vehicle year is invalid.`);
    if (field.id.endsWith(".annualKm") && supplied(field.value) &&
        (!Number.isFinite(Number(field.value)) || Number(field.value)<0))
      errors.push(`${field.id}: Annual KM is invalid.`);
    if (field.id.endsWith(".commuteOneWayKm") && currentRequired(review,field) &&
        supplied(field.value) && (!Number.isFinite(Number(field.value)) || Number(field.value)<0))
      errors.push(`${field.id}: One-way commute distance is invalid.`);
    if (field.id.endsWith(".liability") && field.id.startsWith("vehicle:") &&
        supplied(field.value) && (!Number.isFinite(Number(field.value)) ||
          Number(field.value)<=0))
      errors.push(`${field.id}: Liability must be a positive amount.`);
    if (field.id.endsWith(".deductible") && currentRequired(review,field) &&
        supplied(field.value) && (!Number.isFinite(Number(field.value)) ||
          Number(field.value)<0))
      errors.push(`${field.id}: Deductible must be a non-negative amount.`);
    if (field.id.startsWith("report:") && field.id.endsWith(".summary")) {
      const kind=field.id.split(":")[1];
      errors.push(...validateReportSummary(field.value,kind).map(message=>
        `${field.id}: ${message}`));
    }
    if (field.id==="remarks.text") {
      const check=validateRemarks(field.value,review.company,{requireComplete:true});
      errors.push(...check.errors.map(e=>`remarks.text: ${e}`));
    }
    if (field.id.includes("report:") && field.id.endsWith(".pulledDate") &&
        supplied(field.value) && referenceDate) {
      const pulled=utcDay(field.value), submitted=utcDay(referenceDate);
      if (pulled===null || submitted===null)errors.push(`${field.id}: Invalid date.`);
      else if (submitted-pulled<0)errors.push(`${field.id}: Report pulled after submission date.`);
      else if (submitted-pulled>30)errors.push(`${field.id}: Report older than 30 days.`);
    }
  }
  if (sectionId==="final" && review.unassigned_candidates.length)
    errors.push("Some extracted fields are still unassigned; resolve them before package export.");
  return errors;
}
export function confirmBrokerReviewSection(review,sectionId,
  {actor,expectedRevision,now,referenceDate}={}) {
  ensureVersion(review,expectedRevision);
  if (!actor?.trim())throw new Error("Broker actor is required.");
  const updated=deep(review);
  const section=requireSection(updated,sectionId);
  const errors=sectionIssues(updated,sectionId,referenceDate);
  if (errors.length) {
    const error=new Error("Section cannot be confirmed: "+errors.join(" | "));
    error.status=422;error.blockers=errors;throw error;
  }
  section.status="CONFIRMED";
  section.confirmation={brokerId:actor,confirmedAt:now??isoNow(),
    contentSha256:sectionFingerprint(updated,sectionId)};
  updated.revision++;updated.updated_at=now??isoNow();
  return updated;
}
export function reviewExportIssues(review,{submissionDate,requireAll=true}={}) {
  const errors=[];
  if (review.schema_version!==REVIEW_SCHEMA_VERSION ||
      review.catalog_version!==KEYIN_CATALOG_VERSION)
    errors.push("Unsupported Key-in review schema/catalog version.");
  const presentIds=review.fields.map(f=>f.id);
  if (new Set(presentIds).size!==presentIds.length ||
      canonical(presentIds)!==canonical(review.expected_field_ids))
    errors.push("Reviewed field catalog is incomplete or has changed.");
  if (review.unassigned_candidates.length)
    errors.push("Unassigned extracted source candidates remain.");
  for (const section of review.sections) {
    errors.push(...sectionIssues(review,section.id,submissionDate));
    if (!requireAll)continue;
    if (section.status!=="CONFIRMED"||!section.confirmation)
      errors.push(`${section.id}: Section not confirmed by Broker.`);
    else if (section.confirmation.contentSha256!==sectionFingerprint(review,section.id))
      errors.push(`${section.id}: Confirmation is stale or content changed.`);
  }
  return [...new Set(errors)];
}
export function finalizeBrokerReview(review,{brokerId,submittedAt,expectedRevision}={}) {
  ensureVersion(review,expectedRevision);
  if (!brokerId?.trim()) throw new Error("Broker ID is required.");
  const at=submittedAt??isoNow();
  const day=at.slice(0,10);
  const issues=reviewExportIssues(review,{submissionDate:day});
  if (issues.length) {
    const error=new Error("Reviewed Key-in is not ready: "+issues.join(" | "));
    error.status=422;error.blockers=issues;throw error;
  }
  const snapshot=deep(review);
  snapshot.review_status="BROKER_CONFIRMED";
  snapshot.finalized_at=at;
  snapshot.finalized_by=brokerId;
  snapshot.snapshot_sha256=sha256json({...snapshot,snapshot_sha256:undefined});
  return snapshot;
}
export function verifyBrokerSnapshot(snapshot,{submissionDate}={}) {
  if (snapshot.review_status!=="BROKER_CONFIRMED" ||
      !snapshot.snapshot_sha256 ||
      snapshot.snapshot_sha256!==sha256json({...snapshot,snapshot_sha256:undefined}))
    return ["Broker review snapshot hash/status is invalid."];
  return reviewExportIssues(snapshot,{submissionDate});
}

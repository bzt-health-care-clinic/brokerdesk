/**
 * Step 2 local-only HTTP adapter.  Does not modify BDZIP/Inbox or grant
 * Auditor trust to an unexported Broker draft.
 */
import { createBrokerReview, reviewExportIssues, sectionIssues, sha256json } from "../lib/broker-keyin-review.mjs";
import { generateRemarks } from "../lib/remarks-generator.mjs";
import { BrokerKeyinReviewStore } from "./broker-review-store.mjs";
import {
  verifiedReviewDocuments, buildExplicitReviewCandidates, reviewCaseSignature,
  missingPhysicalChecklistDocuments
} from "./broker-review-source.mjs";
import {deriveStep3eOptions} from "./broker-review-step3e-options.mjs";
import {enrichStep3eRemarks} from "./broker-review-step3e-remarks.mjs";

const err=(message,status=409,blockers=[])=>Object.assign(new Error(message),{status,blockers});
const actorOf=value=>{
  const v=String(value??"").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,63}$/.test(v))
    throw err("Broker ID is required (letters, numbers, hyphens or underscores).",400);
  return v;
};
const revisionOf=value=>{
  if(!Number.isSafeInteger(value)||value<1)throw err("expectedRevision must be a positive integer.",400);
  return value;
};
const day=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value)) &&
  !Number.isNaN(Date.parse(value+"T00:00:00Z")) &&
  new Date(value+"T00:00:00Z").toISOString().slice(0,10)===value;
const editValue=(field,value)=>{
  if (value===null) return null;
  if (field.type==="boolean") {
    if(typeof value!=="boolean")throw err("Expected Yes or No.",400);
    return value;
  }
  if (field.type==="number") {
    if(typeof value!=="number"||!Number.isFinite(value)||Math.abs(value)>1e12)
      throw err("Expected a finite number.",400);
    return value;
  }
  if(field.type==="date") {
    if(typeof value!=="string"||!day(value))throw err("Date must be YYYY-MM-DD.",400);
    return value;
  }
  if(field.type==="list") {
    if(!Array.isArray(value)||value.length>100||
       value.some(v=>typeof v!=="string"||v.length>200))
      throw err("Expected a list of short text values.",400);
    return value;
  }
  if(field.type==="assignments") {
    if(!Array.isArray(value)||value.length>20||value.some(v=>
      !v||typeof v.driverId!=="string"||v.driverId.length>150||
      !["PRINCIPAL","SECONDARY","OCCASIONAL","NOT_INCLUDED_IN_RATING","EXCLUDED"].includes(v.role)))
      throw err("Invalid Driver -> Role assignments.",400);
    const assigned=new Set(value.map(v=>v.driverId));
    if(value.some(v=>!v.driverId.trim())||assigned.size!==value.length||
        value.filter(v=>v.role==="PRINCIPAL").length>1)
      throw err("Drivers must be unique within a vehicle, with at most one Principal.",400);
    return value.map(({driverId,role})=>({driverId,role}));
  }
  if(field.type==="record") {
    if(JSON.stringify(value).length>20000||typeof value!=="object"||value===null)
      throw err("Record payload is too large or malformed.",400);
    return value;
  }
  if(field.type==="multiline") {
    if(typeof value!=="string"||value.length>5000)throw err("Text is too long.",400);
    return value.replace(/\r\n?/g,"\n");
  }
  if(typeof value!=="string"||value.length>1200)throw err("Expected text of at most 1200 characters.",400);
  return value;
};
function makeBindingSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS keyin_review_bindings (
    case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
    case_fingerprint TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`);
}
function audit(db,caseId,actor,action,details) {
  db.prepare("INSERT INTO audit_events(case_id,document_id,actor,action,details_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(caseId,null,actor,action,JSON.stringify(details),new Date().toISOString());
}
export function deriveRemarksRequest(review,caseData) {
  const get=id=>review.fields.find(f=>f.id===id)?.value??null;
  const ch=caseData.policy_change??{};
  const list=Array.isArray(ch.transaction_types)?ch.transaction_types:[];
  const type=list[0] || "OTHER_POLICY_CHANGE";
  const date=get("change.effectiveDate") || ch.change_effective_date;
  const request={
    type,company:review.company,effectiveDate:date,
  };
  // Only use explicitly structured change data. If incomplete, the
  // Remarks generator returns a manual fallback, never a fabricated VIN.
  const changes=ch.requested_changes??[];
  const forAction=(actions)=>changes.find(c=>actions.includes(c.type))?.new_value??null;
  if(type==="PAYMENT_CHANGE") request.voidChequeAttached=
    Boolean(caseData.documents?.some(d=>d.category==="void_cheque"&&d.received));
  if(type==="ADDRESS_CHANGE") {
    const found=forAction(["ADDRESS_CHANGE"]);
    if(found && typeof found==="object")
      request.addressChange={mailing:found.mailing===true,risk:found.risk===true,
        newAddress:found.address??null};
  }
  if(type==="CANCELLATION") {
    const found=forAction(["CANCELLATION"]);
    if(found && typeof found==="object")request.cancellation=found;
  }
  return enrichStep3eRemarks(review,caseData,request);
}
export class BrokerReviewService {
  constructor(db,repositories) {
    this.db=db;this.repo=repositories;
    this.store=new BrokerKeyinReviewStore(db);
    makeBindingSchema(db);
  }
  live(caseId) {
    const item=this.repo.getCase(caseId);
    if(!item)throw err("Case not found.",404);
    const docs=verifiedReviewDocuments(this.repo,caseId);
    const verifiedIds=new Set(docs.verified.map(d=>d.id));
    const sections=docs.records.filter(d=>verifiedIds.has(d.id))
      .map(d=>({id:d.id,parserVersion:d.parserVersion??null,
        // A parser re-run can change extracted values or subject grouping
        // even when the underlying PDF bytes remain identical.
        extractedFingerprint:sha256json({
          parsedSources:d.parsedSources??[],
          parsed:d.parsed??null,
          state:d.state??null
        }),
        logicalDocuments:(d.logicalDocuments??[]).map(x=>({
          id:x.id,documentType:x.documentType,startPage:x.startPage??null,
          endPage:x.endPage??null,subjectId:x.subjectId??null,
          presenceStatus:x.presenceStatus,parseStatus:x.parseStatus,
          validationStatus:x.validationStatus
        })),
        withdrawnSectionRanges:d.withdrawnSectionRanges??[]}))
      .sort((a,b)=>a.id.localeCompare(b.id));
    return {item,docs,caseFingerprint:reviewCaseSignature(item),
      sourceFingerprint:sha256json({files:docs.verified,sections})};
  }
  createOptions(live) {
    // First pass provides field IDs from Step 1's canonical field directory.
    // The mapper only assigns values with reliable source and subject IDs.
    const options=deriveStep3eOptions(live.item,live.docs);
    const scratch=createBrokerReview(live.item,{...options,sourceFiles:live.docs.verified});
    const mapped=buildExplicitReviewCandidates(live.item,scratch.fields,live.docs.sources);
    return {...options,sourceFiles:live.docs.verified,candidates:mapped.candidates};
  }
  saveBinding(caseId,live) {
    this.db.prepare(`INSERT INTO keyin_review_bindings(case_id,case_fingerprint,source_fingerprint,updated_at)
      VALUES(?,?,?,?) ON CONFLICT(case_id) DO UPDATE SET
      case_fingerprint=excluded.case_fingerprint,
      source_fingerprint=excluded.source_fingerprint,updated_at=excluded.updated_at`)
      .run(caseId,live.caseFingerprint,live.sourceFingerprint,new Date().toISOString());
  }
  create(caseId,body={}) {
    const actor=actorOf(body.actor);
    const live=this.live(caseId);
    if(live.docs.warnings.length)throw err("Some source files are stale or missing.",409,live.docs.warnings);
    const review=createBrokerReview(live.item,this.createOptions(live));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if(this.store.read(caseId))throw err("Review already exists; use the existing draft.",409);
      this.db.prepare(`INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at)
        VALUES(?,?,?,?,?)`).run(caseId,review.revision,review.review_status,
          JSON.stringify(review),review.updated_at);
      this.saveBinding(caseId,live);
      audit(this.db,caseId,actor,"BROKER_REVIEW_CREATED",{revision:review.revision});
      this.db.exec("COMMIT");
      return this.read(caseId);
    } catch(e) {this.db.exec("ROLLBACK");throw e;}
  }
  bindingStatus(caseId,review,live) {
    const binding=this.db.prepare("SELECT * FROM keyin_review_bindings WHERE case_id=?").get(caseId);
    const issues=[...live.docs.warnings];
    if(!binding)issues.push("Review has no source/Case binding; rebuild required.");
    else {
      if(binding.case_fingerprint!==live.caseFingerprint)
        issues.push("Case details changed since the Review was created; rebuild required.");
      if(binding.source_fingerprint!==live.sourceFingerprint)
        issues.push("Original files, document sections or parsed evidence changed; rebuild required.");
    }
    if(sha256json(review.source_files)!==sha256json(live.docs.verified))
      issues.push("Review's source file list does not match stored originals.");
    return issues;
  }
  read(caseId) {
    const live=this.live(caseId);
    const review=this.store.read(caseId);
    if(!review)return {review:null,sourceIssues:live.docs.warnings,ready:false,
      caseId,fieldIssues:[],confirmed:0,total:0};
    const sourceIssues=this.bindingStatus(caseId,review,live);
    const fieldIssues=review.sections.flatMap(s=>sectionIssues(review,s.id,new Date().toISOString().slice(0,10))
      .map(message=>({sectionId:s.id,message})));
    return {review,sourceIssues,fieldIssues,
      confirmed:review.sections.filter(s=>s.status==="CONFIRMED").length,
      total:review.sections.length,ready:sourceIssues.length===0&&
        reviewExportIssues(review,{submissionDate:new Date().toISOString().slice(0,10)}).length===0};
  }
  checked(caseId,expectedRevision) {
    const live=this.live(caseId);
    const review=this.store.read(caseId);
    if(!review)throw err("Review not created.",404);
    if(review.revision!==expectedRevision)throw err("Review revision conflict.",409);
    const issues=this.bindingStatus(caseId,review,live);
    if(issues.length)throw err("Original Case/files changed; rebuild the draft before editing or confirming.",409,issues);
    if(review.review_status==="BROKER_CONFIRMED")
      throw err("A final Broker snapshot cannot be edited.",409);
    return {live,review};
  }
  edit(caseId,body={}) {
    const actor=actorOf(body.actor),expectedRevision=revisionOf(body.expectedRevision);
    const {review}=this.checked(caseId,expectedRevision);
    const field=review.fields.find(f=>f.id===body.fieldId);
    if(!field)throw err("Unknown field ID.",400);
    const value=editValue(field,body.value);
    if (field.type==="assignments" && Array.isArray(value)) {
      const allowed=new Set(review.fields.filter(f=>f.id.startsWith("driver:") &&
        f.id.endsWith(".name")).map(f=>f.id.slice(7,-5)));
      if(value.some(entry=>!allowed.has(entry.driverId)))
        throw err("Assignment refers to a driver not in the current Case.",400);
    }
    this.store.edit(caseId,field.id,value,{actor,expectedRevision});
    return this.read(caseId);
  }
  confirm(caseId,body={}) {
    const actor=actorOf(body.actor),expectedRevision=revisionOf(body.expectedRevision);
    const checked=this.checked(caseId,expectedRevision);
    const date=new Date().toISOString().slice(0,10);
    // An empty original package must never be accidentally treated as verified.
    const live=checked.live;
    if(body.sectionId==="documents") {
      const missing=missingPhysicalChecklistDocuments(live.item,live.docs);
      if(missing.length)throw err("Required files not matched to verified originals.",422,missing);
    }
    if(!live.docs.verified.length)
      throw err("At least one verified source document must be uploaded.",422);
    this.store.confirm(caseId,body.sectionId,{actor,expectedRevision,referenceDate:date});
    return this.read(caseId);
  }
  rebuild(caseId,body={}) {
    const actor=actorOf(body.actor),expectedRevision=revisionOf(body.expectedRevision);
    const previous=this.store.read(caseId);
    if(!previous)throw err("Review not found.",404);
    if(previous.revision!==expectedRevision)throw err("Review revision conflict.",409);
    if(previous.review_status==="BROKER_CONFIRMED")throw err("Finalized review is immutable.",409);
    const live=this.live(caseId);
    if(live.docs.warnings.length)throw err("Cannot rebuild with stale source files.",409,live.docs.warnings);
    const fresh=createBrokerReview(live.item,this.createOptions(live));
    fresh.revision=previous.revision+1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated=this.db.prepare(`UPDATE keyin_reviews SET revision=?,status=?,review_json=?,updated_at=?
        WHERE case_id=? AND revision=?`).run(fresh.revision,fresh.review_status,
        JSON.stringify(fresh),fresh.updated_at,caseId,previous.revision);
      if(updated.changes!==1)throw err("Concurrent draft change.",409);
      this.saveBinding(caseId,live);
      audit(this.db,caseId,actor,"BROKER_REVIEW_REBUILT",{revision:fresh.revision});
      this.db.exec("COMMIT");
    } catch(e) {this.db.exec("ROLLBACK");throw e;}
    return this.read(caseId);
  }
  remarks(caseId) {
    const {review}=this.checked(caseId,this.store.read(caseId)?.revision);
    const sourceCase=this.repo.getCase(caseId);
    if(!review.case_type.endsWith("policy_change"))throw err("Remarks are for Policy Changes.",400);
    const result=generateRemarks(deriveRemarksRequest(review,sourceCase));
    return {preview:result,reviewRevision:review.revision};
  }
  handle(caseId,part,method,body) {
    if(!part&&method==="GET")return {status:200,body:this.read(caseId)};
    if(!part&&method==="POST")return {status:201,body:this.create(caseId,body)};
    if(part==="fields"&&method==="PATCH")return {status:200,body:this.edit(caseId,body)};
    if(part==="sections"&&method==="POST")return {status:200,body:this.confirm(caseId,body)};
    if(part==="rebuild"&&method==="POST")return {status:200,body:this.rebuild(caseId,body)};
    if(part==="remarks-preview"&&method==="GET")return {status:200,body:this.remarks(caseId)};
    throw err("Unknown Broker Review endpoint/method.",404);
  }
}

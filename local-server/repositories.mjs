import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { audit } from "./database.mjs";
import { inside, safeId, safeRelativePath } from "./paths.mjs";

const now = () => new Date().toISOString();
const authorizationKey = "transaction_authorization";
const namesKey = "named_insured_comparison";
const normPerson = name => typeof name === "string" ? name.normalize("NFKC").replace(/\s+/g," ").trim().toUpperCase() : "";
const people = item => [item.insured?.name,...(item.insured?.co_insured??[]).map(p=>p.name)].map(normPerson);
const matchPeople = (a,b) => Array.isArray(a)&&Array.isArray(b)&&a.length>0&&a.length===b.length&&a.every(Boolean)&&b.every(Boolean)&&new Set(a).size===a.length&&new Set(b).size===b.length&&[...a].sort().every((v,i)=>v===[...b].sort()[i]);
const transactionTypes = item => {const names=item.policy_change?.transaction_types??[];const action=String(item.policy_change?.requested_action??"");return {cancel:names.includes("CANCELLATION")||/cancell?/i.test(action),name:names.includes("NAME_CHANGE")||/name.change/i.test(action),payment:names.includes("PAYMENT_CHANGE")||/payment.change/i.test(action)}};
const signatureKeys = [
  "signed", "signed_verified_at", "signed_document_id", "signed_logical_document_id",
  "signed_evidence_document_type", "signed_evidence_start_page", "signed_evidence_end_page",
];
const clearSignature = (item) => {
  const next = { ...item, signed: false };
  for (const key of signatureKeys) if (key !== "signed") delete next[key];
  if ((next.case_type === "new_auto" || next.case_type === "new_home") && next.status === "keyed") next.status = "incomplete";
  return next;
};
const signatureError = (message, status = 409) => Object.assign(new Error(message), { status });
const json = (value) => JSON.stringify(value);
const parse = (value) => JSON.parse(value);
const cleanName = (value) => basename(value || "document").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
const safeDisplayName = (value) => basename(String(value || "Document")).replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim().slice(0, 180) || "Document";

export function compactPackageRecord(record) {
  if (!record.packagePages?.length || !record.raw || (!record.raw.text && !record.raw.rawText && !record.raw.normalizedText && !record.raw.pages?.length)) return { record, changed: false };
  const charactersExtracted = record.packagePages.reduce((total, page) => total + (page.text?.length ?? 0), 0);
  return { record: { ...record, raw: { metadata: { ...record.raw.metadata, provider: record.raw.metadata?.provider ?? "page_package_pipeline", pageLevel: true, charactersExtracted, pageCount: record.packagePages.length } } }, changed: true };
}

// Cache of file content hashes keyed by path; invalidated when mtime/size changes,
// so listDocuments no longer re-hashes every file on every read.
const sourceHashCache = new Map();
function cachedSourceHash(filePath) {
  const stat = statSync(filePath);
  const cached = sourceHashCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.hash;
  const hash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  sourceHashCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
  return hash;
}

export class LocalRepositories {
  constructor(db, paths) { this.db = db; this.paths = paths; }

  caseSummary(row) { return { id: row.id, label: row.label, insuredName: row.insured_name, caseType: row.case_type, carrier: row.carrier, policyNumber: row.policy_number, quoteNumber: row.quote_number, status: row.status, archived: Boolean(row.archived), createdAt: row.created_at, updatedAt: row.updated_at }; }
  listCases(search = "", archived = false) {
    const needle = `%${search.trim()}%`;
    return this.db.prepare(`SELECT id,label,insured_name,case_type,carrier,policy_number,quote_number,status,archived,created_at,updated_at FROM cases WHERE deleted_at IS NULL AND archived=? AND (?='' OR insured_name LIKE ? OR policy_number LIKE ? OR quote_number LIKE ? OR vin LIKE ? OR client_code LIKE ?) ORDER BY created_at DESC, id DESC`)
      .all(archived ? 1 : 0, search.trim(), needle, needle, needle, needle, needle).map((row) => this.caseSummary(row));
  }
  getCase(id) { const row = this.db.prepare("SELECT * FROM cases WHERE id=? AND deleted_at IS NULL").get(safeId(id)); return row ? { ...parse(row.case_json), label: row.label, status: row.status } : null; }
  upsertCase(data, action = "UPDATE_CASE", { trustedSignature = false } = {}) {
    let item = { ...data.case }; const id = safeId(item.case_id); const stamp = now(); const vehicle = item.vehicles?.[0];
    // Signed confirmation is server-owned. Ordinary PUT/autosave/JSON imports
    // cannot set or replace a verified signature reference.
    if (!trustedSignature) {
      const stored = this.getCase(id);
      if (stored) {
        for (const key of signatureKeys) {
          if (stored[key] === undefined) delete item[key];
          else item[key] = stored[key];
        }
        if (item.signed && !this.signedEvidenceStillValid(item)) {
          item = clearSignature(item);
          audit(this.db, "SIGNED_EVIDENCE_INVALID", { caseId: id, details: { reason: "invalid-on-save" } });
        }
        if (stored[namesKey] === undefined) delete item[namesKey];
        else item[namesKey] = stored[namesKey];
        if (item[namesKey] && !this.namedInsuredComparisonStillValid(item)) {
          delete item[namesKey];
          audit(this.db,"INSURED_NAMES_EVIDENCE_INVALID",{caseId:id});
        }
        // Authorization is server-owned: JSON import/autosave cannot fabricate it.
        if (stored[authorizationKey] === undefined) delete item[authorizationKey];
        else item[authorizationKey] = stored[authorizationKey];
        if (item[authorizationKey] && !this.transactionAuthorizationStillValid(item)) {
          delete item[authorizationKey];
          if (item.status === "keyed") item.status = "incomplete";
          audit(this.db, "TRANSACTION_AUTH_INVALID", { caseId: id, details: { reason: "invalid-on-save" } });
        }
      } else {
        item = clearSignature(item);
        delete item[authorizationKey];
        delete item[namesKey];
      }
      if ((item.case_type === "new_auto" || item.case_type === "new_home") && item.status === "keyed" && !item.signed) {
        throw signatureError("Signed application verification is required before marking this case KEYED.");
      }
    }
    this.db.prepare(`INSERT INTO cases(id,label,insured_name,case_type,carrier,policy_number,quote_number,vin,client_code,status,case_json,archived,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,insured_name=excluded.insured_name,case_type=excluded.case_type,carrier=excluded.carrier,policy_number=excluded.policy_number,quote_number=excluded.quote_number,vin=excluded.vin,client_code=excluded.client_code,status=excluded.status,case_json=excluded.case_json,updated_at=excluded.updated_at`)
      .run(id, item.label, item.insured?.name || "", item.case_type || "", item.policy?.company || "", item.policy?.policy_number || "", item.policy?.auto_quote_number || item.policy?.hab_quote_number || item.policy?.quote_number || "", vehicle?.vin || item.ownership?.vin || "", item.policy?.client_code || "", item.status || "new", json(item), 0, stamp, stamp);
    audit(this.db, action, { caseId: id }); return this.getCase(id);
  }
  renameCase(id, label) { const item = this.getCase(id); if (!item) return null; item.label = String(label).trim(); return this.upsertCase({ case: item }, "RENAME_CASE"); }
  archiveCase(id) { this.db.prepare("UPDATE cases SET archived=1,updated_at=? WHERE id=? AND deleted_at IS NULL").run(now(), safeId(id)); audit(this.db, "ARCHIVE_CASE", { caseId: id }); }
  deleteCase(id) {
    id = safeId(id); const folder = resolve(this.paths.documents, id); if (!inside(this.paths.documents, folder)) throw new Error("Unsafe case path");
    this.db.exec("BEGIN IMMEDIATE"); try { this.db.prepare("DELETE FROM cases WHERE id=?").run(id); audit(this.db, "DELETE_CASE", { caseId: id, details: { tombstone: true } }); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (existsSync(folder)) rmSync(folder, { recursive: true, force: true });
  }

  logicalDocuments(physicalFileId) { return this.db.prepare("SELECT * FROM logical_documents WHERE physical_file_id=? ORDER BY created_at,id").all(physicalFileId).map((row) => ({ id: row.id, caseId: row.case_id, physicalFileId: row.physical_file_id, documentType: row.document_type, title: row.title, startPage: row.start_page ?? undefined, endPage: row.end_page ?? undefined, subjectName: row.subject_name ?? undefined, subjectType: row.subject_type ?? undefined, subjectId: row.subject_id ?? undefined, documentSubtype: row.document_subtype ?? undefined, presenceStatus: row.presence_status, parseStatus: row.parse_status, validationStatus: row.validation_status, classificationSource: row.classification_source, classificationConfidence: row.classification_confidence ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at })); }
  syncLogicalDocuments(caseId, physicalFileId, record, source = "AUTOMATIC") {
    const stamp = now(); let items = record.logicalDocuments;
    if (items === undefined) items = [{ id: randomUUID(), physicalFileId, documentType: record.documentType, title: record.fileName, startPage: 1, endPage: record.pageCount, presenceStatus: "FOUND", parseStatus: record.state === "PARSED" ? "PARSED" : record.state === "FAILED" ? "FAILED" : "NOT_EVALUATED", validationStatus: record.validation?.validationStatus === "COMPLETE" ? "VALID" : "NOT_EVALUATED", classificationSource: source, classificationConfidence: record.classification?.confidence, createdAt: stamp, updatedAt: stamp }];
    this.db.prepare("DELETE FROM logical_documents WHERE physical_file_id=?").run(physicalFileId);
    const insert = this.db.prepare("INSERT INTO logical_documents(id,case_id,physical_file_id,document_type,title,start_page,end_page,subject_name,subject_type,subject_id,document_subtype,presence_status,parse_status,validation_status,classification_source,classification_confidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    for (const item of items) insert.run(safeId(item.id, "logical document id"), caseId, physicalFileId, item.documentType, item.title || item.documentType, item.startPage ?? null, item.endPage ?? item.startPage ?? null, item.subjectName ?? null, item.subjectType ?? null, item.subjectId ?? null, item.documentSubtype ?? null, item.presenceStatus || "FOUND", item.parseStatus || "NOT_EVALUATED", item.validationStatus || "NOT_EVALUATED", item.classificationSource || source, item.classificationConfidence ?? null, item.createdAt || stamp, stamp);
    return this.logicalDocuments(physicalFileId);
  }
  listDocuments(caseId) { return this.db.prepare("SELECT id,original_filename,stored_filename,record_json FROM documents WHERE case_id=? AND deleted_at IS NULL ORDER BY uploaded_at").all(safeId(caseId)).map((row) => { const compacted = compactPackageRecord(parse(row.record_json)); const record = compacted.record; const file = this.documentPath(row.id); const currentSourceHash = file ? cachedSourceHash(file.path) : "MISSING";
    // Legacy uploads are bound to an immutable document id; keep the baseline in memory only.
    // (No read-time UPDATE: a read must not write, and the hash cache makes recompute cheap.)
    if (!record.sourceHash) record.sourceHash = currentSourceHash;
    // Read path must not write: missing logical documents are backfilled by the
    // one-time migrateLogicalDocuments() at server startup. Return whatever the
    // table has (possibly empty) instead of synthesizing rows on read.
    const logicalDocuments = this.logicalDocuments(row.id); return { ...record, currentSourceHash, originalFileName: row.original_filename, currentFileName: row.stored_filename, logicalDocuments }; }); }
  getDocument(id) { return this.db.prepare("SELECT * FROM documents WHERE id=? AND deleted_at IS NULL").get(safeId(id, "document id")); }

  // Resolve an actual saved application, not a checklist id. A segmented file
  // requires a concrete active application section. The saved source SHA-256 must
  // match the bytes on disk, including after a restart or external modification.
  signatureReference(caseItem, documentId, logicalDocumentId) {
    if (!documentId) return null;
    const expected = caseItem.case_type === "new_auto" ? "AUTO_APPLICATION" : caseItem.case_type === "new_home" ? "HAB_APPLICATION" : null;
    if (!expected) return null;
    const row = this.db.prepare("SELECT * FROM documents WHERE id=? AND case_id=? AND deleted_at IS NULL").get(safeId(documentId, "document id"), caseItem.case_id);
    if (!row) return null;
    const file = this.documentPath(row.id);
    if (!file) return null;
    const record = parse(row.record_json);
    // A security-sensitive verification must hash actual bytes, not trust the mtime/size cache.
    const actualHash = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    if (!record.sourceHash || record.staleExtraction || actualHash !== record.sourceHash) return null;
    const sections = this.logicalDocuments(row.id);
    if (logicalDocumentId) {
      const section = sections.find((candidate) => candidate.id === logicalDocumentId && candidate.documentType === expected && candidate.presenceStatus === "FOUND");
      if (!section) return null;
      const start = section.startPage ?? 1, end = section.endPage ?? start;
      if ((record.withdrawnSectionRanges ?? []).some(range => start <= range.endPage && end >= range.startPage)) return null;
      return { documentId: row.id, logicalDocumentId, documentType: expected, startPage: section.startPage, endPage: section.endPage };
    }
    if (sections.length || record.documentType !== expected || (record.withdrawnSectionRanges ?? []).length) return null;
    return { documentId: row.id, documentType: expected };
  }
  signedEvidenceStillValid(item) {
    if (!item?.signed) return true;
    if (!item.signed_document_id || !item.signed_verified_at) return false;
    const ref = this.signatureReference(item, item.signed_document_id, item.signed_logical_document_id);
    if (!ref) return false;
    if (item.signed_evidence_document_type && item.signed_evidence_document_type !== ref.documentType) return false;
    if (item.signed_logical_document_id && (
      item.signed_evidence_start_page !== undefined && item.signed_evidence_start_page !== ref.startPage ||
      item.signed_evidence_end_page !== undefined && item.signed_evidence_end_page !== ref.endPage
    )) return false;
    return true;
  }
  evidenceReference(item, documentId, logicalDocumentId, allowed) {
    if (!documentId) return null;
    const row=this.getDocument(documentId);
    if (!row || row.case_id!==item.case_id) return null;
    const file=this.documentPath(documentId);
    if (!file) return null;
    const record=parse(row.record_json);
    const checksum=createHash("sha256").update(readFileSync(file.path)).digest("hex");
    if (!record.sourceHash || record.staleExtraction || record.sourceHash!==checksum) return null;
    const sections=this.logicalDocuments(documentId);
    if (logicalDocumentId) {
      const sec=sections.find(x=>x.id===logicalDocumentId&&x.presenceStatus==="FOUND"&&allowed.includes(x.documentType));
      if (!sec || (record.withdrawnSectionRanges??[]).some(r=>(sec.startPage??1)<=r.endPage&&(sec.endPage??sec.startPage??1)>=r.startPage)) return null;
      return {documentId,logicalDocumentId,type:sec.documentType,hash:checksum,startPage:sec.startPage,endPage:sec.endPage};
    }
    if (sections.length || !allowed.includes(record.documentType) || record.withdrawnSectionRanges?.length) return null;
    return {documentId,type:record.documentType,hash:checksum};
  }
  namedInsuredComparisonStillValid(item) {
    const data=item.named_insured_comparison;
    if (!data || !data.confirmed_at || !data.confirmed_by || !item.signed || !this.signedEvidenceStillValid(item)) return false;
    const app=this.evidenceReference(item,data.application?.document_id,data.application?.logical_document_id,[item.case_type==="new_auto"?"AUTO_APPLICATION":"HAB_APPLICATION"]);
    const quote=this.evidenceReference(item,data.quote?.document_id,data.quote?.logical_document_id,[item.case_type==="new_auto"?"AUTO_QUOTE":"HAB_QUOTE"]);
    const matched=(saved,live)=>Boolean(saved&&live&&saved.source_sha256===live.hash&&saved.document_type===live.type&&saved.start_page===live.startPage&&saved.end_page===live.endPage&&saved.logical_document_id===live.logicalDocumentId);
    const a=(data.application_names??[]).map(normPerson),b=(data.quote_names??[]).map(normPerson);
    return matched(data.application,app)&&matched(data.quote,quote)&&app.documentId===item.signed_document_id&&app.logicalDocumentId===item.signed_logical_document_id&&matchPeople(a,a)&&matchPeople(b,b);
  }
  saveNamedInsuredComparison(caseId,request,actor="Local Broker") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item=this.getCase(safeId(caseId));if(!item)throw signatureError("Case not found.",404);
      if (!["new_auto","new_home"].includes(item.case_type))throw signatureError("New Business only.",400);
      const next={...item};
      if(request.verified===false) delete next.named_insured_comparison;
      else {
        if(!item.signed||!this.signedEvidenceStillValid(item))throw signatureError("Verify signed application first.");
        const app=this.evidenceReference(item,request.applicationDocumentId,request.applicationLogicalDocumentId,[item.case_type==="new_auto"?"AUTO_APPLICATION":"HAB_APPLICATION"]);
        const quote=this.evidenceReference(item,request.quoteDocumentId,request.quoteLogicalDocumentId,[item.case_type==="new_auto"?"AUTO_QUOTE":"HAB_QUOTE"]);
        if(!app||!quote||app.documentId!==item.signed_document_id||app.logicalDocumentId!==item.signed_logical_document_id)throw signatureError("Choose the verified Application and an active Quote.");
        const a=request.applicationNames,b=request.quoteNames;
        if(!Array.isArray(a)||!Array.isArray(b)||!matchPeople(a.map(normPerson),a.map(normPerson))||!matchPeople(b.map(normPerson),b.map(normPerson))||a.length>8||b.length>8)throw signatureError("Provide unique document-specific named insured names.",400);
        const binding=x=>({document_id:x.documentId,logical_document_id:x.logicalDocumentId,document_type:x.type,source_sha256:x.hash,start_page:x.startPage,end_page:x.endPage});
        next.named_insured_comparison={application:binding(app),quote:binding(quote),application_names:a.map(x=>x.trim()),quote_names:b.map(x=>x.trim()),confirmed_at:now(),confirmed_by:actor};
      }
      this.upsertCase({case:next},"UPDATE_CASE",{trustedSignature:true});
      audit(this.db,request.verified===false?"INSURED_NAMES_REVOKED":"INSURED_NAMES_COMPARED",{caseId,details:{actor}});
      this.db.exec("COMMIT");return this.getCase(caseId);
    }catch(e){this.db.exec("ROLLBACK");throw e}
  }
  transactionAuthorizationReference(item, documentId, logicalDocumentId) {
    if (!["auto_policy_change", "home_policy_change"].includes(item.case_type)) return null;
    if (!documentId) return null;
    const row = this.getDocument(documentId);
    if (!row || row.case_id !== item.case_id) return null;
    const file = this.documentPath(row.id);
    if (!file) return null;
    const record = parse(row.record_json);
    const fingerprint = createHash("sha256").update(readFileSync(file.path)).digest("hex");
    if (!record.sourceHash || record.sourceHash !== fingerprint || record.staleExtraction) return null;
    const types = transactionTypes(item);
    const allowed = types.cancel ? ["CANCELLATION_REQUEST"] :
      types.name ? ["POLICY_CHANGE", "OPCF_FORM"] :
      types.payment ? ["PAYMENT_AUTHORIZATION", "POLICY_CHANGE"] :
      ["POLICY_CHANGE", "OPCF_FORM"];
    const sections = this.logicalDocuments(row.id);
    if (logicalDocumentId) {
      const section = sections.find(s => s.id === logicalDocumentId && s.presenceStatus === "FOUND" && allowed.includes(s.documentType));
      if (!section) return null;
      if ((record.withdrawnSectionRanges ?? []).some(r =>
        (section.startPage ?? 1) <= r.endPage && (section.endPage ?? section.startPage ?? 1) >= r.startPage)) return null;
      return { documentId, logicalDocumentId, type: section.documentType, hash: fingerprint,
        startPage: section.startPage, endPage: section.endPage };
    }
    if (sections.length && (sections.length > 1 || sections[0].presenceStatus !== "FOUND" || !allowed.includes(sections[0].documentType)))
      return null;
    if (!sections.length && !allowed.includes(record.documentType)) return null;
    if (record.withdrawnSectionRanges?.length) return null;
    return { documentId, type: sections[0]?.documentType ?? record.documentType, hash: fingerprint };
  }
  transactionAuthorizationStillValid(item) {
    const auth = item.transaction_authorization;
    if (!auth?.verified) return false;
    const ref = this.transactionAuthorizationReference(item, auth.document_id, auth.logical_document_id);
    if(!ref||ref.hash!==auth.source_sha256||ref.type!==auth.document_type||(auth.logical_document_id!==undefined&&(ref.startPage!==auth.start_page||ref.endPage!==auth.end_page)))return false;
    const types=transactionTypes(item),required=people(item).length>1||types.cancel,expected=people(item);
    if(types.cancel&&(auth.authorization_type!=="CANCELLATION_REQUEST"||auth.document_type!=="CANCELLATION_REQUEST"))return false;
    if(!required&&!auth.signers?.length)return true;
    if(!expected.length||expected.some(x=>!x)||new Set(expected).size!==expected.length||!Array.isArray(auth.signers)||!matchPeople(auth.signers.map(s=>normPerson(s.name)),expected))return false;
    const allowed=types.cancel?["CANCELLATION_REQUEST"]:types.name?["POLICY_CHANGE","OPCF_FORM"]:types.payment?["PAYMENT_AUTHORIZATION","POLICY_CHANGE"]:["POLICY_CHANGE","OPCF_FORM"];
    return auth.signers.every(s=>{const v=this.evidenceReference(item,s.document_id,s.logical_document_id,allowed);return Boolean(s.verified_at&&s.verified_by&&v&&v.logicalDocumentId&&v.hash===s.source_sha256&&v.type===s.document_type&&v.startPage===s.start_page&&v.endPage===s.end_page&&Number.isInteger(s.signature_page)&&Number.isInteger(v.startPage)&&Number.isInteger(v.endPage)&&s.signature_page>=v.startPage&&s.signature_page<=v.endPage)});

  }
  saveTransactionAuthorization(caseId, requested, actor = "Local Broker") {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getCase(safeId(caseId)); if (!item) throw signatureError("Case not found.",404);
      if (!["auto_policy_change","home_policy_change"].includes(item.case_type))
        throw signatureError("Authorization is only for policy-change cases.",400);
      let next = { ...item };
      if (requested.verified) {
        const ref = this.transactionAuthorizationReference(item, requested.documentId, requested.logicalDocumentId);
        if (!ref) throw signatureError("Signed change authorization source is missing, mismatched, stale or withdrawn.");
        const types=transactionTypes(item),expected=people(item),required=expected.length>1||types.cancel;
        const incoming=requested.signers;
        if(incoming!==undefined&&!Array.isArray(incoming))throw signatureError("Signer list must be an array.",400);
        if(required&&(!Array.isArray(incoming)||!matchPeople(incoming.map(s=>normPerson(s.name)),expected)))throw signatureError("Each named policyholder must have a distinct verified signature.",409);
        const allowed=types.cancel?["CANCELLATION_REQUEST"]:types.name?["POLICY_CHANGE","OPCF_FORM"]:types.payment?["PAYMENT_AUTHORIZATION","POLICY_CHANGE"]:["POLICY_CHANGE","OPCF_FORM"];
        const signers=(incoming??[]).map(s=>{
          const live=this.evidenceReference(item,s.documentId,s.logicalDocumentId,allowed);
          if(s.verified!==true||!expected.includes(normPerson(s.name))||!live?.logicalDocumentId||!Number.isInteger(s.signaturePage)||!Number.isInteger(live.startPage)||!Number.isInteger(live.endPage)||s.signaturePage<live.startPage||s.signaturePage>live.endPage)throw signatureError("Signatures need manual confirmation, correct name, active document section and valid page.",409);
          return {name:s.name.trim(),document_id:live.documentId,logical_document_id:live.logicalDocumentId,document_type:live.type,source_sha256:live.hash,start_page:live.startPage,end_page:live.endPage,signature_page:s.signaturePage,verified_at:now(),verified_by:actor};
        });
        if(signers.length&&!matchPeople(signers.map(s=>normPerson(s.name)),expected))throw signatureError("Signer list does not match policyholders.",409);
        next.transaction_authorization={
          verified:true,authorization_type:types.cancel?"CANCELLATION_REQUEST":types.name?"NAME_CHANGE_REQUEST":"SIGNED_CHANGE_FORM",
          document_id:ref.documentId,logical_document_id:ref.logicalDocumentId,document_type:ref.type,source_sha256:ref.hash,verified_at:now(),verified_by:actor,start_page:ref.startPage,end_page:ref.endPage,...(signers.length?{signers}:{})
        };
      } else {
        delete next.transaction_authorization;
        if (next.status === "keyed") next.status = "incomplete";
      }
      this.upsertCase({case:next}, "UPDATE_CASE", {trustedSignature:true});
      audit(this.db, requested.verified ? "TRANSACTION_AUTH_VERIFIED" : "TRANSACTION_AUTH_REVOKED", {
        caseId, documentId: requested.documentId ?? item.transaction_authorization?.document_id ?? null,
        details: { actor, authorizationType: next.transaction_authorization?.authorization_type ?? null } });
      this.db.exec("COMMIT");
      return this.getCase(caseId);
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  // Must be called inside the caller's transaction, AFTER modifying a document.
  // Prevents direct API calls, section edits and file replacement from leaving a
  // completed case with a signature that no longer has valid source evidence.
  revokeInvalidSignature(caseId, reason) {
    let item = this.getCase(caseId);
    let revokedAuthorization = false;
    if (item?.transaction_authorization && !this.transactionAuthorizationStillValid(item)) {
      const modified = { ...item };
      delete modified.transaction_authorization;
      if (modified.status === "keyed") modified.status = "incomplete";
      this.upsertCase({ case: modified }, "UPDATE_CASE", { trustedSignature: true });
      audit(this.db, "TRANSACTION_AUTH_WITHDRAWN", { caseId,
        documentId: item.transaction_authorization.document_id,
        details: {reason, logicalDocumentId: item.transaction_authorization.logical_document_id ?? null} });
      revokedAuthorization = true;
      item = this.getCase(caseId); // do not re-save a withdrawn authorization
    }
    if(item?.named_insured_comparison&&!this.namedInsuredComparisonStillValid(item)){const next={...item};delete next.named_insured_comparison;this.upsertCase({case:next},"UPDATE_CASE",{trustedSignature:true});audit(this.db,"INSURED_NAMES_EVIDENCE_WITHDRAWN",{caseId,details:{reason}});item=this.getCase(caseId)}
    if (!item?.signed || this.signedEvidenceStillValid(item)) return revokedAuthorization;
    const cleared = clearSignature(item);
    this.upsertCase({ case: cleared }, "UPDATE_CASE", { trustedSignature: true });
    audit(this.db, "SIGNED_EVIDENCE_WITHDRAWN", { caseId, documentId: item.signed_document_id ?? null,
      details: { reason, logicalDocumentId: item.signed_logical_document_id ?? null,
        statusChanged: item.status === "keyed" ? "keyed->incomplete" : null } });
    return true;
  }
  // An atomic, audited signature transition. No other route can edit signed
  // fields, and the server checks the selected physical file and section itself.
  saveSignedCase(caseId, submitted, action, details = {}) {
    caseId = safeId(caseId);
    if (!["SIGNED_VERIFIED", "SIGNED_UNVERIFIED", "SIGNED_EVIDENCE_WITHDRAWN", "SIGNED_EVIDENCE_INVALID"].includes(action)) {
      throw signatureError("Unsupported signature action.", 400);
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getCase(caseId);
      if (!existing) throw signatureError("Case not found.", 404);
      if (submitted?.case_id !== caseId || !["new_auto", "new_home"].includes(existing.case_type) || submitted.case_type !== existing.case_type) {
        throw signatureError("Signature transition is not valid for this case.", 400);
      }
      // A stale browser request must never move completion status or rewrite case identity.
      // Physical document edits already auto-revoke signed state inside their own transaction;
      // a subsequent browser notification is intentionally idempotent.
      if ((action === "SIGNED_EVIDENCE_WITHDRAWN" || action === "SIGNED_EVIDENCE_INVALID") && !existing.signed) {
        this.db.exec("COMMIT");
        return existing;
      }
      if ((action === "SIGNED_EVIDENCE_WITHDRAWN" || action === "SIGNED_EVIDENCE_INVALID") && this.signedEvidenceStillValid(existing)) {
        throw signatureError("The signed evidence is still valid; use manual unverify to revoke.");
      }
      let next = { ...submitted, case_id: existing.case_id, case_type: existing.case_type, status: existing.status };
      if (action === "SIGNED_VERIFIED") {
        const ref = this.signatureReference(existing, submitted.signed_document_id, submitted.signed_logical_document_id);
        if (!ref) throw signatureError("Signed application evidence is missing, changed, or not a current application section.");
        next = { ...next, signed: true, signed_verified_at: now(), signed_document_id: ref.documentId,
          signed_logical_document_id: ref.logicalDocumentId, signed_evidence_document_type: ref.documentType,
          signed_evidence_start_page: ref.startPage, signed_evidence_end_page: ref.endPage };
        details = { ...details, documentId: ref.documentId, logicalDocumentId: ref.logicalDocumentId ?? null, verifiedAt: next.signed_verified_at };
      } else {
        next = clearSignature(next);
        delete next.named_insured_comparison;
        details = { ...details, documentId: existing.signed_document_id ?? null, logicalDocumentId: existing.signed_logical_document_id ?? null,
          statusChanged: existing.status === "keyed" ? "keyed->incomplete" : null };
      }
      this.upsertCase({ case: next }, "UPDATE_CASE", { trustedSignature: true });
      audit(this.db, action, { caseId, documentId: next.signed_document_id ?? existing.signed_document_id ?? null, details });
      this.db.exec("COMMIT");
      return this.getCase(caseId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  saveDocument(caseId, record, bytes, originalFilename, action = "UPLOAD_DOCUMENT", replacedDocumentId = null) {
    record = { ...record, sourceHash: createHash("sha256").update(bytes).digest("hex") };
    caseId = safeId(caseId); const id = safeId(record.id, "document id"); const extension = extname(originalFilename).toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12);
    const folder = resolve(this.paths.documents, caseId); if (!inside(this.paths.documents, folder)) throw new Error("Unsafe document directory"); mkdirSync(folder, { recursive: true });
    // Never overwrite an existing file: the stored name embeds the document id, so a
    // repeated upload of the same id would clobber the original bytes; the INSERT below
    // would then fail on the duplicate id and the rollback would delete the original
    // evidence file. Give this upload a unique name instead; the rollback below then only
    // ever removes the file this call created.
    let storedFilename = `${id}-${cleanName(record.documentType).toLowerCase()}${extension}`; let absolute = resolve(folder, storedFilename); let suffix = 2;
    while (existsSync(absolute)) { storedFilename = `${id}-${cleanName(record.documentType).toLowerCase()} (${suffix})${extension}`; absolute = resolve(folder, storedFilename); suffix += 1; }
    if (!inside(folder, absolute)) throw new Error("Unsafe document path");
    const temporary = resolve(this.paths.temp, `${randomUUID()}.upload`); writeFileSync(temporary, bytes); renameSync(temporary, absolute);
    const relativePath = relative(this.paths.base, absolute).replaceAll("\\", "/"); const stamp = now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO documents(id,case_id,original_filename,stored_filename,relative_path,mime_type,size,document_type,parse_status,validation_status,record_json,uploaded_at,updated_at,replaced_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(id, caseId, originalFilename, storedFilename, relativePath, record.mimeType || "application/octet-stream", bytes.length, record.documentType, record.state, record.validation?.validationStatus || "NOT_EVALUATED", json(record), stamp, stamp);
      if (replacedDocumentId) {
        this.db.prepare("UPDATE documents SET replaced_by=?,deleted_at=?,updated_at=? WHERE id=? AND case_id=?").run(id, stamp, stamp, safeId(replacedDocumentId), caseId);
        this.revokeInvalidSignature(caseId, "file-replaced");
      }
      this.syncLogicalDocuments(caseId, id, record, "AUTOMATIC");
      audit(this.db, action, { caseId, documentId: id, details: replacedDocumentId ? { replacedDocumentId } : {} });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      try { rmSync(absolute, { force: true }); } catch {}
      throw error;
    }
    return { ...record, originalFileName: originalFilename, currentFileName: storedFilename, logicalDocuments: this.logicalDocuments(id) };
  }
  updateDocument(id, record) {
    const existing = this.getDocument(id); if (!existing) return null;
    if (record.id && record.id !== id) throw signatureError("Document id does not match.", 400);
    const baseline = parse(existing.record_json);
    const stored = { ...record, id, sourceHash: baseline.sourceHash, logicalDocuments: record.logicalDocuments };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const logicalDocuments = this.syncLogicalDocuments(existing.case_id, id, stored, "MANUAL");
      const complete = { ...stored, logicalDocuments };
      this.db.prepare("UPDATE documents SET document_type=?,parse_status=?,validation_status=?,record_json=?,updated_at=? WHERE id=?")
        .run(complete.documentType, complete.state, complete.validation?.validationStatus || "NOT_EVALUATED", json(complete), now(), id);
      audit(this.db, "UPDATE_DOCUMENT_SECTIONS", { caseId: existing.case_id, documentId: id });
      this.revokeInvalidSignature(existing.case_id, "section-or-document-changed");
      this.db.exec("COMMIT");
      return complete;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  renameDocument(id, requestedFilename) {
    const row = this.getDocument(id); if (!row) return null; const current = resolve(this.paths.base, safeRelativePath(row.relative_path)); if (!inside(this.paths.documents, current) || !existsSync(current)) throw new Error("Saved document is unavailable");
    const extension = extname(row.stored_filename) || extname(row.original_filename); let base = safeDisplayName(requestedFilename); const requestedExtension = extname(base); if (requestedExtension) base = base.slice(0, -requestedExtension.length); base = base.replace(/[. ]+$/g, "") || "Document";
    const folder = resolve(this.paths.documents, row.case_id); let filename = `${base}${extension}`; let target = resolve(folder, filename); let suffix = 2;
    while (target !== current && existsSync(target)) { filename = `${base} (${suffix})${extension}`; target = resolve(folder, filename); suffix += 1; }
    if (!inside(folder, target)) throw new Error("Unsafe rename target"); if (target !== current) renameSync(current, target);
    const relativePath = relative(this.paths.base, target).replaceAll("\\", "/"); const record = { ...parse(row.record_json), originalFileName: row.original_filename, currentFileName: filename };
    this.db.prepare("UPDATE documents SET stored_filename=?,relative_path=?,record_json=?,updated_at=? WHERE id=?").run(filename, relativePath, json(record), now(), id);
    audit(this.db, "DOCUMENT_RENAMED", { caseId: row.case_id, documentId: id, details: { oldFilename: row.stored_filename, newFilename: filename } }); return { ...record, logicalDocuments: this.logicalDocuments(id) };
  }
  deleteDocument(id) {
    const row = this.getDocument(id); if (!row) return;
    const path = resolve(this.paths.base, safeRelativePath(row.relative_path));
    if (!inside(this.paths.documents, path)) throw new Error("Unsafe saved document path");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM documents WHERE id=?").run(id);
      audit(this.db, "DELETE_DOCUMENT", { caseId: row.case_id, documentId: id, details: { originalFilename: row.original_filename } });
      this.revokeInvalidSignature(row.case_id, "file-deleted");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (existsSync(path)) rmSync(path, { force: true });
  }
  documentPath(id) { const row = this.getDocument(id); if (!row) return null; const path = resolve(this.paths.base, safeRelativePath(row.relative_path)); return inside(this.paths.documents, path) && existsSync(path) ? { path, row } : null; }

  saveNote(caseId, type, text) { const existing = this.db.prepare("SELECT id FROM notes WHERE case_id=? AND note_type=?").get(caseId, type); const stamp = now(); if (existing) this.db.prepare("UPDATE notes SET text=?,updated_at=? WHERE id=?").run(text, stamp, existing.id); else this.db.prepare("INSERT INTO notes(id,case_id,note_type,text,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(randomUUID(), caseId, type, text, stamp, stamp); audit(this.db, "SAVE_NOTE", { caseId }); }
  getNotes(caseId) { return Object.fromEntries(this.db.prepare("SELECT note_type,text FROM notes WHERE case_id=?").all(caseId).map((row) => [row.note_type, row.text])); }
  recordAction(action, caseId, documentId = null, details = {}) { audit(this.db, action, { caseId, documentId, details }); }

  stats() { const cases = this.db.prepare("SELECT COUNT(*) count FROM cases WHERE deleted_at IS NULL").get().count; const documents = this.db.prepare("SELECT COUNT(*) count,COALESCE(SUM(size),0) bytes FROM documents WHERE deleted_at IS NULL").get(); const backupRows = this.db.prepare("SELECT details_json,created_at FROM audit_events WHERE action='EXPORT_BACKUP' ORDER BY created_at DESC LIMIT 1").get(); return { dataLocation: this.paths.base, database: this.paths.database, documentsPath: this.paths.documents, backupsPath: this.paths.backups, caseCount: cases, documentCount: documents.count, documentBytes: documents.bytes, lastBackupAt: backupRows?.created_at || null }; }
  exportBackup() {
    const stamp = now().replace(/[:.]/g, "-"); const staging = resolve(this.paths.temp, `backup-${stamp}`); mkdirSync(staging, { recursive: true }); const snapshot = join(staging, "brokerdesk.db");
    this.db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`); const documentTarget = join(staging, "documents"); if (existsSync(this.paths.documents)) copyFileTree(this.paths.documents, documentTarget);
    if (existsSync(this.paths.packages)) copyFileTree(this.paths.packages, join(staging, "packages"));
    const stats = this.stats(); writeFileSync(join(staging, "manifest.json"), json({ backupTimestamp: now(), brokerDeskVersion: "0.1.0-local", databaseFilename: "brokerdesk.db", documentCount: stats.documentCount, caseCount: stats.caseCount }), "utf8");
    const destination = join(this.paths.backups, `brokerdesk-backup-${stamp}.zip`); writeZip(staging, destination); rmSync(staging, { recursive: true, force: true }); audit(this.db, "EXPORT_BACKUP", { details: { filename: basename(destination) } }); return { path: destination, filename: basename(destination) };
  }
  cleanTemp() { let count = 0; for (const name of existsSync(this.paths.temp) ? readdirSync(this.paths.temp) : []) { const target = resolve(this.paths.temp, name); if (!inside(this.paths.temp, target)) continue; rmSync(target, { recursive: true, force: true }); count += 1; } return { removed: count }; }
}

function copyFileTree(source, destination) { mkdirSync(destination, { recursive: true }); for (const entry of readdirSync(source, { withFileTypes: true })) { const from = join(source, entry.name); const to = join(destination, entry.name); if (entry.isDirectory()) copyFileTree(from, to); else copyFileSync(from, to); } }

const crcTable = Array.from({ length: 256 }, (_, index) => { let value = index; for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1); return value >>> 0; });
function crc32(buffer) { let value = 0xFFFFFFFF; for (const byte of buffer) value = crcTable[(value ^ byte) & 0xFF] ^ (value >>> 8); return (value ^ 0xFFFFFFFF) >>> 0; }
function zipFiles(root, current = root) { return readdirSync(current, { withFileTypes: true }).flatMap((entry) => { const absolute = join(current, entry.name); return entry.isDirectory() ? zipFiles(root, absolute) : [{ absolute, name: relative(root, absolute).replaceAll("\\", "/") }]; }); }
function dosDateTime(date = new Date()) { const year = Math.max(1980, date.getFullYear()); return { time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2), date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate() }; }
function writeZip(root, destination) {
  const locals = []; const centrals = []; let offset = 0; const stamp = dosDateTime();
  for (const file of zipFiles(root)) {
    const name = Buffer.from(file.name, "utf8"); const source = readFileSync(file.absolute); const compressed = deflateRawSync(source); const crc = crc32(source);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26); locals.push(local, name, compressed);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42); centrals.push(central, name); offset += local.length + name.length + compressed.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); writeFileSync(destination, Buffer.concat([...locals, ...centrals, end]));
}

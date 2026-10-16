import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { audit } from "./database.mjs";
import { inside, safeId, safeRelativePath } from "./paths.mjs";

const now = () => new Date().toISOString();
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
      } else {
        item = clearSignature(item);
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
    if (!record.sourceHash || record.staleExtraction || cachedSourceHash(file.path) !== record.sourceHash) return null;
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
  // Must be called inside the caller's transaction, AFTER modifying a document.
  // Prevents direct API calls, section edits and file replacement from leaving a
  // completed case with a signature that no longer has valid source evidence.
  revokeInvalidSignature(caseId, reason) {
    const item = this.getCase(caseId);
    if (!item?.signed || this.signedEvidenceStillValid(item)) return false;
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
      let next = { ...submitted };
      if (action === "SIGNED_VERIFIED") {
        const ref = this.signatureReference(existing, submitted.signed_document_id, submitted.signed_logical_document_id);
        if (!ref) throw signatureError("Signed application evidence is missing, changed, or not a current application section.");
        next = { ...next, signed: true, signed_verified_at: now(), signed_document_id: ref.documentId,
          signed_logical_document_id: ref.logicalDocumentId, signed_evidence_document_type: ref.documentType,
          signed_evidence_start_page: ref.startPage, signed_evidence_end_page: ref.endPage };
        details = { ...details, documentId: ref.documentId, logicalDocumentId: ref.logicalDocumentId ?? null, verifiedAt: next.signed_verified_at };
      } else {
        next = clearSignature(next);
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

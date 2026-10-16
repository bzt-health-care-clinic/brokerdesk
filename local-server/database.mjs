import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

export function openDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, insured_name TEXT NOT NULL DEFAULT '', case_type TEXT NOT NULL DEFAULT '',
      carrier TEXT NOT NULL DEFAULT '', policy_number TEXT NOT NULL DEFAULT '', quote_number TEXT NOT NULL DEFAULT '',
      vin TEXT NOT NULL DEFAULT '', client_code TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new',
      case_json TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      original_filename TEXT NOT NULL, stored_filename TEXT NOT NULL, relative_path TEXT NOT NULL UNIQUE,
      mime_type TEXT NOT NULL, size INTEGER NOT NULL, document_type TEXT NOT NULL,
      parse_status TEXT NOT NULL, validation_status TEXT NOT NULL, record_json TEXT NOT NULL,
      uploaded_at TEXT NOT NULL, updated_at TEXT NOT NULL, replaced_by TEXT, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      note_type TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS logical_documents (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      physical_file_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL, title TEXT NOT NULL, start_page INTEGER, end_page INTEGER,
      subject_name TEXT, subject_type TEXT, presence_status TEXT NOT NULL DEFAULT 'FOUND',
      parse_status TEXT NOT NULL DEFAULT 'NOT_EVALUATED', validation_status TEXT NOT NULL DEFAULT 'NOT_EVALUATED',
      classification_source TEXT NOT NULL DEFAULT 'MANUAL', classification_confidence REAL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ocr_jobs (
      id TEXT PRIMARY KEY, case_id TEXT REFERENCES cases(id) ON DELETE CASCADE, document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
      status TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, document_id TEXT, actor TEXT NOT NULL,
      action TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_archived_updated ON cases(archived, updated_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cases_archived_created ON cases(archived, created_at DESC, id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_cases_search_insured ON cases(insured_name);
    CREATE INDEX IF NOT EXISTS idx_documents_case ON documents(case_id, uploaded_at) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_logical_documents_physical ON logical_documents(physical_file_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_events(case_id, created_at);
    PRAGMA optimize;
  `);
  if (!db.prepare("PRAGMA table_info(logical_documents)").all().some(column => column.name === "subject_id")) db.exec("ALTER TABLE logical_documents ADD COLUMN subject_id TEXT");
  if (!db.prepare("PRAGMA table_info(logical_documents)").all().some(column => column.name === "document_subtype")) {
    db.exec("ALTER TABLE logical_documents ADD COLUMN document_subtype TEXT");
    // Recover only an explicitly stored subtype; missing legacy values stay NULL.
    db.exec(`UPDATE logical_documents SET document_subtype=(
      SELECT json_extract(section.value,'$.documentSubtype')
      FROM documents d, json_each(d.record_json,'$.logicalDocuments') section
      WHERE d.id=logical_documents.physical_file_id AND json_extract(section.value,'$.id')=logical_documents.id
        AND json_type(section.value,'$.documentSubtype')='text' LIMIT 1
    ) WHERE document_subtype IS NULL`);
  }
  return db;
}

export function audit(db, action, { caseId = null, documentId = null, details = {} } = {}) {
  db.prepare("INSERT INTO audit_events(case_id,document_id,actor,action,details_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(caseId, documentId, "Local User", action, JSON.stringify(details), new Date().toISOString());
}

// One-time, idempotent backfill for legacy document rows whose record_json has no
// sourceHash integrity baseline. New uploads store sourceHash at write time
// (see saveDocument), and listDocuments must not write on read, so this migration —
// run once at server startup — is the only writer of historical baselines.
// Rationale: an in-memory-only baseline re-baselines on every restart, so a file
// modified while the app was closed would silently become the new "trusted" baseline.
// A persisted baseline makes later modifications detectable (package-analysis
// invalidates parsed data when the current hash differs from the stored baseline).
// Rows whose file is missing are skipped; they keep the in-memory fallback on read.
export function migrateSourceHashBaselines(db, baseDir) {
  const documentsDir = resolve(baseDir, "documents");
  const rows = db.prepare(
    "SELECT id, relative_path, record_json FROM documents WHERE deleted_at IS NULL AND json_extract(record_json, '$.sourceHash') IS NULL"
  ).all();
  if (!rows.length) return 0;
  let updated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const stmt = db.prepare("UPDATE documents SET record_json = ?, updated_at = ? WHERE id = ?");
    for (const row of rows) {
      const absolute = resolve(baseDir, row.relative_path);
      if (absolute !== documentsDir && !absolute.startsWith(documentsDir + sep)) continue;
      if (!existsSync(absolute)) continue;
      let record;
      try { record = JSON.parse(row.record_json); } catch { continue; }
      if (record.sourceHash) continue;
      record.sourceHash = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      stmt.run(JSON.stringify(record), new Date().toISOString(), row.id);
      updated += 1;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return updated;
}

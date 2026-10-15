import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sanitizeWindowsFilename, suggestDocumentFilename } from "../lib/document-filenames.ts";
import type { LogicalDocument, UploadedDocumentRecord } from "../lib/extraction-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const stamp = new Date().toISOString();
const logical = (id: string, physicalFileId: string, documentType: LogicalDocument["documentType"], subjectName?: string): LogicalDocument => ({ id, physicalFileId, documentType, title: documentType, subjectName, presenceStatus: "FOUND", parseStatus: "NOT_EVALUATED", validationStatus: "NOT_EVALUATED", classificationSource: "MANUAL", createdAt: stamp, updatedAt: stamp });
const record = (id: string, name: string, sections: LogicalDocument[], containerType?: string): UploadedDocumentRecord => ({ id, fileName: name, originalFileName: name, mimeType: "application/pdf", size: 3, containerType, documentType: sections[0].documentType, classification: { documentType: sections[0].documentType, confidence: 1, reason: "manual" }, state: "CLASSIFIED", logicalDocuments: sections });

assert.equal(suggestDocumentFilename(record("A", "huaz11 auto all.pdf", [logical("AQ", "A", "AUTO_QUOTE"), logical("OWN", "A", "OWNERSHIP")]), "DELTA, TEST"), "DELTA, TEST - Auto - Combined Supporting Package.pdf");
assert.equal(suggestDocumentFilename(record("B", "G4Sign_ESPLQG_2026.pdf", [logical("APP", "B", "AUTO_APPLICATION")]), "DELTA, TEST"), "DELTA, TEST - G4Broker Signed Documents.pdf");
assert.equal(suggestDocumentFilename(record("C", "ownership.pdf", [logical("OWN2", "C", "OWNERSHIP")]), "DELTA, TEST"), "DELTA, TEST - Auto - Ownership.pdf");
assert.equal(suggestDocumentFilename(record("D", "mvr.pdf", [logical("MVR", "D", "MVR", "EPSILON, TEST")]), "DELTA, TEST"), "DELTA, TEST - Auto - MVR - EPSILON, TEST.pdf");
assert.equal(sanitizeWindowsFilename(' Zhen<>:"/\\|?* . '), "Zhen---------");

const root = mkdtempSync(join(tmpdir(), "brokerdesk-rename-test-")); const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root }); let db = openDatabase(paths.database); let repo = new LocalRepositories(db, paths);
try {
  const caseItem = { case_id: "RENAME-CASE", label: "Rename", case_type: "new_auto", status: "new", insured: { name: "DELTA, TEST" }, policy: {}, vehicles: [], documents: [], field_sources: [], alerts: [] }; repo.upsertCase({ case: caseItem }, "CREATE_CASE");
  const first = record("FILE-1", "huaz11 auto all.pdf", [logical("Q", "FILE-1", "AUTO_QUOTE"), logical("O", "FILE-1", "OWNERSHIP")]); const saved = repo.saveDocument(caseItem.case_id, first, Buffer.from("one"), first.fileName); const originalPath = repo.documentPath(first.id)?.path; assert.ok(originalPath);
  const renamed = repo.renameDocument(first.id, "DELTA, TEST - Auto - Combined Supporting Package.pdf"); assert.equal(renamed.originalFileName, first.fileName); assert.equal(renamed.currentFileName, "DELTA, TEST - Auto - Combined Supporting Package.pdf"); assert.equal(existsSync(originalPath), false); const renamedPath = repo.documentPath(first.id)?.path; assert.ok(renamedPath && existsSync(renamedPath)); assert.deepEqual(renamed.logicalDocuments.map((item: LogicalDocument) => item.id), saved.logicalDocuments.map((item: LogicalDocument) => item.id));
  const edited = repo.renameDocument(first.id, "Broker Edited: Package?.pdf"); assert.equal(edited.currentFileName, "Broker Edited- Package-.pdf");
  const keepPath = repo.documentPath(first.id)?.path; assert.equal(repo.getDocument(first.id).original_filename, first.fileName); assert.equal(repo.documentPath(first.id)?.path, keepPath);
  const second = record("FILE-2", "other.pdf", [logical("O2", "FILE-2", "OWNERSHIP")]); repo.saveDocument(caseItem.case_id, second, Buffer.from("two"), second.fileName); repo.renameDocument(second.id, "Broker Edited- Package-.pdf"); assert.equal(repo.getDocument(second.id).stored_filename, "Broker Edited- Package- (2).pdf"); assert.equal(existsSync(repo.documentPath(first.id)?.path ?? ""), true);
  const image = { ...record("FILE-3", "ownership.jpg", [logical("O3", "FILE-3", "OWNERSHIP")]), mimeType: "image/jpeg" }; repo.saveDocument(caseItem.case_id, image, Buffer.from("three"), image.fileName); repo.renameDocument(image.id, "DELTA, TEST - Auto - Ownership.pdf"); assert.equal(repo.getDocument(image.id).stored_filename, "DELTA, TEST - Auto - Ownership.jpg");
  db.close(); db = openDatabase(paths.database); repo = new LocalRepositories(db, paths); assert.equal(repo.getDocument(first.id).stored_filename, "Broker Edited- Package-.pdf"); assert.equal(repo.logicalDocuments(first.id).length, 2); const auditCount = db.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='DOCUMENT_RENAMED'").get() as { count: number }; assert.equal(auditCount.count, 4);
  console.log("Document rename targeted: passed.");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }

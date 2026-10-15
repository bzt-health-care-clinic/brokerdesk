import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activeDocumentTypes, applyDocumentPresence, documentTypeIsFound } from "../lib/document-package.ts";
import type { LogicalDocument, UploadedDocumentRecord } from "../lib/extraction-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const root = mkdtempSync(join(tmpdir(), "brokerdesk-package-test-"));
const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root });
let db = openDatabase(paths.database); let repo = new LocalRepositories(db, paths);
const stamp = new Date().toISOString();
const section = (id: string, physicalFileId: string, documentType: LogicalDocument["documentType"], startPage: number, endPage = startPage, subjectName?: string): LogicalDocument => ({ id, physicalFileId, documentType, title: documentType, startPage, endPage, subjectName, presenceStatus: "FOUND", parseStatus: "NOT_EVALUATED", validationStatus: "NOT_EVALUATED", classificationSource: "MANUAL", classificationConfidence: 1, createdAt: stamp, updatedAt: stamp });

try {
  const caseItem = { case_id: "PACKAGE-CASE", label: "Package", case_type: "new_auto", status: "in_review", insured: { name: "Package Test" }, policy: {}, vehicles: [], documents: [], field_sources: [], alerts: [] };
  repo.upsertCase({ case: caseItem }, "CREATE_CASE");
  const record = { id: "PHYSICAL-PDF", fileName: "combined.pdf", mimeType: "application/pdf", size: 3, pageCount: 32, documentType: "AUTO_QUOTE", classification: { documentType: "AUTO_QUOTE", confidence: 1, reason: "manual" }, state: "CLASSIFIED", logicalDocuments: [section("QUOTE", "PHYSICAL-PDF", "AUTO_QUOTE", 1, 8), section("APP", "PHYSICAL-PDF", "AUTO_APPLICATION", 8, 14), section("DASH-1", "PHYSICAL-PDF", "DASH", 15, 20, "EPSILON, TEST"), section("DASH-2", "PHYSICAL-PDF", "DASH", 21, 26, "DELTA, TEST"), section("MVR-1", "PHYSICAL-PDF", "MVR", 27, 27, "EPSILON, TEST"), section("MVR-2", "PHYSICAL-PDF", "MVR", 28, 28, "DELTA, TEST"), section("OWN", "PHYSICAL-PDF", "OWNERSHIP", 29), section("TIRES", "PHYSICAL-PDF", "WINTER_TIRE_PROOF", 30, 32)] } as UploadedDocumentRecord;
  const saved = repo.saveDocument(caseItem.case_id, record, Buffer.from("pdf"), record.fileName);
  assert.equal(saved.logicalDocuments.length, 8);
  assert.equal(activeDocumentTypes([saved]).size, 6);
  assert.equal(saved.logicalDocuments.filter((item: LogicalDocument) => item.documentType === "MVR").length, 2);
  for (const type of ["AUTO_QUOTE", "AUTO_APPLICATION", "OWNERSHIP", "MVR", "DASH", "WINTER_TIRE_PROOF"] as const) assert.equal(documentTypeIsFound([saved], [type]), true);
  assert.equal(saved.logicalDocuments.find((item: LogicalDocument) => item.id === "OWN")?.validationStatus, "NOT_EVALUATED");
  const checklist = applyDocumentPresence({ documents: [{ category: "signed_application", received: false }, { category: "quote", received: false }, { category: "ownership", received: false }, { category: "mvr", received: false }, { category: "dash", received: false }], ownership: { received: false } }, [saved]);
  assert.equal(checklist.documents.every((item) => item.received), true); assert.equal(checklist.ownership.received, true);

  db.close(); db = openDatabase(paths.database); repo = new LocalRepositories(db, paths);
  const reopened = repo.listDocuments(caseItem.case_id)[0]; assert.equal(reopened.logicalDocuments.length, 8);
  const pathInfo = repo.documentPath(record.id); assert.ok(pathInfo); const physicalPath = pathInfo.path;
  repo.updateDocument(record.id, { ...reopened, logicalDocuments: reopened.logicalDocuments.filter((item: LogicalDocument) => item.id !== "MVR-1") });
  assert.equal(existsSync(physicalPath), true); assert.equal(repo.logicalDocuments(record.id).length, 7);

  db.prepare("DELETE FROM logical_documents WHERE physical_file_id=?").run(record.id);
  const legacyRecord = { ...reopened }; delete legacyRecord.logicalDocuments;
  db.prepare("UPDATE documents SET record_json=? WHERE id=?").run(JSON.stringify(legacyRecord), record.id);
  const migrated = repo.listDocuments(caseItem.case_id)[0]; assert.equal(migrated.logicalDocuments.length, 1); assert.equal(migrated.logicalDocuments[0].classificationSource, "MIGRATED");
  repo.deleteDocument(record.id); assert.equal(existsSync(physicalPath), false); assert.equal(repo.logicalDocuments(record.id).length, 0);

  const image = { ...record, id: "SIMPLE-IMAGE", fileName: "ownership.jpg", mimeType: "image/jpeg", pageCount: undefined, documentType: "OWNERSHIP", logicalDocuments: undefined } as UploadedDocumentRecord;
  const savedImage = repo.saveDocument(caseItem.case_id, image, Buffer.from("jpg"), image.fileName); assert.equal(documentTypeIsFound([savedImage], ["OWNERSHIP"]), true);
  console.log("Document package targeted: passed.");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }

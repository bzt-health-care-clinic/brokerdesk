import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const root = mkdtempSync(join(tmpdir(), "brokerdesk-local-test-"));
const paths = resolveDataPaths({ BROKERDESK_DATA_DIR: root });
let db = openDatabase(paths.database);
let repositories = new LocalRepositories(db, paths);

try {
  const item = { case_id: "LOCAL-CASE-1", label: "Local Test", case_type: "new_auto", status: "new", insured: { name: "Local Test Client" }, policy: { company: "Definity", policy_number: "P1", quote_number: "Q1", client_code: "C1" }, vehicles: [{ vin: "VIN123" }], field_sources: [], documents: [], alerts: [] };
  repositories.upsertCase({ case: item }, "CREATE_CASE");
  assert.equal(repositories.listCases("VIN123").length, 1);
  assert.equal(repositories.getCase(item.case_id).insured.name, "Local Test Client");

  const image = { id: "DOC-IMAGE", fileName: "ownership.jpg", mimeType: "image/jpeg", size: 3, documentType: "OWNERSHIP", classification: { documentType: "OWNERSHIP", confidence: .98, reason: "test" }, state: "PARSED", validation: { validationStatus: "COMPLETE" } };
  const pdf = { ...image, id: "DOC-PDF", fileName: "application.pdf", mimeType: "application/pdf", documentType: "AUTO_APPLICATION" };
  repositories.saveDocument(item.case_id, image, Buffer.from("jpg"), image.fileName);
  repositories.saveDocument(item.case_id, pdf, Buffer.from("pdf"), pdf.fileName);
  db.close();
  db = openDatabase(paths.database);
  repositories = new LocalRepositories(db, paths);
  const savedImage = repositories.documentPath(image.id);
  const savedPdf = repositories.documentPath(pdf.id);
  assert.ok(savedImage && existsSync(savedImage.path));
  assert.ok(savedPdf && existsSync(savedPdf.path));
  assert.equal(readFileSync(savedImage.path, "utf8"), "jpg");
  assert.equal(readFileSync(savedPdf.path, "utf8"), "pdf");
  const unchanged = repositories.listDocuments(item.case_id).find(document => document.id === pdf.id);
  assert.equal(unchanged.sourceHash, unchanged.currentSourceHash);
  writeFileSync(savedPdf.path, "changed pdf");
  const changed = repositories.listDocuments(item.case_id).find(document => document.id === pdf.id);
  assert.equal(changed.sourceHash, unchanged.sourceHash);
  assert.notEqual(changed.currentSourceHash, changed.sourceHash);
  assert.deepEqual(repositories.listDocuments(item.case_id).map((document) => document.id).sort(), [image.id, pdf.id].sort(), "both documents must reload from SQLite");
  repositories.deleteDocument(image.id);
  assert.equal(existsSync(savedImage.path), false);
  assert.ok(existsSync(savedPdf.path), "deleting one document must not remove another");

  repositories.saveNote(item.case_id, "portal", "Saved note");
  assert.equal(repositories.getNotes(item.case_id).portal, "Saved note");
  const backup = repositories.exportBackup();
  assert.ok(existsSync(backup.path));
  repositories.archiveCase(item.case_id);
  assert.equal(repositories.listCases("", true).length, 1);
  assert.ok(db.prepare("SELECT COUNT(*) count FROM audit_events").get().count >= 5);
  console.log("Local persistence targeted: passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

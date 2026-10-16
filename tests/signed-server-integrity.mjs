import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const root = mkdtempSync(join(tmpdir(), "brokerdesk-signature-integrity-"));
const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root });
const db = openDatabase(paths.database);
const repo = new LocalRepositories(db, paths);
const caseId = "SYN-SIGN-1";
const baseline = {
  case_id: caseId, label: "Synthetic signed case", case_type: "new_auto", status: "incomplete",
  signed: false, insured: { name: "Synthetic Person", co_insured: [] },
  policy: { company: "Synthetic" }, vehicles: [], drivers: [],
  documents: [], field_sources: [], alerts: [],
};
const upload = (id, sectionId) => repo.saveDocument(caseId, {
  id, fileName: id + ".pdf", mimeType: "application/pdf", documentType: "AUTO_APPLICATION",
  classification: { documentType: "AUTO_APPLICATION", confidence: 1, reason: "synthetic" },
  state: "PARSED", logicalDocuments: [{
    id: sectionId, physicalFileId: id, documentType: "AUTO_APPLICATION", title: "Signed application",
    startPage: 1, endPage: 2, presenceStatus: "FOUND", parseStatus: "PARSED",
    validationStatus: "VALID", classificationSource: "MANUAL",
  }],
}, Buffer.from("Synthetic fixture only " + id), id + ".pdf");
const get = () => repo.getCase(caseId);
const eventCount = (action) => db.prepare("SELECT count(*) as count FROM audit_events WHERE case_id=? AND action=?").get(caseId, action).count;
try {
  repo.upsertCase({ case: baseline }, "CREATE_CASE");
  // A forged ordinary case save cannot create an unverified signed record.
  repo.upsertCase({ case: { ...baseline, signed: true, signed_document_id: "FAKE", status: "incomplete" } });
  assert.equal(get().signed, false);
  assert.throws(() => repo.upsertCase({ case: { ...baseline, status: "keyed" } }), /verification is required/);
  assert.equal(get().status, "incomplete");

  // A valid upload + active section is required; id and section must belong to the case.
  assert.throws(() => repo.saveSignedCase(caseId, { ...get(), signed_document_id: "MISSING" }, "SIGNED_VERIFIED"), /evidence is missing/);
  const first = upload("SOURCE1", "SECTION1");
  let verified = repo.saveSignedCase(caseId, { ...get(), signed_document_id: first.id, signed_logical_document_id: "SECTION1" }, "SIGNED_VERIFIED");
  assert.equal(verified.signed, true);
  assert.equal(verified.signed_document_id, "SOURCE1");
  assert.equal(eventCount("SIGNED_VERIFIED"), 1);

  // Cached (mtime,size) file hashes must not authorize altered signed bytes.
  const signedPath = repo.documentPath("SOURCE1").path;
  const initialBytes = readFileSync(signedPath);
  const initialStat = statSync(signedPath);
  const changedBytes = Buffer.from(initialBytes);
  changedBytes[0] ^= 1;
  writeFileSync(signedPath, changedBytes);
  utimesSync(signedPath, initialStat.atime, initialStat.mtime);
  assert.equal(repo.signatureReference(get(), "SOURCE1", "SECTION1"), null);
  writeFileSync(signedPath, initialBytes);
  utimesSync(signedPath, initialStat.atime, initialStat.mtime);
  assert.ok(repo.signatureReference(get(), "SOURCE1", "SECTION1"));

  // An ordinary PUT cannot remove approval fields or substitute another source.
  repo.upsertCase({ case: { ...verified, signed: false, signed_document_id: "FAKE" } });
  assert.equal(get().signed, true);
  assert.equal(get().signed_document_id, "SOURCE1");

  // A missing audit insert rolls back the accompanying signature state.
  db.exec("CREATE TRIGGER fail_unverify BEFORE INSERT ON audit_events WHEN NEW.action='SIGNED_UNVERIFIED' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END");
  assert.throws(() => repo.saveSignedCase(caseId, get(), "SIGNED_UNVERIFIED"), /synthetic audit failure/);
  assert.equal(get().signed, true);
  assert.equal(eventCount("SIGNED_UNVERIFIED"), 0);
  db.exec("DROP TRIGGER fail_unverify");

  // A section reclassification revokes the approval atomically, including KEYED.
  repo.upsertCase({ case: { ...get(), status: "keyed" } });
  const record = repo.listDocuments(caseId)[0];
  repo.updateDocument("SOURCE1", {
    ...record,
    logicalDocuments: record.logicalDocuments.map(section => ({ ...section, documentType: "MVR" })),
  });
  assert.equal(get().signed, false);
  assert.equal(get().status, "incomplete");
  assert.equal(eventCount("SIGNED_EVIDENCE_WITHDRAWN"), 1);
  // UI notifications after the server auto-revoked must not duplicate events.
  const redundant = repo.saveSignedCase(caseId, { ...get(), signed: false }, "SIGNED_EVIDENCE_WITHDRAWN");
  assert.equal(redundant.signed, false);
  assert.equal(eventCount("SIGNED_EVIDENCE_WITHDRAWN"), 1);


  // A second file is signed and then removed via the document endpoint.
  const second = upload("SOURCE2", "SECTION2");
  verified = repo.saveSignedCase(caseId, { ...get(), signed_document_id: second.id, signed_logical_document_id: "SECTION2" }, "SIGNED_VERIFIED");
  assert.equal(verified.signed, true);
  repo.deleteDocument("SOURCE2");
  assert.equal(get().signed, false);
  assert.equal(eventCount("SIGNED_EVIDENCE_WITHDRAWN"), 2);

  // A signed case cannot be carried into KEYED after evidence is absent.
  assert.throws(() => repo.upsertCase({ case: { ...get(), signed: true, status: "keyed" } }), /verification is required/);
  console.log("Signed server integrity: PASS");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

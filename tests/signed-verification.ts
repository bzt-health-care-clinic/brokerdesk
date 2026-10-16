import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applySignedEvidenceWithdrawn,
  applySignedUnverified,
  applySignedVerified,
  isLegacyChecklistSignedId,
  isSignedEvidenceStillValid,
  type SignedVerifyResult,
} from "../lib/signed-verification.ts";
import { markCaseComplete } from "../lib/case-completion.ts";
import type { InsuranceCase } from "../lib/insurance-types.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const TS = "2026-10-16T12:00:00.000Z";
const root = mkdtempSync(join(tmpdir(), "brokerdesk-signed-test-"));
const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root });
const db = openDatabase(paths.database);
const repositories = new LocalRepositories(db, paths);

function blankCase(): InsuranceCase {
  return {
    case_id: "SIGNED-CASE", label: "Signed Test", case_type: "new_auto", status: "ready_to_key_in",
    signed: false,
    insured: { name: "Test Client" }, policy: { company: "Test" }, vehicles: [],
    documents: [], field_sources: [], alerts: [],
  } as unknown as InsuranceCase;
}

function mustOk(result: SignedVerifyResult): InsuranceCase {
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected signed verification to succeed");
  return result.next;
}

function uploadRecord(overrides: {
  documentType?: string;
  logicalDocuments?: Array<Record<string, unknown>>;
  withdrawnSectionRanges?: Array<{ startPage: number; endPage: number }>;
} = {}): UploadedDocumentRecord {
  return {
    id: "FILE-1",
    fileName: "application.pdf",
    documentType: overrides.documentType ?? "AUTO_APPLICATION",
    logicalDocuments: overrides.logicalDocuments ?? [
      { id: "SEC-1", physicalFileId: "FILE-1", documentType: "AUTO_APPLICATION", title: "Application", startPage: 1, endPage: 4, presenceStatus: "FOUND" },
    ],
    withdrawnSectionRanges: overrides.withdrawnSectionRanges ?? [],
  } as unknown as UploadedDocumentRecord;
}

const auditActions = (caseId: string) =>
  db.prepare("SELECT action FROM audit_events WHERE case_id=? ORDER BY id").all(caseId).map((row) => String(row.action));

try {
  // 1. verify records signed + real evidence ids + timestamp + fingerprint (pure transition)
  const verified = mustOk(applySignedVerified(
    blankCase(),
    { documentId: "FILE-1", logicalDocumentId: "SEC-1", documentType: "AUTO_APPLICATION", startPage: 1, endPage: 4 },
    TS,
  ));
  assert.equal(verified.signed, true);
  assert.equal(verified.signed_verified_at, TS);
  assert.equal(verified.signed_document_id, "FILE-1");
  assert.equal(verified.signed_logical_document_id, "SEC-1");
  assert.equal(verified.signed_evidence_document_type, "AUTO_APPLICATION");
  assert.equal(verified.signed_evidence_start_page, 1);
  assert.equal(verified.signed_evidence_end_page, 4);

  // 2. DB round-trip: save first, then audit (the order page.tsx uses)
  repositories.upsertCase({ case: verified }, "UPDATE_CASE", { trustedSignature: true });
  repositories.recordAction("SIGNED_VERIFIED", verified.case_id, null, { documentId: "FILE-1", logicalDocumentId: "SEC-1", verifiedAt: TS });
  const persisted = repositories.getCase(verified.case_id);
  assert.equal(persisted.signed, true);
  assert.equal(persisted.signed_document_id, "FILE-1");
  assert.equal(persisted.signed_logical_document_id, "SEC-1");
  assert.ok(auditActions(verified.case_id).includes("SIGNED_VERIFIED"));

  // 3. unverify on a keyed case clears signed AND drops status back to incomplete
  const keyed = markCaseComplete(persisted);
  assert.equal(keyed.status, "keyed");
  const { next: unverified, statusChanged } = applySignedUnverified(keyed);
  assert.equal(unverified.signed, false);
  assert.equal(unverified.signed_verified_at, undefined);
  assert.equal(unverified.signed_document_id, undefined);
  assert.equal(unverified.signed_logical_document_id, undefined);
  assert.equal(unverified.signed_evidence_document_type, undefined);
  assert.equal(unverified.status, "incomplete");
  assert.equal(statusChanged, "keyed->incomplete");

  // 4. unverify on a non-keyed case keeps its status
  const { next: unverified2, statusChanged: sc2 } = applySignedUnverified(verified);
  assert.equal(unverified2.signed, false);
  assert.equal(unverified2.status, "ready_to_key_in");
  assert.equal(sc2, null);

  // 5. withdrawing the verified evidence file clears signed; unrelated removals don't
  const keyedVerified = markCaseComplete(mustOk(applySignedVerified(blankCase(), { documentId: "FILE-9" }, TS)));
  const untouched = applySignedEvidenceWithdrawn(keyedVerified, ["OTHER-FILE"]);
  assert.equal(untouched.withdrawn, false);
  assert.equal(untouched.next.signed, true);
  assert.equal(untouched.next.status, "keyed");
  const withdrawn = applySignedEvidenceWithdrawn(keyedVerified, ["FILE-9"]);
  assert.equal(withdrawn.withdrawn, true);
  assert.equal(withdrawn.next.signed, false);
  assert.equal(withdrawn.next.signed_document_id, undefined);
  assert.equal(withdrawn.next.status, "incomplete");
  assert.equal(withdrawn.statusChanged, "keyed->incomplete");

  // 6. withdrawal audit is recorded with the status change
  repositories.upsertCase({ case: withdrawn.next }, "UPDATE_CASE");
  repositories.recordAction("SIGNED_EVIDENCE_WITHDRAWN", withdrawn.next.case_id, null, { documentId: "FILE-9", statusChanged: withdrawn.statusChanged });
  assert.ok(auditActions(withdrawn.next.case_id).includes("SIGNED_EVIDENCE_WITHDRAWN"));

  // 7. section re-classified after verify -> invalid (fingerprint mismatch)
  const fpCase = mustOk(applySignedVerified(
    blankCase(),
    { documentId: "FILE-1", logicalDocumentId: "SEC-1", documentType: "AUTO_APPLICATION", startPage: 1, endPage: 4 },
    TS,
  ));
  const reclassified = [uploadRecord({
    logicalDocuments: [{ id: "SEC-1", physicalFileId: "FILE-1", documentType: "MVR", title: "Application", startPage: 1, endPage: 4, presenceStatus: "FOUND" }],
  })];
  const v7 = isSignedEvidenceStillValid(reclassified, fpCase);
  assert.equal(v7.valid, false);
  assert.equal(v7.valid ? "valid" : v7.reason, "section-reclassified");

  // 8. section pages changed after re-segmentation -> invalid
  const moved = [uploadRecord({
    logicalDocuments: [{ id: "SEC-1", physicalFileId: "FILE-1", documentType: "AUTO_APPLICATION", title: "Application", startPage: 1, endPage: 6, presenceStatus: "FOUND" }],
  })];
  const v8 = isSignedEvidenceStillValid(moved, fpCase);
  assert.equal(v8.valid, false);
  assert.equal(v8.valid ? "valid" : v8.reason, "pages-changed");

  // 9. section withdrawn inside the same PDF -> invalid
  const withdrawnSec = [uploadRecord({ withdrawnSectionRanges: [{ startPage: 1, endPage: 4 }] })];
  const v9 = isSignedEvidenceStillValid(withdrawnSec, fpCase);
  assert.equal(v9.valid, false);
  assert.equal(v9.valid ? "valid" : v9.reason, "section-withdrawn");

  // 10. v5 legacy checklist id never resolves to a real file; detected as legacy
  const legacy = {
    ...blankCase(), signed: true, signed_verified_at: TS, signed_document_id: "CHECKLIST-1",
    documents: [{ id: "CHECKLIST-1" }],
  } as unknown as InsuranceCase;
  assert.equal(isLegacyChecklistSignedId(legacy), true);
  const v10 = isSignedEvidenceStillValid([uploadRecord()], legacy);
  assert.equal(v10.valid, false);
  assert.equal(v10.valid ? "valid" : v10.reason, "file-missing");
  const realFile = {
    ...blankCase(), signed: true, signed_document_id: "FILE-1",
    documents: [{ id: "CHECKLIST-1" }],
  } as unknown as InsuranceCase;
  assert.equal(isLegacyChecklistSignedId(realFile), false);

  // 11. verify without evidence is rejected, not silently recorded
  const r11a = applySignedVerified(blankCase(), undefined, TS);
  assert.equal(r11a.ok, false);
  assert.equal(r11a.ok ? "ok" : r11a.reason, "no-evidence");
  const r11b = applySignedVerified(blankCase(), {}, TS);
  assert.equal(r11b.ok, false);

  // 12. unchanged evidence stays valid (no false positive on unrelated updates)
  const v12 = isSignedEvidenceStillValid([uploadRecord()], fpCase);
  assert.equal(v12.valid, true);

  // 13. whole-file evidence: file re-classified -> invalid; untouched -> valid
  const wholeFile = mustOk(applySignedVerified(blankCase(), { documentId: "FILE-1", documentType: "AUTO_APPLICATION" }, TS));
  const v13a = isSignedEvidenceStillValid([uploadRecord({ documentType: "AUTO_APPLICATION", logicalDocuments: [] })], wholeFile);
  assert.equal(v13a.valid, true);
  const v13b = isSignedEvidenceStillValid([uploadRecord({ documentType: "MVR", logicalDocuments: [] })], wholeFile);
  assert.equal(v13b.valid, false);
  assert.equal(v13b.valid ? "valid" : v13b.reason, "file-reclassified");

  console.log("Signed verification targeted: passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

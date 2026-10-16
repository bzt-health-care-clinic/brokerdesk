import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySignedEvidenceWithdrawn, applySignedUnverified, applySignedVerified } from "../lib/signed-verification.ts";
import { markCaseComplete } from "../lib/case-completion.ts";
import type { InsuranceCase } from "../lib/insurance-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

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

const auditActions = (caseId: string) =>
  db.prepare("SELECT action FROM audit_events WHERE case_id=? ORDER BY id").all(caseId).map((row) => String(row.action));

try {
  // 1. verify records signed + real evidence ids + timestamp (pure transition)
  const verified = applySignedVerified(blankCase(), { documentId: "FILE-1", logicalDocumentId: "SEC-1" }, "2026-10-16T12:00:00.000Z");
  assert.equal(verified.signed, true);
  assert.equal(verified.signed_verified_at, "2026-10-16T12:00:00.000Z");
  assert.equal(verified.signed_document_id, "FILE-1");
  assert.equal(verified.signed_logical_document_id, "SEC-1");

  // 2. DB round-trip: save first, then audit (the order page.tsx uses)
  repositories.upsertCase({ case: verified }, "UPDATE_CASE");
  repositories.recordAction("SIGNED_VERIFIED", verified.case_id, "FILE-1", { documentId: "FILE-1", logicalDocumentId: "SEC-1", verifiedAt: "2026-10-16T12:00:00.000Z" });
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
  assert.equal(unverified.status, "incomplete");
  assert.equal(statusChanged, "keyed->incomplete");

  // 4. unverify on a non-keyed case keeps its status
  const { next: unverified2, statusChanged: sc2 } = applySignedUnverified(verified);
  assert.equal(unverified2.signed, false);
  assert.equal(unverified2.status, "ready_to_key_in");
  assert.equal(sc2, null);

  // 5. withdrawing the verified evidence file clears signed; unrelated removals don't
  const keyedVerified = markCaseComplete(applySignedVerified(blankCase(), { documentId: "FILE-9" }, "2026-10-16T12:00:00.000Z"));
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
  repositories.recordAction("SIGNED_EVIDENCE_WITHDRAWN", withdrawn.next.case_id, "FILE-9", { documentId: "FILE-9", statusChanged: withdrawn.statusChanged });
  assert.ok(auditActions(withdrawn.next.case_id).includes("SIGNED_EVIDENCE_WITHDRAWN"));

  console.log("Signed verification targeted: passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completionActionLabel, markCaseComplete, markCaseIncomplete } from "../lib/case-completion.ts";
import type { InsuranceCase } from "../lib/insurance-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";

const root = mkdtempSync(join(tmpdir(), "brokerdesk-completion-test-"));
const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root });
const db = openDatabase(paths.database);
const repositories = new LocalRepositories(db, paths);

try {
  const original = {
    case_id: "COMPLETION-CASE", label: "Completion Test", case_type: "new_auto", status: "ready_to_key_in",
    insured: { name: "Preserved Client" }, policy: { company: "Test", policy_number: "P1", quote_number: "Q1" }, vehicles: [],
    documents: [{ id: "CHECKLIST-1", name: "Application", received: true }], field_sources: [{ field: "vin", status: "resolved", resolution_note: "Preserve this" }],
    alerts: [], broker_overrides: [{ alert_code: "TEST", reason: "Preserve override" }],
  } as unknown as InsuranceCase;
  repositories.upsertCase({ case: original }, "CREATE_CASE");
  repositories.saveNote(original.case_id, "portal", "Preserved note");

  const keyed = markCaseComplete(original);
  repositories.upsertCase({ case: keyed });
  repositories.recordAction("MARK_COMPLETE", original.case_id, null, { previousStatus: original.status, newStatus: keyed.status });
  assert.equal(repositories.getCase(original.case_id).status, "keyed");
  assert.equal(completionActionLabel("keyed"), "Mark incomplete");

  const incomplete = markCaseIncomplete(repositories.getCase(original.case_id));
  repositories.upsertCase({ case: incomplete });
  repositories.recordAction("MARK_INCOMPLETE", original.case_id, null, { previousStatus: keyed.status, newStatus: incomplete.status });
  const reopened = repositories.getCase(original.case_id);
  assert.equal(reopened.status, "incomplete");
  assert.equal(completionActionLabel("incomplete"), "Mark complete");
  assert.deepEqual(reopened.documents, original.documents);
  assert.deepEqual(reopened.field_sources, original.field_sources);
  assert.deepEqual(reopened.broker_overrides, original.broker_overrides);
  assert.equal(repositories.getNotes(original.case_id).portal, "Preserved note");

  const keyedAgain = markCaseComplete(reopened);
  repositories.upsertCase({ case: keyedAgain });
  repositories.recordAction("MARK_COMPLETE", original.case_id, null, { previousStatus: reopened.status, newStatus: keyedAgain.status });
  assert.equal(repositories.getCase(original.case_id).status, "keyed");
  assert.deepEqual(db.prepare("SELECT action FROM audit_events WHERE case_id=? AND action IN ('MARK_COMPLETE','MARK_INCOMPLETE') ORDER BY id").all(original.case_id).map((row) => String(row.action)), ["MARK_COMPLETE", "MARK_INCOMPLETE", "MARK_COMPLETE"]);

  console.log("Case completion targeted: passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

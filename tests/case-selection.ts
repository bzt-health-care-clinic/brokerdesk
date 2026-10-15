import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caseEditorKind, nextCaseAfterRemoval } from "../lib/case-selection.ts";
import { createDefaultPolicyChangeState } from "../lib/policy-change.ts";
import type { InsuranceCase } from "../lib/insurance-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { createBlankCaseForType } from "../lib/new-case.ts";

const item = (id: string, type: InsuranceCase["case_type"], withChange = false) => ({ case_id: id, label: id, case_type: type, status: "new", validationStatus: "NOT_STARTED", policy: { company: "", client_code: "", quote_number: "", binder_number: null, policy_number: "", effective_date: "", expiry_date: "" }, insured: { name: "New client", co_insured: [] }, drivers: [], vehicles: [], prior_insurance: {}, claims: [], coverage: { comparison: [] }, premium: {}, payment: {}, field_sources: [], documents: [], alerts: [], ...(withChange ? { policy_change: createDefaultPolicyChangeState() } : {}) }) as unknown as InsuranceCase;
const auto = item("AUTO", "new_auto"); const legacyChange = item("CHANGE", "auto_policy_change"); const hab = item("HAB", "new_home");
assert.equal(caseEditorKind(auto), "new_auto"); assert.equal(caseEditorKind(legacyChange), "policy_change"); assert.equal(caseEditorKind(hab), "hab"); assert.equal(caseEditorKind(null), "empty"); assert.equal(auto.policy_change, undefined); assert.equal(legacyChange.policy_change, undefined);
const fallback = createDefaultPolicyChangeState("2026-09-17"); assert.deepEqual(fallback.requested_changes, []); assert.deepEqual(fallback.current_policy_state, {}); assert.deepEqual(fallback.resulting_policy_state, {}); assert.equal(legacyChange.policy_change, undefined);
assert.equal(nextCaseAfterRemoval([]), null); assert.equal(nextCaseAfterRemoval([{ id: "B" } as never, { id: "C" } as never]), "B");
const pageSource = readFileSync("app/page.tsx", "utf8");
assert.match(pageSource, /useState<NewCaseType>\("AUTO"\)/); assert.match(pageSource, /setSelectedNewCaseType\("AUTO"\)/); assert.match(pageSource, /setSelectedNewCaseType\("HAB"\)/); assert.match(pageSource, /setSelectedNewCaseType\("POLICY_CHANGE"\)/); assert.match(pageSource, /if \(creatingCaseRef\.current\) return/); assert.match(pageSource, /skipNextAutosaveRef\.current = true/); assert.doesNotMatch(pageSource, /newCase\((false|true)\)/); assert.doesNotMatch(pageSource, /newPolicyChange/);
const blankAuto = createBlankCaseForType("AUTO"); const blankHab = createBlankCaseForType("HAB"); const blankChange = createBlankCaseForType("POLICY_CHANGE"); assert.equal(blankAuto.case_type, "new_auto"); assert.equal(blankHab.case_type, "new_home"); assert.equal(blankChange.case_type, "auto_policy_change"); for (const blank of [blankAuto, blankHab, blankChange]) { assert.equal(blank.insured.name, ""); assert.equal(blank.policy.company, ""); assert.equal(JSON.stringify(blank).includes("Pembridge"), false); }

const root = mkdtempSync(join(tmpdir(), "brokerdesk-case-selection-")); const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root }); let db = openDatabase(paths.database);
try {
  let repo = new LocalRepositories(db, paths); assert.equal(repo.listCases().length, 0); db.close(); db = openDatabase(paths.database); repo = new LocalRepositories(db, paths); assert.equal(repo.listCases().length, 0);
  repo.upsertCase({ case: auto }, "CREATE_CASE"); assert.equal(repo.listCases().length, 1); repo.deleteCase(auto.case_id); assert.equal(repo.listCases().length, 0); const createdCount = db.prepare("SELECT COUNT(*) count FROM audit_events WHERE action='CREATE_CASE'").get() as { count: number }; assert.equal(createdCount.count, 1);
  repo.upsertCase({ case: legacyChange }, "POLICY_CHANGE_CREATED"); repo.upsertCase({ case: hab }, "CREATE_CASE"); repo.deleteCase(legacyChange.case_id); const remaining = repo.listCases(); assert.equal(remaining.length, 1); assert.equal(nextCaseAfterRemoval(remaining), hab.case_id); assert.equal(repo.getCase(hab.case_id)?.case_type, "new_home");
  repo.deleteCase(hab.case_id); assert.equal(repo.listCases().length, 0); const caseCount = db.prepare("SELECT COUNT(*) count FROM cases").get() as { count: number }; assert.equal(caseCount.count, 0);
  repo.upsertCase({ case: item("AUTO-EXPLICIT", "new_auto") }, "CREATE_CASE"); repo.upsertCase({ case: item("PC-EXPLICIT", "auto_policy_change", true) }, "POLICY_CHANGE_CREATED"); repo.upsertCase({ case: item("HAB-EXPLICIT", "new_home") }, "CREATE_CASE"); assert.equal(repo.listCases().length, 3);
  db.prepare("UPDATE cases SET created_at=? WHERE id=?").run("2026-01-01T00:00:00.000Z", "AUTO-EXPLICIT"); db.prepare("UPDATE cases SET created_at=? WHERE id=?").run("2026-02-01T00:00:00.000Z", "PC-EXPLICIT"); db.prepare("UPDATE cases SET created_at=? WHERE id=?").run("2026-03-01T00:00:00.000Z", "HAB-EXPLICIT");
  assert.deepEqual(repo.listCases().map((entry: { id: string }) => entry.id), ["HAB-EXPLICIT", "PC-EXPLICIT", "AUTO-EXPLICIT"]);
  const oldest = repo.getCase("AUTO-EXPLICIT")!; repo.upsertCase({ case: { ...oldest, label: "Edited oldest", insured: { ...oldest.insured, name: "Edited oldest" } } }, "UPDATE_CASE"); assert.deepEqual(repo.listCases().map((entry: { id: string }) => entry.id), ["HAB-EXPLICIT", "PC-EXPLICIT", "AUTO-EXPLICIT"]);
  assert.deepEqual(repo.listCases("Edited").map((entry: { id: string }) => entry.id), ["AUTO-EXPLICIT"]);
  repo.archiveCase("PC-EXPLICIT"); assert.deepEqual(repo.listCases().map((entry: { id: string }) => entry.id), ["HAB-EXPLICIT", "AUTO-EXPLICIT"]); assert.deepEqual(repo.listCases("", true).map((entry: { id: string }) => entry.id), ["PC-EXPLICIT"]);
  console.log("Case selection targeted: passed.");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }

import assert from "node:assert/strict";
import { phase3Cases } from "../lib/phase3-fixtures.ts";
import { determineTransactionIntent, evaluateGroupDiscount, runPhase3Rules } from "../lib/phase3-rules.ts";

const byId = (id: string) => phase3Cases.find((item) => item.case_id === id)!;
const codes = (id: string) => runPhase3Rules(byId(id)).map((item) => item.code);

assert.equal(evaluateGroupDiscount(byId("P3-1")).validation.status, "MISSING_DOCUMENTS");
assert.ok(codes("P3-1").includes("CTSAC_APPLICATION_MISSING"));
assert.ok(codes("P3-1").includes("DIPLOMA_MISSING"));

assert.equal(evaluateGroupDiscount(byId("P3-2")).validation.status, "MISSING_DOCUMENTS");
assert.ok(codes("P3-2").includes("DIPLOMA_MISSING"));

assert.equal(evaluateGroupDiscount(byId("P3-3")).validation.status, "VALIDATED");
assert.ok(codes("P3-3").includes("GROUP_DISCOUNT_VALIDATED"));

assert.equal(evaluateGroupDiscount(byId("P3-4")).validation.status, "NEEDS_REVIEW");
assert.ok(codes("P3-4").includes("DIPLOMA_NAME_MISMATCH"));

assert.ok(codes("P3-5").includes("CTSAC_APPLICATION_INCOMPLETE"));
assert.equal(evaluateGroupDiscount(byId("P3-5")).validation.status, "NEEDS_REVIEW");

assert.equal(evaluateGroupDiscount(byId("P3-6")).validation.status, "NOT_SELECTED");
assert.equal(codes("P3-6").some((code) => String(code).startsWith("CTSAC") || String(code).startsWith("DIPLOMA")), false);

assert.notEqual(byId("P3-7").policy.auto_quote_number, byId("P3-7").policy.hab_quote_number);
assert.equal(codes("P3-7").includes("QUOTE_NUMBER_LINE_OF_BUSINESS_CONFLICT"), false);

assert.equal(byId("P3-8").mortgage?.mortgagees.length, 0);
assert.equal(byId("P3-8").mortgage?.loss_payees?.length, 0);

assert.equal(codes("P3-9").includes("MVR_RECEIVED_DATE_MISSING"), false);
assert.equal(byId("P3-9").drivers[0].assigned_vehicle, "Vehicle 1");

assert.equal(byId("P3-10").insured.co_insured.length, 1);
assert.equal(byId("P3-10").ownership?.registered_owner, byId("P3-10").insured.name);

assert.equal(determineTransactionIntent("Substitute the old vehicle with the new vehicle"), "SUBSTITUTE");
assert.equal(determineTransactionIntent("Add driver Jane Doe"), "DRIVER_ADD");
assert.equal(determineTransactionIntent("Remove collision coverage"), "REMOVE_COVERAGE");

console.log("Phase 3 regression: 10/10 scenarios passed.");

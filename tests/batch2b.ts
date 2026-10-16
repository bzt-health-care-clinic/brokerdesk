import assert from "node:assert/strict";
import { createBlankHabCase } from "../lib/case-factories.ts";
import { HabApplicationParser } from "../lib/document-ingestion.ts";
import { mockCases } from "../lib/mock-cases.ts";
import { evaluateGroupDiscount } from "../lib/phase3-rules.ts";
import { reconcileDocumentsIntoCase } from "../lib/reconciliation.ts";
import { checkNamedInsured, checkOwnership, checkOwnershipCompleteness, checkVehicle, checkVin } from "../lib/rule-engine.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";

const auto = structuredClone(mockCases.find(item => item.case_id === "CASE-E")!);
const second = structuredClone(auto.vehicles[0]);
second.id = "synthetic-vehicle-two";
second.vin = "ZZZTESTB0T0000002";
second.make = "Toyota";
second.model = "Corolla";
second.ownership = { ...auto.ownership!, vin: second.vin, make: second.make, model: second.model };
auto.vehicles[0].id = "synthetic-vehicle-one";
auto.vehicles[0].ownership = structuredClone(auto.ownership!);
auto.vehicles.push(second);
auto.factConfirmations!["vehicles.1.lienholder.none"] = { confirmed: true, by: "Synthetic fixture", at: "2026-09-14" };
assert.deepEqual(checkOwnership(auto), []);
assert.deepEqual(checkVin(auto), []);
assert.deepEqual(checkVehicle(auto), []);
assert.deepEqual(checkNamedInsured(auto), []);
assert.equal(checkOwnershipCompleteness(auto).length, 0);
second.ownership.received = false;
assert.equal(checkOwnership(auto).length, 1, "one Ownership cannot satisfy two distinct VINs");
second.ownership.received = true;
second.ownership.registered_owner = "";
assert.equal(checkNamedInsured(auto).length, 1, "two blank names are not proof of owner identity");
second.ownership.registered_owner = auto.insured.name;
second.ownership.leased = null;
assert(checkOwnershipCompleteness(auto).some(item => item.message.includes("Lease status is unknown")));

const hab = createBlankHabCase();
hab.insured.name = "ALPHA, TEST";
const text = [
  "HAB Application", "Named Insured: ALPHA, TEST", "Policy Type: Home",
  "Risk Address: 100 TEST FIXTURE LANE, EXAMPLEVILLE, ON, A1A 1A1",
  "Previous Property Insurer: TEST INSURER", "Previous Property Policy Number: SYN-HAB-001",
  "Prior Effective Date: 2025-10-01", "Prior Expiry Date: 2026-10-01",
  "Property Insured Since: 2020-06-01", "Continuously Insured Since: 2014-04-01", "Occupied Since: 2020-05-20",
  "Number of Mortgages: 1", "Mortgagee: SYNTHETIC TEST LENDER", "Mortgagee Address: 200 TEST BANK ROAD",
  "Nature of Interest: First Mortgagee", "Loss Payee: SYNTHETIC TEST LENDER",
].join("\n");
const parsed = await new HabApplicationParser().parse({ text, confidence: .99 }, { fileName: "synthetic-hab" });
parsed.documentId = "synthetic-hab";
const record: UploadedDocumentRecord = { id: "synthetic-hab", fileName: "synthetic-hab.txt", mimeType: "text/plain", size: text.length, documentType: "HAB_APPLICATION", classification: { documentType: "HAB_APPLICATION", confidence: .99, reason: "synthetic" }, state: "PARSED", parsed };
const mapped = reconcileDocumentsIntoCase(hab, [record]);
assert.equal(mapped.habitational_risk?.risk_address, "100 TEST FIXTURE LANE, EXAMPLEVILLE, ON, A1A 1A1");
assert.equal(mapped.habitational_risk?.occupied_since, "2020-05-20");
assert.equal(mapped.prior_insurance.insured_since, "2020-06-01");
assert.equal(mapped.prior_insurance.continuous_insurance, "2014-04-01");
assert.equal(mapped.prior_insurance.policy_number, "SYN-HAB-001");
assert.equal(mapped.prior_insurance.effective_date, "2025-10-01");
assert.equal(mapped.mortgage?.number_of_mortgages, 1);
assert.equal(mapped.mortgage?.mortgagees[0].name, "SYNTHETIC TEST LENDER");
assert.equal(mapped.mortgage?.loss_payees?.[0].name, "SYNTHETIC TEST LENDER");
assert.equal(reconcileDocumentsIntoCase(mapped, []).mortgage?.mortgagees[0].name, "", "withdrawn mortgage evidence cannot remain active");

const group = structuredClone(auto);
group.policy.company = "Economical";
group.group_discount = { selected: false, status: "NOT_CONFIRMED" };
assert.equal(evaluateGroupDiscount(group).validation.status, "NOT_CONFIRMED");
group.group_discount.selectionConfirmed = true;
assert.equal(evaluateGroupDiscount(group).validation.status, "NOT_SELECTED");
console.log("Batch 2B targeted: per-vehicle Ownership, HAB reconciliation/withdrawal, group selection passed.");

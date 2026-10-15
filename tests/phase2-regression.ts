import assert from "node:assert/strict";
import { classifyDocument } from "../lib/document-ingestion.ts";
import { parserFixtures } from "../lib/parser-fixtures.ts";
import { getCanonicalInstitution } from "../lib/institution-directory.ts";
import { comparePersonNames, compareVins, reconcileField } from "../lib/reconciliation.ts";
import { mockCases } from "../lib/mock-cases.ts";
import { partitionClaims, runRules } from "../lib/rule-engine.ts";

const expectedPhase1: Record<string, string | null> = {
  "CASE-A": "OWNER_MISMATCH", "CASE-B": "COINSURED_REVIEW", "CASE-C": "PRIOR_POLICY_ACTIVE", "CASE-D": "CLAIM_MISSING", "CASE-E": null, "CASE-F": "PREMIUM_DISCREPANCY", "CASE-G": "ENDORSEMENT_MISSING", "CASE-H": "PROPERTY_INSURED_SINCE_CONFLICT", "CASE-I": "TELEMATICS_PHONE_MISSING", "CASE-J": "LESSOR_MISMATCH",
};
for (const testCase of mockCases) assert.equal(runRules(testCase)[0]?.code ?? null, expectedPhase1[testCase.case_id], `${testCase.case_id} Phase 1 rule regression`);

const historicalCase = mockCases.find((item) => item.case_id === "CASE-E")!;
const split = partitionClaims(historicalCase.claims, new Date("2026-09-14T00:00:00"), 6);
assert.equal(split.ratingPeriod.length, 2);
assert.equal(split.historical.length, 1);
assert.equal(split.historical[0].loss_date, "2016-09-13");

assert.equal(comparePersonNames("ZHANG, JINGJING", "Casey Example"), true);
assert.equal(comparePersonNames("CASEY EXAMPLE", "JIAKANG GAO"), false);
assert.equal(compareVins("ZZZTESTA0T0000001", "ZZZ TESTA-0T0000001"), true);
assert.equal(compareVins("ZZZTESTA0T0000001", "ZZZTESTA0I0000001"), false);

const app = parserFixtures.find((item) => item.documentType === "AUTO_APPLICATION")!;
const mvr = parserFixtures.find((item) => item.documentType === "MVR")!;
assert.equal(reconcileField<string>("gDate", [app, mvr]).value, "2006-03-10", "MVR Issue Date must not overwrite G date");
const propertySources = parserFixtures.filter((item) => item.documentType === "HAB_APPLICATION" || item.documentType === "HAB_QUOTE");
assert.equal(reconcileField<string>("propertyInsuredSince", propertySources).status, "conflict");

assert.equal(classifyDocument("vehicle ownership.jpg", "image/jpeg").documentType, "OWNERSHIP");
assert.equal(classifyDocument("unknown.pdf", "application/pdf").confidence < .8, true);

const bmoLien = getCanonicalInstitution("lienholder", "BMO")!;
const bmoMortgage = getCanonicalInstitution("mortgagee", "Bank of Montreal")!;
assert.notEqual(bmoLien.address, bmoMortgage.address, "Institution address must be role-specific");
assert.equal(getCanonicalInstitution("lienholder", "CANADIAN DEALER LEASE SERVICES INC.")?.address, "19 Synthetic Institution Avenue, Exampleville, ON A1A 1A1");
assert.equal(getCanonicalInstitution("mortgagee", "RBC")?.address, "47 Synthetic Institution Avenue, Exampleville, ON A1A 1A1");

console.log("Phase 1 + Phase 2 regression checks passed.");

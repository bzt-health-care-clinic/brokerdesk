import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createBlankAutoCase, createBlankHabCase, createBlankPolicyChangeCase } from "../lib/case-factories.ts";
import { mockCases } from "../lib/mock-cases.ts";
import { reconcileDocumentsIntoCase } from "../lib/reconciliation.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";

const auto = createBlankAutoCase(); assert.equal(auto.policy.company, ""); assert.equal(auto.insured.name, ""); assert.equal(auto.drivers.length, 0); assert.equal(auto.vehicles.length, 0); assert.deepEqual(auto.claims, []); assert.deepEqual(auto.coverage.endorsements, []); assert.deepEqual(auto.coverage.comparison, []); assert.equal(auto.payment.plan, ""); assert.equal(auto.premium.quoted_annual, null); assert.equal(JSON.stringify(auto).includes("Pembridge"), false); assert.equal(JSON.stringify(auto).includes("synthetic.user@example.com"), false); assert.equal(JSON.stringify(auto).includes("Speeding"), false);
const policyChange = createBlankPolicyChangeCase(); assert.equal(policyChange.policy.company, ""); assert.equal(policyChange.drivers.length, 0); assert.equal(policyChange.policy_change?.requested_action, "");
const hab = createBlankHabCase(); assert.equal(hab.policy.company, ""); assert.equal(hab.insured.name, ""); assert.equal(hab.habitational_risk?.risk_address, ""); assert.equal(hab.prior_insurance.insurer, "");
assert.ok(mockCases.some((item) => item.policy.company === "Pembridge"));
const ownership = { id: "ownership", fileName: "ownership.txt", mimeType: "text/plain", size: 1, documentType: "OWNERSHIP", classification: { documentType: "OWNERSHIP", confidence: 1, reason: "fixture" }, state: "PARSED", parsed: { documentId: "ownership", documentType: "OWNERSHIP", parsedAt: "now", confidence: 1, data: { registeredOwner: "DELTA, TEST", vin: "ZZZTESTA0T0000001" }, warnings: [], fieldEvidence: {} } } as UploadedDocumentRecord;
const reconciled = reconcileDocumentsIntoCase(auto, [ownership]); assert.equal(reconciled.policy.company, ""); assert.equal(reconciled.drivers.length, 0); assert.equal(JSON.stringify(reconciled).includes("telematics"), false); assert.equal(JSON.stringify(reconciled).includes("convictions"), false);
const ingestion = readFileSync("components/ingestion-panel.tsx", "utf8"); assert.equal(ingestion.includes("This document will be sent to the configured cloud OCR provider"), false); assert.match(ingestion, /Image\/scanned PDF — run OCR or enter manually/); assert.match(ingestion, /OCR provider not configured — manual entry available/);
const css = readFileSync("app/globals.css", "utf8"); assert.match(css, /\.app-shell \{ height:100dvh; min-height:0; display:flex/); assert.match(css, /\.workspace-grid \{ flex:1; min-height:0; overflow:hidden/); assert.match(css, /\.panel \{ min-width:0; min-height:0; overflow-x:hidden; overflow-y:auto/); assert.match(css, /@media \(max-width:1250px\)[\s\S]*body \{ overflow:auto; \}/); assert.equal(css.includes("min-height:700px"), false); assert.match(css, /grid-template-columns:var\(--documents-panel-width,400px\)/);
const page = readFileSync("app/page.tsx", "utf8"); assert.match(page, /centerPanelRef\.current\?\.scrollTo\(\{ top: 0 \}\)/);
console.log("UX cleanup targeted: passed.");

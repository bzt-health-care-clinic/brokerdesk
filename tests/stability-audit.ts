import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXTRACTION_PIPELINE_VERSION, invalidateStaleExtraction, OwnershipParser, PARSER_VERSION } from "../lib/document-ingestion.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";
import { createBlankAutoCase } from "../lib/case-factories.ts";
import { removeDocumentFromCase } from "../lib/reconciliation.ts";

const fixture = readFileSync(new URL("./fixtures/ontario-ownership-ocr.txt", import.meta.url), "utf8");
const parsed = await new OwnershipParser().parse({ text: fixture, confidence: .97, metadata: { fileId: "ownership" } });
assert.deepEqual(parsed.data, {
  registeredOwner: "DELTA, TEST",
  ownerAddress: "300 TEST FIXTURE ROAD, EXAMPLEVILLE ON A1A 1A1",
  vin: "ZZZTESTA0T0000001",
  year: "2023",
  make: "TESLA",
  model: "MODEL 3",
  plate: "CVAB123",
  bodyType: "4D",
});

const base = { id: "ownership", fileName: "ownership.jpg", mimeType: "image/jpeg", size: 1, documentType: "OWNERSHIP", classification: { documentType: "OWNERSHIP", confidence: .98, reason: "fixture" }, state: "PARSED", raw: { text: fixture }, parsed } as UploadedDocumentRecord;
const staleExtraction = invalidateStaleExtraction(base);
assert.equal(staleExtraction.state, "NEEDS_REVIEW");
assert.equal(staleExtraction.staleExtraction, true);
assert.equal(staleExtraction.raw, undefined);
assert.equal(staleExtraction.parsed, undefined);
assert.match(staleExtraction.error ?? "", /older pipeline/i);

const staleParser = invalidateStaleExtraction({ ...base, extractionVersion: EXTRACTION_PIPELINE_VERSION });
assert.equal(staleParser.raw?.text, fixture);
assert.equal(staleParser.parsed, undefined);
assert.match(staleParser.error ?? "", /older parser/i);

const current = invalidateStaleExtraction({ ...base, extractionVersion: EXTRACTION_PIPELINE_VERSION, parserVersion: PARSER_VERSION });
assert.equal(current.parsed?.data.vin, "ZZZTESTA0T0000001");

const caseItem = createBlankAutoCase();
caseItem.policy.company = "Stale Insurer";
caseItem.ownership!.vin = "ZZZTESTA0T0000001";
caseItem.field_sources = [
  { field: "insurer", values: [{ source: "ownership", value: "Stale Insurer", documentId: "ownership" }], resolved_value: "Stale Insurer", status: "matched" },
  { field: "vin", values: [{ source: "ownership", value: "ZZZTESTA0T0000001", documentId: "ownership" }], resolved_value: "ZZZTESTA0T0000001", status: "matched" },
];
const cleaned = removeDocumentFromCase(caseItem, "ownership", []);
assert.equal(cleaned.policy.company, "");
assert.equal(cleaned.ownership?.vin, "");
assert.equal(cleaned.field_sources.length, 0);
console.log("Final stability audit targeted: passed.");

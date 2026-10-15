import assert from "node:assert/strict";
import { PARSER_VERSION, reprocessDocument, applyManualCorrection } from "../lib/document-ingestion.ts";
import { refreshParserVersion, reparseDocument } from "../lib/local-reparse.ts";
import { analyzePdfPackage } from "../lib/package-analysis.ts";
import { HttpDocumentRepository, HttpBootstrapRepository } from "../lib/local-repositories.ts";
import { reconcileDocumentsIntoCase } from "../lib/reconciliation.ts";
import { createBlankAutoCase } from "../lib/case-factories.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";

const text = "NAME / NOM\nPlease print clearly\nADDRESS / ADRESSE\nchange, detach here\nPLATE / PLAQUE\nPAS - FIT\nVIN: ZZZTESTA0T0000001";
const record: UploadedDocumentRecord = { id: "old", fileName: "ownership.jpg", mimeType: "image/jpeg", size: 4, documentType: "OWNERSHIP", classification: { documentType: "OWNERSHIP", confidence: 1, reason: "Manually classified by broker." }, state: "PARSED", extractionVersion: 2, parserVersion: 2, sourceHash: "same", currentSourceHash: "same", raw: { text, confidence: .99 }, parsed: { documentId: "old", documentType: "OWNERSHIP", parsedAt: "old", confidence: .99, data: { registeredOwner: "Please print clearly", ownerAddress: "change, detach here", plate: "PAS - FIT" }, warnings: [], fieldEvidence: {} } };
let extractorCalls = 0;
const extractor = { async extract() { extractorCalls++; throw new Error("Must not call OCR"); } };
const refreshed = await refreshParserVersion(record);
assert.equal(refreshed.parserVersion, PARSER_VERSION);
assert.equal(refreshed.extractionVersion, 2);
assert.deepEqual(refreshed.raw, record.raw);
assert.deepEqual(refreshed.classification, record.classification);
for (const key of ["registeredOwner", "ownerAddress", "plate"]) assert.equal(refreshed.parsed?.data[key], undefined);
assert.equal(refreshed.parsed?.data.vin, "ZZZTESTA0T0000001");
assert.equal((await reprocessDocument(record, extractor)).parserVersion, PARSER_VERSION);
assert.equal(extractorCalls, 0);
assert.equal(await refreshParserVersion(refreshed), refreshed);
for (const unusable of [{ ...record, raw: undefined }, { ...record, raw: { text, metadata: { status: "FAILED" } } }, { ...record, currentSourceHash: "changed" }]) {
  const result = await refreshParserVersion(unusable); assert.equal(result.state, "NEEDS_REVIEW"); assert.equal(result.staleExtraction, true); assert.match(result.error!, /Re-extraction required/); assert.equal(result.parserVersion, 2);
}
const corrected = applyManualCorrection(record, "registeredOwner", "BROKER CONFIRMED", "Broker");
const reparsedCorrection = await reparseDocument(corrected);
assert.equal(reparsedCorrection.parsed?.data.registeredOwner, "BROKER CONFIRMED");
assert.deepEqual(reparsedCorrection.parsed?.corrections, corrected.parsed?.corrections);
const oldCase = reconcileDocumentsIntoCase(createBlankAutoCase(), [record]);
const updatedCase = reconcileDocumentsIntoCase(oldCase, [refreshed]);
assert.equal(updatedCase.ownership?.registered_owner, ""); assert.equal(updatedCase.ownership?.address, ""); assert.equal(updatedCase.ownership?.plate, "");
const manualCase = structuredClone(oldCase); const field = manualCase.field_sources.find(f => f.canonicalField === "registeredOwner")!;
field.status = "resolved"; field.resolved_by_user = "Broker"; field.resolved_value = "CONFIRMED"; manualCase.ownership!.registered_owner = "CONFIRMED";
assert.equal(reconcileDocumentsIntoCase(manualCase, [refreshed]).ownership?.registered_owner, "CONFIRMED");

const pdf: UploadedDocumentRecord = { ...record, fileName: "ownership.pdf", mimeType: "application/pdf", parsed: undefined, packagePages: [{ page: 1, text, extractionStatus: "COMPLETE", extractionProvider: "ocr_space", classification: record.classification, sourceHash: "page-hash" }], logicalDocuments: [{ id: "section", physicalFileId: "old", documentType: "OWNERSHIP", title: "Ownership", startPage: 1, endPage: 1, presenceStatus: "FOUND", parseStatus: "PARSED", validationStatus: "NOT_EVALUATED", classificationSource: "MANUAL", createdAt: "old", updatedAt: "old" }] };
const rePdf = await refreshParserVersion(pdf);
assert.equal(rePdf.parsedSources?.[0].data.vin, "ZZZTESTA0T0000001"); assert.equal(rePdf.parsedSources?.[0].data.plate, undefined); assert.deepEqual(rePdf.packagePages, pdf.packagePages); assert.deepEqual(rePdf.logicalDocuments, pdf.logicalDocuments);
let ocrCalls = 0;
const physical = new File(["same"], "ownership.pdf", { type: "application/pdf" });
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await physical.arrayBuffer())), b => b.toString(16).padStart(2,"0")).join("");
const adapter = { async open() { return { pageCount: 1, async embeddedText() { return ""; }, async renderPage() { return new File(["scan"], "page.jpg"); }, close() {} }; } };
const ocr = { async extract() { ocrCalls++; return { text }; } };
await analyzePdfPackage({ ...pdf, sourceHash: hash }, physical, adapter, ocr, { maxOcrBytes: 1000 }); assert.equal(ocrCalls, 0);
await analyzePdfPackage({ ...pdf, sourceHash: "changed" }, physical, adapter, ocr, { maxOcrBytes: 1000 }); assert.equal(ocrCalls, 1);

// Reload and case-switch integration: only document reads and persistence, never OCR/file APIs.
const originalFetch = globalThis.fetch; let stored = structuredClone(record); let saves = 0;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (init?.method === "PUT") { saves++; stored = JSON.parse(String(init.body)).record; return Response.json(stored); }
  if (url.includes("/bootstrap")) return Response.json({ cases: [], selected: null, documents: [stored], notes: {} });
  assert.ok(url.endsWith("/cases/test/documents"), `Unexpected network call: ${url}`); return Response.json([stored]);
};
try { await new HttpDocumentRepository().list("test"); assert.equal(saves, 1); await new HttpBootstrapRepository().load(); await new HttpDocumentRepository().list("test"); assert.equal(saves, 1); } finally { globalThis.fetch = originalFetch; }
console.log("Local reparse targeted: passed (version refresh, cached PDF, hashes, corrections, reconciliation, reload quota).");

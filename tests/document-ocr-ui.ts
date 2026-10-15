import assert from "node:assert/strict";
import { documentOcrUi } from "../lib/document-ocr-ui.ts";
import type { UploadedDocumentRecord } from "../lib/extraction-types.ts";

const image: UploadedDocumentRecord = { id: "ui", fileName: "ownership.jpg", mimeType: "image/jpeg", size: 10, documentType: "OWNERSHIP", classification: { documentType: "OWNERSHIP", confidence: 1, reason: "test" }, state: "PARSED", raw: { text: "Saved source text", metadata: { provider: "ocr_space", parsedFieldCount: 99 } }, parsed: { documentId: "ui", documentType: "OWNERSHIP", parsedAt: "now", confidence: 1, data: { plate: "ABC123" }, warnings: [], fieldEvidence: {} } };
const page = { page: 1, text: "Saved PDF OCR", extractionStatus: "COMPLETE" as const, extractionProvider: "ocr_space" as const, classification: image.classification, sourceHash: "hash" };
const pdf: UploadedDocumentRecord = { ...image, mimeType: "application/pdf", fileName: "ownership.pdf", raw: { metadata: { provider: "page_package_pipeline", parsedFieldCount: 99 } }, parsed: undefined, parsedSources: [image.parsed!], packagePages: [page], pageCount: 1 };
const complete = documentOcrUi(pdf, "ONLINE");
assert.equal(complete.canReparse, true); assert.equal(complete.showOcr, false); assert.equal(complete.canOcr, false); assert.equal(complete.canRegenerate, true);
assert.match(complete.summary, /Reparse available.*OCR Complete/); assert.doesNotMatch(complete.summary, /Awaiting/); assert.equal(complete.fieldCount, 1);
const partial = documentOcrUi({ ...pdf, pageCount: 2, packagePages: [page, { ...page, page: 2, text: "", extractionStatus: "FAILED" }] }, "ONLINE");
assert.match(partial.summary, /^Partial PDF/); assert.equal(partial.canOcr, true); assert.equal(partial.canReparse, true);
const failed = documentOcrUi({ ...image, state: "FAILED", raw: { metadata: { provider: "ocr_space", status: "FAILED" } } }, "ONLINE");
assert.match(failed.summary, /^OCR failed/); assert.doesNotMatch(failed.summary, /OCR Complete/); assert.equal(failed.canReparse, false);
for (const state of ["OFFLINE", "NOT_CONFIGURED"]) {
  const unavailable = documentOcrUi({ ...image, raw: undefined, parsed: undefined, state: "UPLOADED" }, state);
  assert.match(unavailable.summary, /OCR provider/); assert.equal(unavailable.canOcr, false); assert.equal(unavailable.canRegenerate, false);
  assert.equal(documentOcrUi(image, state).canReparse, true);
}
const changed = documentOcrUi({ ...image, sourceHash: "old", currentSourceHash: "new", staleExtraction: true, error: "Re-extraction required" }, "ONLINE");
assert.match(changed.summary, /^Re-extraction required/); assert.equal(changed.canReparse, false); assert.equal(changed.canOcr, true); assert.doesNotMatch(changed.summary, /OCR Complete/);
const saved = documentOcrUi(image, "ONLINE"); assert.equal(saved.ocrLabel, "OCR document"); assert.equal(saved.showOcr, false); assert.equal(saved.fieldCount, 1); assert.match(saved.summary, /1 structured fields/);
assert.equal(complete.ocrLabel, "OCR missing/failed pages"); assert.equal(saved.reparseLabel, "Reparse saved text (local)"); assert.equal(saved.regenerateLabel, "Regenerate OCR (uses quota)");
const txt = documentOcrUi({ ...image, fileName: "source.txt", mimeType: "text/plain" }, "ONLINE"); assert.equal(txt.showOcr, false); assert.equal(txt.showRegenerate, false); assert.equal(txt.canReparse, true);
const processing = documentOcrUi(pdf, "ONLINE", true); assert.equal(processing.canReparse, false); assert.equal(processing.canOcr, false); assert.equal(processing.canRegenerate, false);
const empty = documentOcrUi({ ...image, raw: { metadata: { provider: "ocr_space" } }, parsed: undefined, state: "UPLOADED" }, "ONLINE"); assert.match(empty.summary, /^Awaiting extraction/);
assert.match(documentOcrUi({ ...image, parsed: { ...image.parsed!, data: {} } }, "ONLINE").summary, /No structured fields extracted/);
console.log("OCR UI states: passed.");

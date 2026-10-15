import assert from "node:assert/strict";
import { applyManualCorrection, BrowserFileStore, OwnershipParser } from "../lib/document-ingestion.ts";
import { EmbeddedPdfTextProvider, HttpPaddleOcrTransport, OptionalAzureDocumentProvider, PaddleOcrProvider, RoutingDocumentExtractor } from "../lib/ocr-providers.ts";
import { reconcileField } from "../lib/reconciliation.ts";

function file(name: string, type: string) { return new File(["fixture"], name, { type }); }
const store = new BrowserFileStore();

async function register(name: string, type: string) {
  const id = crypto.randomUUID(); store.register(id, file(name, type)); return { fileId: id, fileName: name, mimeType: type };
}

const embedded = new EmbeddedPdfTextProvider(store, { async extract() { return { pages: [{ page: 1, pageNumber: 1, text: "Insurance Company: Definity\nNamed Insured: Avery Example\nQuote: A123456789\nEffective Date: 2026-10-01", confidence: .99 }] }; } });
const paddle = new PaddleOcrProvider(store, { async extract(input) {
  const chinese = /ctsac|diploma/i.test(input.name);
  return { text: chinese ? "English Name: Avery Example\n中文姓名: 示例用户\nUniversity: Peking University" : "Registered Owner: Avery Example\nVIN: ZZZTESTA0T0000001", confidence: .96, pages: [{ page: 1, pageNumber: 1, text: chinese ? "English Name: Avery Example\n中文姓名: 示例用户\nUniversity: Peking University" : "Registered Owner: Avery Example\nVIN: ZZZTESTA0T0000001", confidence: .96, rotation: /rotated/i.test(input.name) ? 90 : 0, blocks: [{ text: chinese ? "Avery Example" : "ZZZTESTA0T0000001", confidence: .96, boundingBox: { x: 10, y: 20, width: 100, height: 18 } }] }] };
} });

async function main() {
const searchable = await new RoutingDocumentExtractor([embedded, paddle]).extract(await register("searchable.pdf", "application/pdf"));
assert.equal(searchable.metadata?.provider, "embedded_pdf_text");

const insufficient = new EmbeddedPdfTextProvider(store, { async extract() { return { pages: [{ page: 1, text: "scan" }] }; } });
const scanned = await new RoutingDocumentExtractor([insufficient, paddle]).extract(await register("scanned.pdf", "application/pdf"));
assert.equal(scanned.metadata?.provider, "paddle_ocr");

const ownership = await paddle.extract(await register("ownership.jpg", "image/jpeg"));
assert.equal(ownership.pages?.[0].blocks?.[0].boundingBox?.x, 10);

const rotated = await paddle.extract(await register("rotated-ownership.jpg", "image/jpeg"));
assert.equal(rotated.pages?.[0].rotation, 90);

const ctsac = await paddle.extract(await register("ctsac.png", "image/png"));
assert.match(ctsac.text ?? "", /示例用户/);

const diploma = await paddle.extract(await register("chinese-diploma.png", "image/png"));
assert.match(diploma.text ?? "", /Peking University/);

const lowConfidenceOwnership = { ...ownership, confidence: .82, pages: ownership.pages?.map((page) => ({ ...page, confidence: .82, blocks: page.blocks?.map((block) => ({ ...block, confidence: .82 })) })), metadata: { fileId: "ownership" } };
const parsed = await new OwnershipParser().parse(lowConfidenceOwnership);
assert.ok(parsed.warnings.some((warning) => warning.code === "VIN_REVIEW_REQUIRED"));
const record = { id: "ownership", fileName: "ownership.jpg", mimeType: "image/jpeg", size: 1, documentType: "OWNERSHIP" as const, classification: { documentType: "OWNERSHIP" as const, confidence: .98, reason: "fixture" }, state: "NEEDS_REVIEW" as const, raw: ownership, parsed };
const corrected = applyManualCorrection(record, "vin", "ZZZTESTA0T0000001", "Test Broker");
assert.equal(corrected.parsed?.corrections?.vin.originalExtractedValue, "ZZZTESTA0T0000001");
assert.equal(corrected.parsed?.corrections?.vin.correctedBy, "Test Broker");
assert.equal(reconcileField<string>("vin", [corrected.parsed!]).value, "ZZZTESTA0T0000001");
assert.equal(new OptionalAzureDocumentProvider().status, "NOT_CONFIGURED");

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.endsWith("/health")) return Response.json({ state: "ONLINE", provider: "paddleocr", modelLoaded: true, device: "cpu" });
  return Response.json(ownership);
};
const http = new HttpPaddleOcrTransport("http://brokerdesk.test/api/ocr");
assert.equal((await http.health()).state, "ONLINE");
assert.equal((await http.extract(file("ownership.jpg", "image/jpeg"))).metadata?.provider, "paddle_ocr");
globalThis.fetch = originalFetch;

console.log("OCR targeted: 6/6 fixtures passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

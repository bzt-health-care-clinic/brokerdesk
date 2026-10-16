import assert from "node:assert/strict";
import { createBlankAutoCase, createBlankHabCase } from "../lib/case-factories.ts";
import { classifyDocument } from "../lib/document-ingestion.ts";
import { embeddedTextNeedsOcr, analyzePdfPackage, type PdfPageAdapter } from "../lib/package-analysis.ts";
import { reviewUploadedDocuments } from "../lib/document-underwriting.ts";
import { estimateBrokerFee } from "../lib/monthly-payment.ts";
import type { DocumentType, UploadedDocumentRecord } from "../lib/extraction-types.ts";

const currency = (v: number) => Number(v.toFixed(2));
const homeMonthly = estimateBrokerFee(1375, "HAB", "monthly")!;
assert.deepEqual(homeMonthly, {
  annualPremium: 1375, tax: 110, financingFee: 41.25, total: 1526.25,
  monthly: 127.19, installments: 12, rateSource: "BROKER_WORKSHEET_REFERENCE",
});
const homeAnnual = estimateBrokerFee(1375, "HAB", "annual")!;
assert.equal(homeAnnual.total, 1485); assert.equal(homeAnnual.financingFee, 0); assert.equal(homeAnnual.monthly, null);
const autoMonthly = estimateBrokerFee(3399, "AUTO", "monthly")!;
assert.equal(autoMonthly.tax, 0); assert.equal(autoMonthly.financingFee, 44.19);
assert.equal(autoMonthly.total, 3443.19); assert.equal(autoMonthly.monthly, 286.93);
assert.equal(estimateBrokerFee(-1, "AUTO", "monthly"), null);
assert.equal(estimateBrokerFee(Number.NaN, "HAB", "monthly"), null);

assert.equal(classifyDocument("Auto Quote_Information.pdf", "application/pdf", "Driver Training: No\nLeased: No\nNumber of Mortgages: 1").documentType, "AUTO_QUOTE");
assert.equal(classifyDocument("Home-uw-Quote_Information.pdf", "application/pdf", "Driver Training: No").documentType, "HAB_QUOTE");
assert.equal(classifyDocument("Signed home app full.pdf", "application/pdf").documentType, "HAB_APPLICATION");
assert.equal(classifyDocument("G4Sign_TEST.pdf", "application/pdf", "HABITATIONAL INSURANCE\nApplication").documentType, "HAB_APPLICATION");
assert.equal(classifyDocument("G4Sign_TEST.pdf", "application/pdf", "AUTOMOBILE INSURANCE\nApplication").documentType, "AUTO_APPLICATION");
assert.equal(classifyDocument("G4Sign_TEST.pdf", "application/pdf", "Personal data").documentType, "OTHER");
assert.equal(classifyDocument("owern ship.jpg", "image/jpeg").documentType, "OWNERSHIP");
assert.equal(classifyDocument("winter tire.jpg", "image/jpeg").documentType, "WINTER_TIRE_PROOF");
assert.notEqual(classifyDocument("unknown.pdf", "application/pdf", "Driver Training: No\nLeased: No\nNumber of Mortgages: 1").documentType, "DRIVER_TRAINING_CERTIFICATE");
assert.notEqual(classifyDocument("unknown.pdf", "application/pdf", "Driver Training: No\nLeased: No\nNumber of Mortgages: 1").documentType, "LEASE_DOCUMENT");

const record = (id: string, type: DocumentType, text: string): UploadedDocumentRecord => ({
  id, fileName: `${id}.pdf`, mimeType: "application/pdf", size: 5000,
  documentType: type, classification: { documentType: type, confidence: .99, reason: "fixture" },
  state: "PARSED", sourceHash: `sha-${id}`,
  packagePages: [{ page: 1, text, extractionProvider: "embedded_pdf_text",
    extractionStatus: "COMPLETE", sourceHash: `pagehash-${id}`,
    classification: { documentType: type, confidence: .99, reason: "fixture" } }],
});
const caseItem = createBlankAutoCase();
const quote = record("QUOTE_SYNTHETIC", "AUTO_QUOTE",
  "Insurance quoted. Cancelled due to Defaulting Policy Payment.\nPrior insurance history does not support licensed date.\nMulti-line discount is provided.");
const dash = record("DASH_SYNTHETIC", "DASH",
  "Driver report\nPolicy Cancelled - non-payment.");
let result = reviewUploadedDocuments(caseItem, [quote, dash]);
assert.equal(result.alerts.filter(a => a.code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW").length, 1);
const cancellation = result.alerts.find(a => a.code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW")!;
assert.equal(cancellation.severity, "high");
assert.equal(cancellation.resolved, false);
assert.match(cancellation.message, /Quote \+ DASH|DASH \+ Auto Quote/);
assert(result.alerts.some(a => a.code === "LICENCE_HISTORY_UW_REVIEW"));
assert(result.alerts.some(a => a.code === "MULTILINE_DISCOUNT_SUPPORT_REVIEW"));

caseItem.broker_overrides = [{ alert_code: "PRIOR_NONPAYMENT_CANCELLATION_REVIEW",
  evidence_fingerprint: result.fingerprints.PRIOR_NONPAYMENT_CANCELLATION_REVIEW,
  reason: "Confirmed insurer disclosure and UW response using original documents.",
  confirmed_by: "Synthetic Tester", confirmed_at: "2026-01-01T00:00:00.000Z" }];
result = reviewUploadedDocuments(caseItem, [quote, dash]);
assert.equal(result.alerts.find(a => a.code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW")?.resolved, true);
result = reviewUploadedDocuments(caseItem, [{ ...quote, sourceHash: "updated-content-hash" }, dash]);
assert.equal(result.alerts.find(a => a.code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW")?.resolved, false);
assert.equal(reviewUploadedDocuments(caseItem, [record("DASH_OK", "DASH", "Cancelled - insured's request")])
  .alerts.some(a => a.code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW"), false);

const hab = createBlankHabCase();
hab.payment.plan = "Monthly"; hab.payment.annual_premium = 1375; hab.payment.total_cost = 1526.25;
assert.equal(reviewUploadedDocuments(hab, []).alerts.some(a => a.code === "MONTHLY_PAYMENT_FEE_REVIEW"), false);
hab.payment.total_cost = 1485;
assert.equal(reviewUploadedDocuments(hab, []).alerts.some(a => a.code === "MONTHLY_PAYMENT_FEE_REVIEW"), true);
const signPacket = record("SIGN_PACKET_SYNTHETIC", "HAB_APPLICATION",
  "APPLICANT'S SIGNATURE 2026/10/06\nSigned At: 09-30-2026 07:18 PM");
assert.equal(reviewUploadedDocuments(hab, [signPacket]).alerts.some(a => a.code === "SIGNATURE_DATE_REVIEW"), true);
assert.equal(reviewUploadedDocuments(hab, [record("SIGNED_SAME_DAY", "HAB_APPLICATION",
  "APPLICANT'S SIGNATURE 2026/10/06\nSigned At: 10-06-2026 07:18 PM")]).alerts.some(a => a.code === "SIGNATURE_DATE_REVIEW"), false);

// A selectable but corrupt embedded text layer must NOT bypass page OCR.
const garbled = "\u0081\u0088\u0080\u0089Æ¯".repeat(25);
assert.equal(embeddedTextNeedsOcr(garbled), true);
assert.equal(embeddedTextNeedsOcr("Readable insurance application description ".repeat(4)), false);
const pdfFile = new File([new Uint8Array(32)], "G4Sign_SYNTHETIC.pdf", { type: "application/pdf" });
const cover = "HABITATIONAL INSURANCE APPLICATION Page 1 of 2\n" + "Readable structured data. ".repeat(4);
let ocrCallCount = 0;
const adapter: PdfPageAdapter = { async open() { return {
  pageCount: 2, async embeddedText(p) { return p === 1 ? cover : garbled; },
  async renderPage(p) { return new File([new Uint8Array([p])], `page-${p}.jpg`, { type: "image/jpeg" }); },
  async close() {},
}; } };
const updated = await analyzePdfPackage({
  id: "G4_SYNTHETIC", fileName: pdfFile.name, mimeType: pdfFile.type, size: pdfFile.size,
  documentType: "OTHER", classification: { documentType: "OTHER", confidence: .3, reason: "fixture" },
  state: "UPLOADED", logicalDocuments: [],
}, pdfFile, adapter, { async extract() {
  ocrCallCount++; return { text: "HABITATIONAL INSURANCE APPLICATION Page 2 of 2\nSigned application", confidence: .9, metadata: { provider: "ocr_space" } };
} }, { maxOcrBytes: 1024 });
assert.equal(ocrCallCount, 1);
assert.equal(updated.packageProgress?.ocr, 1);
assert.equal(updated.documentType, "HAB_APPLICATION");
assert.equal(updated.packagePages?.filter(p => p.classification.documentType === "HAB_APPLICATION").length, 2);
assert.equal(currency(updated.packageProgress!.processed), 2);
console.log("Real-document-derived synthetic regression: passed.");

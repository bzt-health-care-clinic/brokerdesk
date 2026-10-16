import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfTextLines } from "../lib/pdf-text-lines.ts";
import { classifyDocument, normalizeOcrText, parserFor } from "../lib/document-ingestion.ts";
import { discoverLogicalSections } from "../lib/package-analysis.ts";
import { claimRows, normalizedClaim } from "../lib/claim-records.ts";
import { confirmedDriverFromProposal, proposedDrivers } from "../lib/proposed-drivers.ts";
import type { PackagePage, UploadedDocumentRecord } from "../lib/extraction-types.ts";

const base = "tests/fixtures/browser-acceptance-20261015/BrokerDesk_Synthetic_Test_Pack/fixtures";
async function pages(fileName: string) {
  const bytes = readFileSync(`${base}/${fileName}`);
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const result: PackagePage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      const text = normalizeOcrText(pdfTextLines(content.items.map(item => "str" in item ? item : {})));
      result.push({ page: pageNumber, pageNumber, text, extractionProvider: "embedded_pdf_text", extractionStatus: "COMPLETE", classification: classifyDocument(fileName, "application/pdf", text), sourceHash: `synthetic-${pageNumber}` });
    }
  } finally { await pdf.destroy(); }
  return result;
}
function record(fileName: string): UploadedDocumentRecord {
  return { id: `synthetic-${fileName}`, fileName, mimeType: "application/pdf", size: 1, documentType: "OTHER", classification: { documentType: "OTHER", confidence: .1, reason: "before page extraction" }, state: "UPLOADED" };
}
const quote = await pages("01_auto_quote_text.pdf");
assert.match(quote[0].text!, /Effective Date 2026-10-01\n/);
const quoteParsed = await parserFor("AUTO_QUOTE")!.parse({ text: quote[0].text!, confidence: .99, pages: quote }, { fileName: "quote.pdf" });
assert.equal(quoteParsed.data.effectiveDate, "2026-10-01");
assert.equal(quoteParsed.data.quoteNumber, "SYN-Q-AUTO-001");
assert.equal(quoteParsed.data.namedInsured, "ALPHA, TEST");

const mvr = await pages("03_mvr_two_drivers_text.pdf");
assert(mvr.every(page => page.classification.documentType === "MVR"));
const mvrSections = discoverLogicalSections(record("mvr.pdf"), mvr).suggestions;
assert.deepEqual(mvrSections.map(section => [section.startPage, section.endPage]), [[1, 1], [2, 2]]);
const mvrParsed = await Promise.all(mvr.map(page => parserFor("MVR")!.parse({ text: page.text!, confidence: .99, pages: [page] }, { fileName: "mvr.pdf" })));
assert.notEqual(mvrParsed[0].data.licenceNumber, mvrParsed[1].data.licenceNumber);
assert.equal(mvrParsed[0].data.demeritPoints, 0);
assert.deepEqual(mvrParsed[0].data.convictions, []);
assert.equal(mvrParsed[1].data.demeritPoints, 3);
const mvrRecords = mvrParsed.map((parsed, index) => ({ ...record(`mvr-${index}.pdf`), documentType: "MVR" as const, parsed: { ...parsed, documentId: `synthetic-mvr-${index}` }, id: `synthetic-mvr-${index}` }));
const proposals = proposedDrivers(mvrRecords, []);
assert.equal(proposals.length, 2);
assert.notEqual(proposals[0].licenceNumber, proposals[1].licenceNumber);
const confirmed = confirmedDriverFromProposal(proposals[0]);
assert.equal(confirmed.name, proposals[0].name);
assert.equal(confirmed.principal, false);
assert.equal(confirmed.assigned_vehicle, undefined);
assert.equal(proposedDrivers(mvrRecords, [confirmed]).length, 1);
assert.equal(proposedDrivers([{ ...mvrRecords[0], currentSourceHash: "MISSING" }], []).length, 0);
assert.equal(proposedDrivers([mvrRecords[0], { ...mvrRecords[1], parsed: { ...mvrRecords[1].parsed, data: { ...mvrRecords[1].parsed.data, licenceNumber: proposals[0].licenceNumber } } }], []).length, 0);

const dash = await pages("04_dash_two_reports_text.pdf");
const dashSections = discoverLogicalSections(record("dash.pdf"), dash).suggestions;
assert.deepEqual(dashSections.map(section => [section.startPage, section.endPage]), [[1, 3], [4, 6]]);
for (const [index, section] of dashSections.entries()) {
  const selected = dash.filter(page => page.page >= section.startPage! && page.page <= section.endPage!);
  const source = await parserFor("DASH")!.parse({ text: selected.map(page => page.text).join("\n"), confidence: .99, pages: selected }, { fileName: "dash.pdf" });
  const rows = claimRows(source);
  assert.equal(rows.length, 1);
  const claim = normalizedClaim(source, rows[0], 0);
  assert(claim.claim_number);
  assert(claim.loss_date);
  assert(["FIRST_PARTY", "THIRD_PARTY"].includes(String(claim.party_role)));
  assert.equal(claim.at_fault_percent, index === 0 ? 0 : 100);
  assert.equal(claim.loss_amount, index === 0 ? 1000 : 2200);
}
const hab = await pages("06_hab_mortgage_and_dates_text.pdf");
const habParsed = await parserFor("HAB_APPLICATION")!.parse({ text: hab[0].text!, confidence: .99, pages: hab }, { fileName: "hab.pdf" });
assert.equal(habParsed.data.riskAddress, "100 TEST FIXTURE LANE, EXAMPLEVILLE, ON, A1A 1A1");
assert.equal(habParsed.data.mortgagee, "SYNTHETIC TEST LENDER");
assert.equal(habParsed.data.numberOfMortgages, "1");
assert.equal(habParsed.data.propertyInsuredSince, "2020-06-01");
assert.equal(habParsed.data.continuouslyInsuredSince, "2014-04-01");
assert.equal(habParsed.data.occupiedSince, "2020-05-20");
console.log("PASS: searchable synthetic quote, distinct MVRs, DASH report groups and HAB evidence");

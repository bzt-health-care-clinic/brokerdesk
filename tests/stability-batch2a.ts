import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlankAutoCase } from "../lib/case-factories.ts";
import { discoverLogicalSections } from "../lib/package-analysis.ts";
import { refreshParserVersion, reparseDocument, updateLogicalSections } from "../lib/local-reparse.ts";
import { PARSER_VERSION, MVRParser, DashParser } from "../lib/document-ingestion.ts";
import { reconcileDocumentsIntoCase, removeDocumentFromCase } from "../lib/reconciliation.ts";
import { resolveField, runRules } from "../lib/rule-engine.ts";
import { assessClaims, partitionClaims } from "../lib/claim-assessment.ts";
import { suggestDocumentFilename } from "../lib/document-filenames.ts";
import { normalizedClaim } from "../lib/claim-records.ts";
import { DEFAULT_RULE_CONFIG, type Driver, type Claim } from "../lib/insurance-types.ts";
import type { DocumentType, LogicalDocument, PackagePage, UploadedDocumentRecord } from "../lib/extraction-types.ts";
import { openDatabase } from "../local-server/database.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";

const stamp = "2026-01-01T00:00:00Z";
const page = (n: number, type: DocumentType, text: string): PackagePage => ({ page: n, text, sourceHash: `synthetic-${n}`, extractionStatus: "COMPLETE", extractionProvider: "embedded_pdf_text", confidence: .99, classification: { documentType: type, confidence: .99, reason: "synthetic" } });
const record = (id: string, pages: PackagePage[]): UploadedDocumentRecord => ({ id, fileName: `${id}.pdf`, mimeType: "application/pdf", size: 10, state: "PARSED", documentType: "OTHER", classification: { documentType: "OTHER", confidence: .5, reason: "package" }, extractionVersion: 2, parserVersion: 3, packagePages: pages });
const section = (id: string, file: string, type: DocumentType, start: number, end = start): LogicalDocument => ({ id, physicalFileId: file, documentType: type, title: type, startPage: start, endPage: end, presenceStatus: "FOUND", parseStatus: "NOT_EVALUATED", validationStatus: "NOT_EVALUATED", classificationSource: "MANUAL", createdAt: stamp, updatedAt: stamp });
const driver = (id: string, licence: string): Driver => ({ id, name: "Same Name", relationship: "", principal: false, percentage_use: 0, licence_number: licence, licence_class: "", g1_date: "", g2_date: "", g_date: "2011-01-01", mvr_received: "", driver_training: false, retired: false, convictions: [], demerit_points: null, telematics: { enabled: false, app: "", phone: "", email: "", discount_percent: 0 } });
const base = createBlankAutoCase(); base.policy.effective_date = "2026-10-15"; base.drivers = [driver("driver-a", "A12345"), driver("driver-b", "B67890")];
const header = (id: string, licence: string, n: number, total: number) => `DASH AutoPlus\nReport ID: ${id}\nReport Date: 2026-10-01\nReport Subject: Same Name\nLicence Number: ${licence}\nPage ${n} of ${total}`;

const seven = record("seven", Array.from({ length: 7 }, (_, i) => page(i + 10, "DASH", header("R100", "A12345", i + 1, 7))));
const grouped = discoverLogicalSections(seven, seven.packagePages!).suggestions;
assert.equal(grouped.length, 1); assert.equal(grouped[0].startPage, 10); assert.equal(grouped[0].endPage, 16); assert.equal(grouped[0].suggestionStatus, "ACCEPTED");
const consecutive = record("consecutive", [page(1, "DASH", header("R100", "A12345", 1, 2)), page(2, "DASH", header("R100", "A12345", 2, 2)), page(3, "DASH", header("R200", "B67890", 1, 2)), page(4, "DASH", header("R200", "B67890", 2, 2))]);
const separate = discoverLogicalSections(consecutive, consecutive.packagePages!).suggestions;
assert.deepEqual(separate.map(s => [s.startPage, s.endPage]), [[1, 2], [3, 4]]); assert.notEqual(separate[0].id, separate[1].id);
const restarted = record("restart", [page(1, "DASH", header("R100", "A12345", 1, 2)), page(2, "DASH", header("R100", "A12345", 1, 2))]);
assert.equal(discoverLogicalSections(restarted, restarted.packagePages!).suggestions.length, 2);
const unknown = record("unknown", [page(1, "DASH", "DASH\nPage 1 of 2"), page(2, "DASH", "DASH\nPage 2 of 2\nContinued")]);
assert.ok(discoverLogicalSections(unknown, unknown.packagePages!).suggestions.every(s => s.suggestionStatus === "PENDING" && s.parseStatus === "NEEDS_REVIEW"));
const manual = { ...section("manual", "consecutive", "DASH", 1, 4), subjectId: "driver-b", subjectType: "DRIVER" };
assert.deepEqual(discoverLogicalSections({ ...consecutive, logicalDocuments: [manual] }, consecutive.packagePages!).manual, [manual]);

const mvrText = (licence: string, kind: string, points: string) => `Ontario Driving Record MVR\nReport ID: M${licence}\nDriver Name: Same Name\nLicence Number: ${licence}\nLicence Class: ${kind}\nRequest Date: 2026-10-01\nRelease Date: 2026-10-02\nReply Date: 2026-10-03\nReceived Date: 2026-10-04\nIssue Date: 2026-09-30\nExpiry Date: 2029-01-01\nLicence Status: VALID\nConditions: Corrective lenses\nDemerit Points: ${points}\nConvictions JSON: [{"description":"Speeding","offence_date":"2025-01-01","conviction_date":"2025-02-01"}]`;
const mvrs = record("mvrs", [page(20, "MVR", mvrText("A12345", "G", "3")), page(21, "MVR", mvrText("B67890", "G2", "0"))]);
const networkBefore = globalThis.fetch; let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error("Network forbidden in Batch 2A tests"); };
let refreshed: UploadedDocumentRecord;
let claimsRecord: UploadedDocumentRecord;
let mapped = base;
try {
  refreshed = await refreshParserVersion(mvrs);
  assert.equal(refreshed.parserVersion, PARSER_VERSION); assert.equal(refreshed.logicalDocuments?.length, 2);
  mapped = reconcileDocumentsIntoCase(base, [refreshed]);
  assert.deepEqual(mapped.drivers.map(d => [d.licence_class, d.mvr_demerit_points]), [["G", 3], ["G2", 0]]);
  const a = mapped.drivers.find(d => d.id === "driver-a")!;
  assert.deepEqual([a.mvr_requested, a.mvr_release_date, a.mvr_reply_date, a.mvr_received, a.mvr_issue_date, a.licence_expiry], ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-09-30", "2029-01-01"]);
  assert.equal(a.g_date, "2011-01-01"); assert.equal(a.licence_status, "VALID"); assert.deepEqual(a.licence_conditions, ["Corrective lenses"]);
  assert.equal(a.mvr_convictions?.[0].offence_date, "2025-01-01"); assert.equal(a.mvr_convictions?.[0].conviction_date, "2025-02-01"); assert.equal(a.mvr_convictions?.[0].demerit_points, null);
  const reversed = reconcileDocumentsIntoCase({ ...base, drivers: [...base.drivers].reverse() }, [refreshed]);
  assert.deepEqual(reversed.drivers.map(d => [d.id, d.licence_class]), [["driver-b", "G2"], ["driver-a", "G"]]);
  assert.ok(mapped.field_sources.find(f => f.canonicalField === "licenceClass" && f.subjectId === "driver-a")?.values[0].evidence?.some(e => e.page === 20));
  const noIdentity = { ...record("unassigned", [page(30, "MVR", "MVR\nLicence Class: M\nDriver Name: Same Name")]), logicalDocuments: [section("u", "unassigned", "MVR", 30)] };
  const unassigned = reconcileDocumentsIntoCase(mapped, [refreshed, await reparseDocument(noIdentity)]);
  assert.deepEqual(unassigned.drivers.map(d => d.licence_class), ["G", "G2"]); assert.ok(unassigned.field_sources.some(f => f.associationReview && f.canonicalField === "licenceClass"));
  const blankMvr = await new MVRParser().parse({ text: "MVR\nDriver Name: Someone", metadata: { fileId: "blank" } });
  assert.equal(blankMvr.data.demeritPoints, undefined); assert.equal(blankMvr.data.convictions, undefined); assert.equal(blankMvr.data.receivedDate, undefined);
  const convictionOnly = await new MVRParser().parse({ text: "MVR\nConviction: Speeding\nDemerit Points: 3" });
  assert.equal(convictionOnly.data.demeritPoints, undefined, "Conviction points must not become report total");
  const positioned = await new MVRParser().parse({ pages: [{ page: 42, blocks: [{ text: "MVR" }, { text: "Licence Number: A12345" }, { text: "Licence Class: G" }] }], metadata: { fileId: "positioned" } });
  assert.equal(positioned.fieldEvidence.licenceClass[0].page, 42);
  const claims = [
    { claim_number: "C100", loss_date: "2010-03-01", insurer: "Carrier", driver: "Same Name", driverLicenceNumber: "A12345", party_role: "FIRST_PARTY", coverage: "Collision", loss_amount: 1000, expense: 40, at_fault_percent: 25 },
    { claim_number: "C100", loss_date: "2010-03-01", insurer: "Carrier", driver: "Other Motorist", party_role: "THIRD_PARTY", coverage: "Liability", loss_amount: 5000, at_fault_percent: 100 },
    { claim_number: "C200", loss_date: "2010-03-01", insurer: "Different Carrier", driver: "Unidentified", coverage: "Comprehensive" },
  ];
  claimsRecord = await refreshParserVersion(record("claims", [page(50, "DASH", header("R300", "A12345", 1, 1) + "\n0 claims in last 6 years\nClaims JSON: " + JSON.stringify(claims))]));
  mapped = reconcileDocumentsIntoCase(mapped, [refreshed, claimsRecord]);
  assert.equal(mapped.claims.length, 3); assert.equal(assessClaims(mapped).historical.length, 3);
  const [own, third, unknownFault] = mapped.claims;
  assert.equal(own.driver_id, "driver-a"); assert.equal(third.driver_id, undefined); assert.equal(third.report_subject_id, "driver-a");
  assert.equal(third.party_role, "THIRD_PARTY"); assert.equal(third.at_fault_percent, 100); assert.equal(own.at_fault_percent, 25); assert.equal(unknownFault.at_fault_percent, null); assert.equal(unknownFault.loss_amount, null);
  assert.equal(third.loss_amount, 5000); assert.equal(own.loss_amount, 1000); assert.equal(own.expense, 40);
  assert.deepEqual(own.possible_duplicate_ids, [third.id]); assert.deepEqual(unknownFault.possible_duplicate_ids, []);
  assert.equal(own.source?.logicalDocumentId, claimsRecord.logicalDocuments![0].id); assert.equal(own.source?.evidence[0].page, 50);
  const labelled = await new DashParser().parse({ text: "DASH\nReport ID: R400\nLicence Number: A12345\n0 claims in last 6 years\nClaim Number: OLD1\nLoss Date: 2001-02-01\nParty Role: THIRD_PARTY\nDriver: Other\nAmount: $2,000\nFault: Unknown", metadata: { fileId: "labelled" } });
  assert.equal((labelled.data.claims as unknown[]).length, 1);
  const claimInsurer = await new DashParser().parse({ text: "DASH\nClaim Number: X\nInsurer: Third party carrier" });
  assert.equal(claimInsurer.data.priorInsurer, undefined, "Claim insurer must not become prior insurer");
  const mixed = await new DashParser().parse({ text: 'DASH\n0 claims in last 6 years\nClaims JSON: []\nClaim Number: Historical\nLoss Date: 2001-01-01', metadata: { fileId: "mixed" } });
  assert.equal((mixed.data.claims as unknown[]).length, 1, "An empty recent list must not hide historical detail");
  const source = claimsRecord.parsedSources![0];
  const originalRow = (source.data.claims as Record<string, unknown>[])[0];
  const reversedSource = { ...source, data: { ...source.data, claims: [...source.data.claims as unknown[]].reverse() } };
  assert.equal(normalizedClaim(source, originalRow, 0).id, normalizedClaim(reversedSource, originalRow, 2).id, "Claim record identity must survive row reordering");
  assert.equal((await refreshParserVersion(refreshed)), refreshed);
  assert.deepEqual((await refreshParserVersion({ ...consecutive, logicalDocuments: [manual] })).logicalDocuments, [manual]);
  assert.equal((await refreshParserVersion(unknown)).state, "NEEDS_REVIEW");
} finally { globalThis.fetch = networkBefore; }
assert.equal(calls, 0);

const review = assessClaims(mapped); assert.equal(review.assessmentDate, "2026-10-15");
assert.ok(runRules({ ...mapped, policy: { ...mapped.policy, effective_date: "" } }).some(a => a.field === "claims.assessmentDate"));
assert.equal(assessClaims({ ...mapped, policy: { ...mapped.policy, effective_date: "2026-02-30" } }).undetermined.length, 3);
assert.equal(assessClaims({ ...mapped, case_type: "auto_policy_change", policy_change: { change_effective_date: "2027-01-01" } as never }).assessmentDate, "2027-01-01");
const onBoundary = { ...mapped.claims[0], loss_date: "2020-10-15" };
assert.equal(partitionClaims([onBoundary], new Date("2026-10-15T00:00:00Z"), 6).ratingPeriod.length, 1);
assert.equal(assessClaims({ ...mapped, claims: [onBoundary] }, { ...DEFAULT_RULE_CONFIG, ratingPeriodYears: 3 }).historical.length, 1);
assert.equal(partitionClaims([onBoundary], new Date("2026-10-15T00:00:00Z"), 6, false).historical.length, 1);
const pageSource = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
assert.ok(!pageSource.includes('2026-09-14T00:00:00')); assert.ok(!pageSource.includes("partitionClaims("));
assert.ok(pageSource.includes("<ClaimsView assessment={claims}")); assert.ok(pageSource.includes("assessment={claims} alerts={activeAlerts}"));

// Render the actual MVR component without opening a browser or using a live case.
const componentText = readFileSync(new URL("../components/mvr-review.tsx", import.meta.url), "utf8");
const require = createRequire(import.meta.url);
const componentJs = ts.transpileModule(componentText, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('"react/jsx-runtime"', JSON.stringify(pathToFileURL(require.resolve("react/jsx-runtime")).href));
const component = await import(`data:text/javascript;base64,${Buffer.from(componentJs).toString("base64")}`);
const markup = renderToStaticMarkup(createElement(component.MvrReview, { driver: mapped.drivers[0], fields: mapped.field_sources }));
for (const word of ["Released", "Reply", "Received", "2026-10-02", "2026-10-03", "2026-10-04", "2025-02-01", "PDF page 20", "Corrective lenses"]) assert.ok(markup.includes(word), word);

const withManual = { ...mapped, claims: [...mapped.claims, { id: "manual", loss_date: "2009-01-01", insurer: "", policy_number: "", claim_number: "MANUAL", coverage: "", loss_amount: null, at_fault_percent: null, status: "" } satisfies Claim] };
const withdrawn = removeDocumentFromCase(withManual, claimsRecord!.id, [refreshed!]);
assert.deepEqual(withdrawn.claims.map(c => c.id), ["manual"]); assert.equal(withdrawn.withdrawn_claims?.length, 3);
const amountField = mapped.field_sources.find(f => f.canonicalField === "claim.loss_amount")!;
const resolved = resolveField(mapped, amountField.field, 1234, "Broker checked", "Broker");
const preservedDecision = removeDocumentFromCase(resolved, claimsRecord!.id, [refreshed!]);
assert.ok(preservedDecision.field_sources.find(f => f.field === amountField.field)?.evidenceReview);
assert.ok(preservedDecision.claims.some(c => c.source_active === false && c.evidence_review));

const root = mkdtempSync(join(tmpdir(), "brokerdesk-2a-")); const paths = resolveDataPaths({ ...process.env, BROKERDESK_DATA_DIR: root }); let db = openDatabase(paths.database);
try {
  let repo = new LocalRepositories(db, paths); repo.upsertCase({ case: mapped });
  repo.saveDocument(mapped.case_id, refreshed!, Buffer.from("synthetic"), "mvrs.pdf"); repo.saveDocument(mapped.case_id, claimsRecord!, Buffer.from("synthetic"), "claims.pdf");
  const photo: UploadedDocumentRecord = { ...record("photo", []), documentType: "VEHICLE_PHOTO", logicalDocuments: [{ ...section("photo-section", "photo", "VEHICLE_PHOTO", 1), documentSubtype: "VIN", subjectName: "Test Vehicle" }], raw: { text: "Vehicle photo" } };
  repo.saveDocument(mapped.case_id, photo, Buffer.from("synthetic"), "photo.pdf");
  db.close(); db = openDatabase(paths.database); repo = new LocalRepositories(db, paths);
  const reopened = repo.getCase(mapped.case_id); assert.equal(reopened.claims[0].driver_id, "driver-a"); assert.equal(reopened.claims[1].party_role, "THIRD_PARTY"); assert.equal(reopened.drivers[1].mvr_demerit_points, 0);
  const photoAgain = repo.listDocuments(mapped.case_id).find((r: UploadedDocumentRecord) => r.id === "photo") as UploadedDocumentRecord;
  assert.equal(photoAgain.logicalDocuments?.[0].documentSubtype, "VIN"); assert.match(suggestDocumentFilename(photoAgain, "Client")!, /Vehicle Photo.*VIN/);
  const photoReparsed = await reparseDocument(photoAgain); assert.equal(photoReparsed.logicalDocuments?.[0].documentSubtype, "VIN");
  const edited = await updateLogicalSections(photoAgain, photoAgain.logicalDocuments!.map(s => ({ ...s, documentSubtype: "REAR" }))); repo.updateDocument(photoAgain.id, edited);
  repo.upsertCase({ case: withdrawn });
  db.exec("ALTER TABLE logical_documents DROP COLUMN document_subtype"); // disposable legacy-schema simulation
  db.close(); db = openDatabase(paths.database); repo = new LocalRepositories(db, paths);
  assert.equal(repo.listDocuments(mapped.case_id).find((r: UploadedDocumentRecord) => r.id === "photo").logicalDocuments[0].documentSubtype, "REAR");
  assert.equal(repo.listDocuments(mapped.case_id).find((r: UploadedDocumentRecord) => r.id === "mvrs").logicalDocuments[0].documentSubtype, undefined);
  assert.deepEqual(repo.getCase(mapped.case_id).claims.map((c: Claim) => c.id), ["manual"]);
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
console.log("Batch 2A: boundaries, subject mapping, historical claims, shared assessment date, subtype reopen and zero-network refresh passed.");

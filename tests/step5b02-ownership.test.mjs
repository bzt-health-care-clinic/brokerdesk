import test from "node:test";
import assert from "node:assert/strict";
import { ownershipReceiptStatus } from "../lib/ownership-receipt.ts";
import { applyDocumentPresence, documentTypeIsFound } from "../lib/document-package.ts";
import { sectionRevision } from "../lib/active-evidence.ts";
import { hasOwnershipSectionForVehicle, confirmVehicleOwnership } from "../lib/broker-file-intake.ts";

const VIN = "AAAAA11111BBBBB22";
const OTHER_VIN = "CCCCC22222DDDDD33";
const basicVehicle = (id="vehicle-1", vin=VIN) => ({
  id, vin, ownership: { received: false, vin, registered_owner: "Example Person" },
});
const section = (options={}) => ({
  id: "ownership-section", physicalFileId: "ownership-1", documentType: "OWNERSHIP",
  presenceStatus: "FOUND", startPage: 1, endPage: 1,
  subjectId: "vehicle-1", updatedAt: "2026-10-20T00:00:00Z",
  createdAt: "2026-10-20T00:00:00Z", classificationSource: "AUTOMATIC",
  parseStatus: "PARSED", validationStatus: "NOT_EVALUATED",
  ...options,
});
const pdf = (options={}) => ({
  id: "ownership-1", documentType: "OWNERSHIP", fileName: "ownership-synthetic.pdf",
  classification: { documentType: "OWNERSHIP", confidence: .98, reason: "Synthetic fixture" },
  state: "NEEDS_REVIEW", sourceHash: "SHA256-SYNTHETIC", currentSourceHash: "SHA256-SYNTHETIC",
  size: 500, mimeType: "application/pdf",
  pageCount: 1, logicalDocuments: [], parsedSources: [],
  packagePages: [{ page: 1, extractionStatus: "FAILED" }],
  ...options,
});
const source = (s=section(), vin=VIN, options={}) => ({
  documentId: "ownership-1", documentType: "OWNERSHIP",
  parsedAt: "2026-10-21T00:00:00Z", confidence: .96,
  data: { vin }, warnings: [], fieldEvidence: { vin: [{page:1}] },
  logicalDocumentId: s.id, sourceRevision: sectionRevision(s),
  ...options,
});
const good = (options={}) => {
  const s=section(options.section??{});
  const {section: unused, ...recordOptions}=options;
  return pdf({ state:"PARSED", logicalDocuments:[s], parsedSources:[source(s)],
    // Step 5B-03 properly blocks a scanned/OCR-only VIN from being auto-attested.
    // A positive Step 5B-02 fixture must therefore have native-text source proof.
    packagePages:[{page:1,extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",text:"SYNTHETIC OWNERSHIP VIN AAAAA11111BBBBB22"}],
    ...recordOptions});
};
const caseDocument = () => ({
  documents: [
    { id:"ownership-doc", name:"Ownership", category:"ownership", required:true, received:false },
    { id:"quote-doc", name:"Auto Quote", category:"quote", required:true, received:false },
  ],
  ownership:{received:false},
});
const received = records => applyDocumentPresence(caseDocument(),records).documents[0].received;

test("01 no physical Ownership => MISSING",()=>{
  assert.equal(ownershipReceiptStatus([]).kind,"MISSING");
  assert.equal(received([]),false);
});
test("02 a hashed one-page scanned Ownership counts as received, not verified",()=>{
  const scan=pdf();
  assert.equal(ownershipReceiptStatus([scan]).kind,"RECEIVED_NEEDS_VERIFICATION");
  const presence=applyDocumentPresence(caseDocument(),[scan]);
  assert.equal(presence.documents[0].received,true);
  assert.equal(presence.ownership.received,false);
  assert.equal(documentTypeIsFound([scan],["OWNERSHIP"]),false);
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[scan]),false);
});
test("03 a labelled file lacking a source hash does not count",()=>{
  assert.equal(received([pdf({sourceHash:undefined})]),false);
});
test("04 current source hash mismatch voids physical receipt",()=>{
  assert.equal(received([pdf({currentSourceHash:"CHANGED"})]),false);
});
test("05 source marked MISSING voids receipt",()=>{
  assert.equal(received([pdf({currentSourceHash:"MISSING"})]),false);
});
test("06 stale extraction requires reprocessing",()=>{
  assert.equal(received([pdf({staleExtraction:true})]),false);
});
test("07 unrelated PDF does not become Ownership from file name",()=>{
  assert.equal(received([pdf({documentType:"AUTO_QUOTE",
    classification:{documentType:"AUTO_QUOTE",confidence:.99,reason:"Synthetic"},
    fileName:"ownership.pdf"})]),false);
});
test("08 accepted Ownership logical section is received",()=>{
  assert.equal(ownershipReceiptStatus([good()]).kind,"RECEIVED_WITH_SECTION");
  assert.equal(received([good()]),true);
});
test("09 matching parsed VIN lets Broker use existing checkbox",()=>{
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[good()]),true);
});
test("10 same subjectId without readable VIN is NOT verification",()=>{
  const s=section();
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:[s], parsedSources:[],
  })]),false);
});
test("11 wrong parsed VIN rejects even if subjectId matches",()=>{
  const s=section();
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:[s], parsedSources:[source(s,OTHER_VIN)],
  })]),false);
});
test("12 parsed correct plus contradictory VIN fails closed",()=>{
  const s=section();
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:[s],parsedSources:[source(s,VIN),source(s,OTHER_VIN)],
  })]),false);
});
test("13 a section bound to a different vehicle cannot be reused",()=>{
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[good({section:{subjectId:"vehicle-2"}})]),false);
});
test("14 a legacy extracted record without logical section cannot confirm vehicle",()=>{
  const s=section();
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:undefined, parsedSources:[source(s)],
  })]),false);
});
test("15 an explicitly withdrawn Ownership section is not active",()=>{
  const scan=good({ withdrawnSectionRanges:[{startPage:1,endPage:1}] });
  assert.equal(received([scan]),false);
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[scan]),false);
});
test("16 physical scan with withdrawn content is not reported received",()=>{
  assert.equal(received([pdf({withdrawnSectionRanges:[{startPage:1,endPage:1}]})]),false);
});
test("17 mixed PDF with only active quote sections cannot masquerade as Ownership",()=>{
  const fake=section({documentType:"AUTO_QUOTE"});
  assert.equal(received([pdf({logicalDocuments:[fake],documentType:"OWNERSHIP"})]),false);
});
test("18 an observed VIN with invalid characters cannot prove identity",()=>{
  const s=section();
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:[s],parsedSources:[source(s,"NOT A VIN")],
  })]),false);
});
test("19 broker confirmation works with uniquely linked matching VIN",()=>{
  const item={vehicles:[basicVehicle()]};
  const next=confirmVehicleOwnership(item,"vehicle-1",true,[good()]);
  assert.equal(next.vehicles[0].ownership.received,true);
  assert.equal(item.vehicles[0].ownership.received,false);
});
test("20 never confirm two vehicles having the same VIN",()=>{
  const item={vehicles:[basicVehicle(),basicVehicle("vehicle-2")]};
  const next=confirmVehicleOwnership(item,"vehicle-1",true,[good()]);
  assert.equal(next.vehicles[0].ownership.received,false);
});
test("21 a different car cannot borrow Vehicle 1 evidence",()=>{
  const item={vehicles:[basicVehicle(),basicVehicle("vehicle-2",OTHER_VIN)]};
  const next=confirmVehicleOwnership(item,"vehicle-2",true,[good()]);
  assert.equal(next.vehicles[1].ownership.received,false);
});
test("22 changing VIN invalidates the old scanned or parsed Ownership",()=>{
  const v=basicVehicle("vehicle-1",OTHER_VIN);
  assert.equal(hasOwnershipSectionForVehicle(v,[good()]),false);
});
test("23 byte change blocks previous proof",()=>{
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[good({currentSourceHash:"CHANGED"})]),false);
});
test("24 a different source revision blocks old parsed facts",()=>{
  const s=section({subjectId:"vehicle-1"});
  assert.equal(hasOwnershipSectionForVehicle(basicVehicle(),[pdf({
    logicalDocuments:[s],
    parsedSources:[source(s,VIN,{sourceRevision:"OBSOLETE"})],
  })]),false);
});
test("25 valid unrelated quote presence logic is unchanged",()=>{
  const quote=pdf({
    id:"quote-1",documentType:"AUTO_QUOTE",
    classification:{documentType:"AUTO_QUOTE",confidence:.98,reason:"Synthetic"},
    logicalDocuments:undefined,
  });
  const d=applyDocumentPresence(caseDocument(),[quote]);
  assert.equal(d.documents[0].received,false);
  assert.equal(d.documents[1].received,true);
});
test("26 two current Ownership scans count as distinct received files only",()=>{
  const r1=pdf();
  const r2=pdf({id:"ownership-2",sourceHash:"HASH2",currentSourceHash:"HASH2"});
  const state=ownershipReceiptStatus([r1,r2]);
  assert.equal(state.kind,"RECEIVED_NEEDS_VERIFICATION");
  assert.deepEqual(state.physicalFileIds,["ownership-1","ownership-2"]);
});
test("27 duplicate record references count once",()=>{
  const r=pdf();
  assert.equal(ownershipReceiptStatus([r,r]).physicalFileIds.length,1);
});
test("28 empty extracted VIN plus matching subjectId is still blocked",()=>{
  const s=section();
  const record=pdf({logicalDocuments:[s],parsedSources:[source(s,"")]});
  const updated=confirmVehicleOwnership({vehicles:[basicVehicle()]},"vehicle-1",true,[record]);
  assert.equal(updated.vehicles[0].ownership.received,false);
});

test("29 a matching parsed VIN cannot confirm contradictory Case Ownership VIN",()=>{
  const v=basicVehicle();
  v.ownership.vin=OTHER_VIN;
  assert.equal(hasOwnershipSectionForVehicle(v,[good()]),false);
});

import test from "node:test";
import assert from "node:assert/strict";
import {buildDocumentDiagnostics} from "../lib/step5b05-diagnostics.ts";

const classification={documentType:"OTHER"};
const record=(pages=[],more={})=>({
 id:"synthetic",documentType:"OTHER",classification,
 packagePages:pages,pageCount:pages.length,
 ...more
});
const embedded=(page,text="Synthetic embedded page with enough characters")=>({
 page,extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",text
});
test("embedded-only text has NOT_REQUESTED OCR and not a fake failure",()=>{
 const d=buildDocumentDiagnostics(record([embedded(1)]));
 assert.equal(d.ocrRequestStatus,"NOT_REQUESTED");
 assert.equal(d.pageStates[0].state,"EMBEDDED_TEXT");
});
test("old metadata with no execution history is UNRECORDED, not false",()=>{
 const d=buildDocumentDiagnostics(record([],{raw:{metadata:{}}}));
 assert.equal(d.ocrRequestStatus,"UNRECORDED");
 assert.deepEqual(d.logicalDocuments,[]);
});
test("explicit OCR failure is preserved",()=>{
 const d=buildDocumentDiagnostics(record([{page:1,extractionStatus:"FAILED",
  extractionProvider:"tesseract_local",error:"OCR returned no text."}],{
   raw:{metadata:{requestSucceeded:false,provider:"tesseract_local"}}
 }));
 assert.equal(d.ocrRequestStatus,"FAILED");
 assert.deepEqual(d.failedPageNumbers,[1]);
});
test("mixed scan records list exact failed/pending pages",()=>{
 const d=buildDocumentDiagnostics(record([
  embedded(1),{page:2,extractionStatus:"FAILED",error:"Need OCR"},
  {page:3,extractionStatus:"FAILED",error:"PDF render failed"}
 ]));
 assert.deepEqual(d.failedPageNumbers,[3]);
 assert.deepEqual(d.needsOcrPageNumbers,[2]);
 assert.equal(d.ocrRequestStatus,"UNRECORDED");
});
test("recognized blank page does not masquerade as OCR failure",()=>{
 const d=buildDocumentDiagnostics(record([{page:1,extractionStatus:"COMPLETE",
  extractionProvider:"embedded_pdf_text",text:""}]));
 assert.equal(d.pageStates[0].state,"BLANK_PAGE");
 assert.equal(d.ocrRequestStatus,"NOT_REQUESTED");
});
test("parser section with actual parsed artifact is PARSED",()=>{
 const d=buildDocumentDiagnostics(record([embedded(1)],{
 logicalDocuments:[{id:"sectionA",documentType:"AUTO_QUOTE",startPage:1,endPage:1,
   parseStatus:"PARSED",validationStatus:"NOT_EVALUATED"}],
 parsedSources:[{logicalDocumentId:"sectionA",documentType:"AUTO_QUOTE",
 data:{quoteNumber:"SYN-Q-1",liability:1000000},entities:[{data:{vin:"SYN-VIN"}}]}]
 }));
 assert.equal(d.logicalDocuments[0].parser,"AUTO_QUOTE");
 assert.equal(d.logicalDocuments[0].status,"PARSED");
 assert.equal(d.finalParsedFieldCount,3);
 assert.equal(JSON.stringify(d).includes("SYN-Q-1"),false);
});
test("missing saved parser result shows UNRECORDED, never none",()=>{
 const d=buildDocumentDiagnostics(record([embedded(1)],{
 logicalDocuments:[{id:"a",documentType:"AUTO_QUOTE",startPage:1,endPage:1}]
 }));
 assert.equal(d.logicalDocuments[0].status,"UNRECORDED");
 assert.equal(d.logicalDocuments[0].parser,"UNRECORDED");
});
test("source parsed with no logical ID shows unbound provenance",()=>{
 const d=buildDocumentDiagnostics(record([embedded(1)],{
 parsed:{documentType:"AUTO_QUOTE",data:{quoteNumber:"SYN-Q-123"}}}));
 assert.equal(d.logicalDocuments[0].logicalDocumentId,null);
 assert.equal(d.finalParsedFieldCount,1);
});
test("recorded OCR success is not determined by parser success",()=>{
 const d=buildDocumentDiagnostics(record([{
  page:1,extractionStatus:"COMPLETE",extractionProvider:"tesseract_local",text:"synthetic"
 }],{raw:{metadata:{requestSucceeded:true}}}));
 assert.equal(d.ocrRequestStatus,"SUCCEEDED");
 assert.equal(d.pageStates[0].state,"COMPLETED");
 assert.equal(d.finalParsedFieldCount,0);
});
test("physical pages and logical classifications shown independently",()=>{
 const d=buildDocumentDiagnostics(record([embedded(1),embedded(2)],{
 documentType:"OTHER",logicalDocuments:[
 {id:"a",documentType:"AUTO_QUOTE",startPage:1,endPage:1},
 {id:"b",documentType:"MVR",startPage:2,endPage:2}]
 }));
 assert.equal(d.containerClassification,"OTHER");
 assert.deepEqual(d.logicalDocuments.map(x=>x.documentType),["AUTO_QUOTE","MVR"]);
});

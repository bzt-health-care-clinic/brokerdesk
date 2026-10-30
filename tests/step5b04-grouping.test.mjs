import test from "node:test";
import assert from "node:assert/strict";
import {
  signedApplicationCoverType, prepareSignedApplicationPages,
  coalesceSignedApplicationSuggestions, signedApplicationRegroupCandidate,
  hasIndependentDocumentBoundary,
} from "../lib/signed-application-grouping.ts";
import {
  signedApplicationSelectionValid, signedApplicationChoices,
} from "../lib/signed-application-choice.ts";

const HASH="f".repeat(64);
const pg=(n, type="AUTO_APPLICATION", text="Application continuation", status="COMPLETE", confidence=.96)=>({
  page:n, pageNumber:n, extractionStatus:status, text,
  extractionProvider:status==="COMPLETE"?"embedded_pdf_text":"none",
  classification:{documentType:type,confidence,reason:"synthetic"},
  sourceHash:"p"+n,
});
const autoCover="G4Sign Ontario Application for Automobile Insurance \n Page 1 of 25";
const homeCover="G4Sign Habitational Insurance Application \n Page 1 of 16";
const rec=(pages, extra={})=>({
 id:"doc-1",fileName:"G4Sign_auto.pdf",originalFileName:"G4Sign_auto.pdf",
 sourceHash:HASH,currentSourceHash:HASH,pageCount:pages.length,
 documentType:"AUTO_APPLICATION",packagePages:pages,
 logicalDocuments:[],suggestedSections:[],withdrawnSectionRanges:[],...extra,
});
const suggestion=(n,start=n,end=n,type="AUTO_APPLICATION",status="ACCEPTED")=>({
 id:`doc-1-suggested-${start}-${end}-${type}`,physicalFileId:"doc-1",
 documentType:type,title:"Application",startPage:start,endPage:end,
 presenceStatus:"FOUND",parseStatus:"NOT_EVALUATED",validationStatus:"NOT_EVALUATED",
 classificationSource:"AUTOMATIC",classificationConfidence:.96,
 suggestionStatus:status,evidenceSignals:["source"],createdAt:"2026-01-01",updatedAt:"2026-01-01",
});
function fixture(count=25){
 return Array.from({length:count},(_,i)=>pg(i+1,"AUTO_APPLICATION",i===0?autoCover:`Page ${i+1} of ${count}\nVehicle and driver information`));
}
test("verified Auto G4Sign cover gives AUTO_APPLICATION",()=>{
 const p=fixture();assert.equal(signedApplicationCoverType(rec(p),p),"AUTO_APPLICATION");
});
test("verified Home G4Sign cover gives HAB_APPLICATION",()=>{
 const p=[pg(1,"HAB_APPLICATION",homeCover),pg(2,"HAB_APPLICATION")];
 assert.equal(signedApplicationCoverType(rec(p,{fileName:"G4Sign_home.pdf"}),p),"HAB_APPLICATION");
});
test("ambiguous Auto + Home cover does not infer an application family",()=>{
 const p=[pg(1,"OTHER",autoCover+"\n"+homeCover)];
 assert.equal(signedApplicationCoverType(rec(p),p),undefined);
});
test("filename alone is not a cover",()=>{
 const p=[pg(1,"OTHER","Application information only")];
 assert.equal(signedApplicationCoverType(rec(p),p),undefined);
});
test("unrelated PDF even with cover-like words is not G4Sign",()=>{
 const p=[pg(1,"OTHER",autoCover)];
 assert.equal(signedApplicationCoverType(rec(p,{fileName:"random.pdf",originalFileName:"random.pdf"}),p),undefined);
});
test("an explicit G4Sign application cover overrides a noisy quote classification",()=>{
 const p=[pg(1,"AUTO_QUOTE",autoCover),pg(2,"AUTO_APPLICATION","Driver information")];
 const out=prepareSignedApplicationPages(rec(p),p);
 assert.equal(out.pages[0].classification.documentType,"AUTO_APPLICATION");
 assert.equal(out.pages[0].classification.confidence,.95);
});
test("no auto-merging an embedded MVR title",()=>{
 const p=fixture(4);p[2]=pg(3,"MVR","MVR Abstracts - Driver A");
 assert.equal(hasIndependentDocumentBoundary(p[2],"AUTO_APPLICATION"),true);
 const out=prepareSignedApplicationPages(rec(p),p);
 assert.equal(out.pages[2].classification.documentType,"MVR");
});
test("no auto-merging a quoted page inside a G4Sign packet",()=>{
 const p=fixture(5);p[2]=pg(3,"AUTO_QUOTE","Auto Insurance Quote\nQuoted premium");
 const out=prepareSignedApplicationPages(rec(p),p);
 assert.equal(out.pages[2].classification.documentType,"AUTO_QUOTE");
});
test("converts weak OTHER continuation after confirmed cover with review confidence",()=>{
 const p=fixture(3);p[1]=pg(2,"OTHER","Policyholder particulars");
 const out=prepareSignedApplicationPages(rec(p),p);
 assert.equal(out.pages[1].classification.documentType,"AUTO_APPLICATION");
 assert.ok(out.pages[1].classification.confidence<.9);
});
test("nonconsecutive worker completion order still groups in physical-page order",()=>{
 const p=fixture(3);
 const out=prepareSignedApplicationPages(rec(p),[p[2],p[0],p[1]]);
 assert.deepEqual(out.pages.map(x=>x.page),[1,2,3]);
});
test("25-page signed app with individual suggestions consolidates to one proposal",()=>{
 const p=fixture(25);
 const old=p.map(x=>suggestion(x.page));
 const out=coalesceSignedApplicationSuggestions(rec(p),p,old);
 assert.equal(out.length,1);assert.equal(out[0].startPage,1);
 assert.equal(out[0].endPage,25);assert.equal(out[0].suggestionStatus,"ACCEPTED");
});
test("25-page signed home groups separately by home type",()=>{
 const p=Array.from({length:16},(_,i)=>pg(i+1,"HAB_APPLICATION",i===0?homeCover:"House details"));
 const r=rec(p,{fileName:"SignedHomeApplication.pdf",originalFileName:"SignedHomeApplication.pdf",documentType:"HAB_APPLICATION"});
 const out=coalesceSignedApplicationSuggestions(r,p,p.map(x=>suggestion(x.page,x.page,x.page,"HAB_APPLICATION")));
 assert.equal(out.length,1); assert.equal(out[0].documentType,"HAB_APPLICATION");assert.equal(out[0].endPage,16);
});
test("mixed 12-page application then 8-page DASH yields two independent proposals",()=>{
 const p=fixture(12);p.push(pg(13,"DASH","DASH Driver Report"),pg(14,"DASH","Claim #1"));
 const s=[...p.slice(0,12).map(x=>suggestion(x.page)),suggestion(13,13,14,"DASH")];
 const out=coalesceSignedApplicationSuggestions(rec(p),p,s);
 assert.equal(out.length,2);
 assert.equal(out[0].documentType,"AUTO_APPLICATION");
 assert.equal(out[0].endPage,12);
 assert.equal(out[1].documentType,"DASH");
});
test("MVR between two application sources is not jumped across",()=>{
 const p=fixture(5);p[2]=pg(3,"MVR","Ontario Driving Record");
 const s=[suggestion(1,1,2),suggestion(3,3,3,"MVR"),suggestion(4,4,5)];
 const out=coalesceSignedApplicationSuggestions(rec(p),p,s);
 assert.equal(out.length,3);
});
test("unknown interior page is included in span but forces PENDING",()=>{
 const p=fixture(5);p[2]=pg(3,"OTHER","", "FAILED",0);
 const s=[suggestion(1,1,2),suggestion(4,4,5)];
 const out=coalesceSignedApplicationSuggestions(rec(p),p,s);
 assert.equal(out.length,1);assert.equal(out[0].startPage,1);assert.equal(out[0].endPage,5);
 assert.equal(out[0].suggestionStatus,"PENDING");
 assert.equal(out[0].parseStatus,"NEEDS_REVIEW");
});
test("trailing unreadable page is included but prevents automatic acceptance",()=>{
 const p=fixture(5);p[4]=pg(5,"OTHER","", "FAILED",0);
 const out=coalesceSignedApplicationSuggestions(rec(p),p,[suggestion(1,1,4)]);
 assert.equal(out[0].endPage,5);assert.equal(out[0].suggestionStatus,"PENDING");
});
test("manual section inside range blocks automatic merging",()=>{
 const p=fixture(5);
 const s=[suggestion(1,1,2),suggestion(4,4,5)];
 const manual={...suggestion(3,3,3,"AUTO_QUOTE"), classificationSource:"MANUAL"};
 const out=coalesceSignedApplicationSuggestions(rec(p,{logicalDocuments:[manual]}),p,s);
 assert.equal(out.length,2);
});
test("withdrawn page blocks merging across it",()=>{
 const p=fixture(5);
 const out=coalesceSignedApplicationSuggestions(rec(p,{withdrawnSectionRanges:[{startPage:3,endPage:3}]}),p,
 [suggestion(1,1,2),suggestion(4,4,5)]);
 assert.equal(out.length,2);
});
test("explicit restarted signed application cover prevents merging",()=>{
 const p=fixture(5);
 p[3]=pg(4,"AUTO_APPLICATION","G4Sign new application Cover Page\nOntario Application for Automobile Insurance");
 const out=coalesceSignedApplicationSuggestions(rec(p),p,[suggestion(1,1,3),suggestion(4,4,5)]);
 assert.equal(out.length,2);
});
test("existing 7 legacy G4Sign sections display ONE disabled choice until regroup",()=>{
 const p=fixture(7);const r=rec(p,{logicalDocuments:p.map(x=>suggestion(x.page))});
 const list=signedApplicationChoices([r],"new_auto");
 assert.equal(list.length,1); assert.equal(list[0].selectable,false);
 assert.match(list[0].label,/regroup/i);
});
test("full original application section is selectable",()=>{
 const p=fixture(7);const r=rec(p,{logicalDocuments:[suggestion(1,1,7)]});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,true);
 assert.equal(signedApplicationChoices([r],"new_auto")[0].selectable,true);
});
test("signed verification cannot bind only the first two pages",()=>{
 const p=fixture(7);const r=rec(p,{logicalDocuments:[suggestion(1,1,2)]});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,false);
});
test("signed verification cannot bind entire PDF if it swallows a Quote",()=>{
 const p=fixture(7);p[4]=pg(5,"AUTO_QUOTE","Auto Insurance Quote");
 const r=rec(p,{logicalDocuments:[suggestion(1,1,7)]});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,false);
});
test("signed verification blocks unreadable signature page",()=>{
 const p=fixture(7);p[6]=pg(7,"OTHER","", "FAILED",0);
 const r=rec(p,{logicalDocuments:[suggestion(1,1,7)]});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,false);
});
test("signed verification is source hash bound",()=>{
 const p=fixture(4);const r=rec(p,{logicalDocuments:[suggestion(1,1,4)],currentSourceHash:"0".repeat(64)});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,false);
});
test("source withdrawal invalidates signed selection",()=>{
 const p=fixture(4);const r=rec(p,{logicalDocuments:[suggestion(1,1,4)],withdrawnSectionRanges:[{startPage:2,endPage:2}]});
 assert.equal(signedApplicationSelectionValid(r,r.logicalDocuments[0].id).valid,false);
});
test("new regroup candidate consolidates legacy auto fragments without auto-attesting",()=>{
 const p=fixture(5);const r=rec(p,{logicalDocuments:[suggestion(1,1,2),suggestion(3,3,4),suggestion(5,5,5)]});
 const proposal=signedApplicationRegroupCandidate(r);
 assert.ok(proposal);assert.equal(proposal.endPage,5);
 assert.notEqual(proposal.id,r.logicalDocuments[0].id);
});
test("cannot regroup manual split application sections",()=>{
 const p=fixture(4);const a=suggestion(1,1,2);
 a.classificationSource="MANUAL";
 const r=rec(p,{logicalDocuments:[a,suggestion(3,3,4)]});
 assert.equal(signedApplicationRegroupCandidate(r),undefined);
});
test("cannot regroup through failed OCR pages",()=>{
 const p=fixture(4);p[2]=pg(3,"OTHER","", "FAILED",0);
 const r=rec(p,{logicalDocuments:[suggestion(1,1,2),suggestion(4,4,4)]});
 assert.equal(signedApplicationRegroupCandidate(r),undefined);
});
test("only page-bound binding is selectable; no synthetic logical document ID",()=>{
 const p=fixture(4);const r=rec(p,{logicalDocuments:[suggestion(1,1,4)]});
 const list=signedApplicationChoices([r],"new_auto");
 assert.equal(list[0].logicalId,r.logicalDocuments[0].id);
});
test("unrelated quote and home files not shown as new auto applications",()=>{
 const p=[pg(1,"HAB_APPLICATION",homeCover)];
 const r=rec(p,{fileName:"SignedHomeApplication.pdf",originalFileName:"SignedHomeApplication.pdf",logicalDocuments:[suggestion(1,1,1,"HAB_APPLICATION")]});
 assert.deepEqual(signedApplicationChoices([r],"new_auto"),[]);
});

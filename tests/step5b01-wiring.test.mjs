/**
 * Integration tests run inside the actual BrokerDesk checkout (Node 24).
 * They are intentionally separate from the pure extractor tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {parseAppliedRating} from "../lib/applied-rating-parser.ts";
import {AutoQuoteParser} from "../lib/document-ingestion.ts";
import {reconcileField} from "../lib/reconciliation.ts";
import {buildExplicitReviewCandidates} from "../local-server/broker-review-source.mjs";
import {createBrokerReview} from "../lib/broker-keyin-review.mjs";
import {projectBrokerReviewedCase} from "../local-server/reviewed-case-projection-stage3b.mjs";
import {reviewedCaseConsistencyIssues} from "../local-server/reviewed-keyin-package.mjs";
import {prepareAuditorReviewedRecord} from "../local-server/reviewed-keyin-stage3.mjs";

const hash="c".repeat(64);
const samplePage=(page,text)=>({page,pageNumber:page,text,confidence:.99,
  extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE"});
const raw=(pages)=>({text:pages.map(p=>p.text).join("\n"),
  pages,metadata:{fileId:"doc-auto"},confidence:.99});
const caseItem=(number=null)=>({
 case_id:"synthetic-case",case_type:"new_auto",
 policy:{company:"Aviva",quote_number:number,client_code:"BROKER-CODE-1",
   effective_date:"2026-11-01",mailing_address:"123 Example Street"},
 insured:{name:"SYNTHETIC TEST",co_insured:[]},drivers:[],vehicles:[],
 documents:[],prior_insurance:{},claims:[]
});
const context=(number,documentId="doc-auto",page=2)=>({
 record:{id:documentId,state:"PARSED",parserVersion:9,packagePages:[samplePage(page,"Quote Number: "+number)]},
 hash,observation:{documentId,documentType:"AUTO_QUOTE",
   data:{quoteNumber:number},fieldEvidence:{
     quoteNumber:[{page,confidence:.99,text:number}]},warnings:[]}
});

test("Applied auto table uses dedicated Quote Number extraction from later physical page",()=>{
 const parsed=parseAppliedRating(raw([
  samplePage(1,"Applied Rating Services\nVehicle 1 of 1"),
  samplePage(5,"Here is your quote number: Q81002555\nApplied Ref. #: REF888")
 ]),"AUTO_QUOTE");
 assert.ok(parsed);
 assert.equal(parsed.data.quoteNumber,"Q81002555");
 assert.equal(parsed.fieldEvidence.quoteNumber[0].page,5);
 assert.equal(parsed.data.clientCode,undefined);
});
test("normal AUTO_QUOTE fallback recognizes explicit label without guessing Submission",async()=>{
 const parser=new AutoQuoteParser();
 const parsed=await parser.parse(raw([
  samplePage(3,"Quote Number: Q19995555\nApplied Ref. #: REF333\nSubmission Number: S444")
 ]));
 assert.equal(parsed.data.quoteNumber,"Q19995555");
 assert.equal(parsed.fieldEvidence.quoteNumber[0].page,3);
});
test("quote gets canonical reconciliation field, not Client Code",()=>{
 const src={documentId:"doc-auto",documentType:"AUTO_QUOTE",parsedAt:new Date().toISOString(),
    confidence:.99,data:{quoteNumber:"Q19995555"},
    fieldEvidence:{quoteNumber:[{page:2,confidence:.99,text:"Q19995555"}]},warnings:[]};
 assert.equal(reconcileField("quoteNumber",[src]).value,"Q19995555");
 assert.equal(reconcileField("clientCode",[src]).value,null);
});
test("Broker Review maps only quote-labelled AUTO_QUOTE to policy.quoteNumber",()=>{
 const fields=[{id:"policy.quoteNumber",type:"text"}];
 const good=buildExplicitReviewCandidates(caseItem(),fields,[context("Q19995555")]);
 assert.deepEqual(good.candidates.map(c=>c.fieldId),["policy.quoteNumber"]);
 assert.equal(good.candidates[0].page,2);
 const application=context("Q7777777");
 application.observation.documentType="AUTO_APPLICATION";
 assert.equal(buildExplicitReviewCandidates(caseItem(),fields,[application]).candidates.length,0);
});
test("Broker Review does not replace a pre-entered different Case Quote #",()=>{
 const caseData=caseItem("QMANUAL111");
 const candidates=buildExplicitReviewCandidates(caseData,
  [{id:"policy.quoteNumber",type:"text"}],[context("QEXTRACT999")]).candidates;
 const review=createBrokerReview(caseData,{sourceFiles:[{id:"doc-auto",sha256:hash}],candidates});
 const quote=review.fields.find(f=>f.id==="policy.quoteNumber");
 assert.equal(quote.value,"QMANUAL111");
 assert.equal(quote.conflict,true);
 assert.equal(review.review_status,"DRAFT");
});
test("Quote candidates from different logical sections become an explicit conflict",()=>{
 const candidates=buildExplicitReviewCandidates(caseItem(),
  [{id:"policy.quoteNumber",type:"text"}],
  [context("Q11111111","doc-auto",2),context("Q22222222","doc-auto",4)]).candidates;
 const review=createBrokerReview(caseItem(),{sourceFiles:[{id:"doc-auto",sha256:hash}],candidates});
 assert.equal(review.fields.find(f=>f.id==="policy.quoteNumber").conflict,true);
});
test("explicitly reviewed Quote # projects to outbound Case copy, preserves Client Code",()=>{
 const source=caseItem("QOLD11111");
 const snapshot={source_case_id:source.case_id,case_type:source.case_type,
   company:source.policy.company,review_status:"BROKER_CONFIRMED",
   sections:[{id:"policy",status:"CONFIRMED",confirmation:{at:"2026-10-28"}}],
   fields:[{id:"policy.quoteNumber",value:"QNEW22222"}]};
 const projection=projectBrokerReviewedCase(source,snapshot);
 assert.deepEqual(projection.issues,[]);
 assert.equal(projection.item.policy.quote_number,"QNEW22222");
 assert.equal(projection.item.policy.client_code,"BROKER-CODE-1");
 assert.equal(source.policy.quote_number,"QOLD11111");
 assert.equal(reviewedCaseConsistencyIssues(snapshot,projection.item).filter(x=>x.includes("quoteNumber")).length,0);
 assert.ok(reviewedCaseConsistencyIssues(snapshot,source).some(x=>x.includes("quoteNumber")));
});
test("existing auto_quote_number alias follows the confirmed outbound value",()=>{
 const source=caseItem("QOLD11111");
 source.policy.auto_quote_number="QOLD11111";
 const snapshot={source_case_id:source.case_id,case_type:source.case_type,
   company:source.policy.company,review_status:"BROKER_CONFIRMED",
   sections:[{id:"policy",status:"CONFIRMED",confirmation:{}}],
   fields:[{id:"policy.quoteNumber",value:"QNEW22222"}]};
 const projected=projectBrokerReviewedCase(source,snapshot);
 assert.deepEqual(projected.issues,[]);
 assert.equal(projected.item.policy.auto_quote_number,"QNEW22222");
 assert.equal(projected.item.policy.quote_number,"QNEW22222");
});

test("Auditor remaps and displays Broker-confirmed Quote #, preserving source evidence",()=>{
 const snapshot={
   source_case_id:"synthetic-case",source_files:[{id:"doc-auto",sha256:hash}],
   finalized_by:"BROKER-TEST",review_status:"BROKER_CONFIRMED",
   snapshot_sha256:"f".repeat(64),
   fields:[{
     id:"policy.quoteNumber",section:"policy",label:"Quote / submission #",
     value:"Q81002555",origin:"EXTRACTED",
     evidence:[{documentId:"doc-auto",sourceHash:hash,page:5,confidence:.99}]
   }],
   sections:[{id:"policy",title:"Policy / Insured",status:"CONFIRMED"}]
 };
 const imported=prepareAuditorReviewedRecord(
   snapshot,new Map([["synthetic-case","AUDITOR-CASE"],["doc-auto","AUDITOR-DOC"]]),
   "AUDITOR-CASE"
 );
 const rows=imported.worksheet.sections.flatMap(s=>s.rows);
 const quote=rows.find(x=>x.id==="policy.quoteNumber");
 assert.ok(quote,"Auditor sheet must display Quote Number as a row");
 assert.match(quote.value,/^Q81002555$/);
 assert.equal(imported.view.fields.find(f=>f.id==="policy.quoteNumber").evidence[0].documentId,"AUDITOR-DOC");
});

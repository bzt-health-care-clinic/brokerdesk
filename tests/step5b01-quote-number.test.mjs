import test from "node:test";
import assert from "node:assert/strict";
import {extractAppliedQuoteNumber} from "../lib/applied-quote-number.ts";

const raw = (pages) => ({pages,confidence:.99,metadata:{fileId:"synthetic-quote"}});
const page = (n,text,confidence=.99,blocks=undefined) =>
  ({page:n,pageNumber:n,text,confidence,blocks});
const found = (pages) => extractAppliedQuoteNumber(raw(pages));

test("explicit Here is your quote number on page 1",()=>{
 const r=found([page(1,"Applied Rating Services\nHere is your quote number: QAB123456")]);
 assert.equal(r.value,"QAB123456");
 assert.equal(r.evidence[0].page,1);
 assert.equal(r.warnings.length,0);
});
test("Quote Number exact label; no loose Quote or Submission alias",()=>{
 const r=found([page(3,"Quote Number: Q2026102301\nSubmission Number: S999999")]);
 assert.equal(r.value,"Q2026102301");
 assert.equal(r.evidence[0].page,3);
});
test("quote on later physical page retains actual page",()=>{
 const r=found([page(1,"Applied Rating Services\nPolicy Information"),page(6,"Here is your quote number: QLATER5678")]);
 assert.equal(r.value,"QLATER5678");
 assert.equal(r.evidence[0].page,6);
});
test("quote may follow explicit label on next line",()=>{
 const r=found([page(2,"Quote Number:\nQ00001234")]);
 assert.equal(r.value,"Q00001234");
});
test("no inference from Applied Ref, Policy, Account or Submission",()=>{
 const r=found([page(1,"Applied Ref. #: A123456\nPolicy Number: P123456\nAccount Number: A999999\nSubmission Number: S777777")]);
 assert.equal(r.value,undefined);
 assert.deepEqual(r.evidence,[]);
});
test("no value is not a made-up number",()=>{
 const r=found([page(2,"Applied Rating Services\nApplicant Information")]);
 assert.equal(r.value,undefined);
 assert.deepEqual(r.warnings,[]);
});
test("a malformed quoted value is withheld for review",()=>{
 const r=found([page(2,"Quote Number: SOME VALUE WITH SPACES")]);
 assert.equal(r.value,undefined);
 assert.ok(r.warnings.some(w=>w.field==="quoteNumber"));
});
test("two differing explicit numbers in same page are conflicts",()=>{
 const r=found([page(1,"Quote Number: Q1234567\nHere is your quote number: Q7654321")]);
 assert.equal(r.value,undefined);
 assert.equal(r.evidence.length,2);
 assert.ok(r.warnings.some(w=>w.severity==="high"));
});
test("two differing explicit numbers in different pages are conflicts",()=>{
 const r=found([page(2,"Quote Number: Q1234567"),page(4,"Quote Number: Q7654321")]);
 assert.equal(r.value,undefined);
 assert.equal(r.evidence.length,2);
});
test("repeated identical number across pages is not a conflict",()=>{
 const r=found([page(2,"Quote Number: Q1234567"),page(4,"Quote Number: Q1234567")]);
 assert.equal(r.value,"Q1234567");
 assert.equal(r.evidence.length,1);
 assert.equal(r.evidence[0].page,2);
});
test("low-confidence label cannot become confirmed number",()=>{
 const r=found([page(1,"Quote Number: Q1234567",.72)]);
 assert.equal(r.value,undefined);
 assert.ok(r.warnings.some(w=>w.code==="NEEDS_REVIEW"));
});
test("high-confidence PDF block preserves exact bounding box",()=>{
 const box={x:100,y:40,width:120,height:12};
 const r=found([page(2,"Here is your quote number: Q1234567",.99,
  [{text:"Here is your quote number: Q1234567",confidence:.98,boundingBox:box}])]);
 assert.equal(r.value,"Q1234567");
 assert.deepEqual(r.evidence[0].boundingBox,box);
});
test("adjacent separated PDF cells parse only unique candidate",()=>{
 const r=found([page(2,"Here is your quote number:\nTotal: $1500",.99,[
  {text:"Here is your quote number:",confidence:.99,boundingBox:{x:10,y:25,width:160,height:12}},
  {text:"Q12345678",confidence:.99,boundingBox:{x:180,y:25,width:100,height:12}}
 ])]);
 assert.equal(r.value,"Q12345678");
 assert.equal(r.evidence[0].page,2);
});
test("no guessed physical page when none provided",()=>{
 const r=extractAppliedQuoteNumber({text:"Quote Number: Q12345678",confidence:.99});
 assert.equal(r.value,undefined);
 assert.deepEqual(r.evidence,[]);
});
test("low-confidence duplicate holds even when a high-confidence copy exists",()=>{
 const r=found([page(1,"Quote Number: Q1234567",.99),page(2,"Quote Number: Q1234567",.7)]);
 assert.equal(r.value,undefined);
});
test("ordinary Q token without explicit Quote Number label is not enough",()=>{
 const r=found([page(1,"Applied Rating Services\nQ123456789")]);
 assert.equal(r.value,undefined);
});

test("alphabetic placeholder cannot masquerade as a Quote Number",()=>{
 const r=found([page(1,"Quote Number: QUOTENUMBER")]);
 assert.equal(r.value,undefined);
});

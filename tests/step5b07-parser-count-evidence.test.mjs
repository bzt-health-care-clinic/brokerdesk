// Synthetic layout observations only. No client PDFs or production data.
// Uses the repository parsers and real 5B-07 gate, not a replacement count parser.
import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {parseMvrLayout,parseDashLayout} from "../lib/driver-report-layout.ts";
import {analyzeDriverHistory} from "../lib/step5b07-driver-history.mjs";
const LICENCE="A11112222233333",VIN="1FA6P8TH0L5100001";
const block=(text,x,y,width=text.length*4.5,confidence=.99)=>({
 text,confidence,boundingBox:{x,y,width,height:10}});
const page=(number,blocks)=>({page:number,pageNumber:number,width:650,height:850,
 confidence:.99,blocks,text:blocks.map(b=>b.text).join("\n")});
const raw=(pages)=>({pages,text:pages.map(p=>p.text).join("\n"),confidence:.99,
 metadata:{fileId:"SYNTHETIC-COUNT-PARSER"}});
function mvr(count=0){
 return page(9,[block("MVR Abstracts",20,20),block("ONTARIO Driving Record",150,50),
  ...(count===null?[]:[block(`***Number of Convictions: ${count} ***`,140,75)]),
  block("Licence Number:",30,100),block(LICENCE,145,100),
  block("Expiry Date:",345,100),block("19/12/2030",470,100),
  block("Name:",30,125),block("ALPHA,MIRA",145,125),
  block("Birth Date:",345,125),block("12/03/1980",470,125),
  block("Class: G***",220,150),block("Reply Date: 07/10/2026",345,190)]);
}
const dashHeader=()=>page(11,[block("DRIVER REPORT",230,20),
 block("ALPHA,MIRA",30,45),block(`DLN: ${LICENCE} Ontario`,30,65),
 block("Date of Birth: 1980-03-12",30,80),block("Report Date: 2026-10-07",350,45),
 block("Number of Claims in Last 6 Years: 0",30,100)]);
const historicalClaim=()=>page(12,[block("Claim #1",30,25),
 block("Date of Loss 2018-02-03",110,25),block("SYNTHETIC INSURER",280,25),
 block("At-Fault : 100%",535,25),block("Claim #: TESTCLAIM1",30,60),
 block("Policy #: TESTPOLICY",30,80),block("Coverage: CL",350,60),
 block("Claim Status: Closed",350,80),block("Total Loss: $1234.50",30,105),
 block("Total Expense: $12.00",30,125),block(`Vehicle: 2022 SYNTHETIC CAR - ${VIN}`,30,150),
 block("First Party Driver: ALPHA,MIRA",30,180),
 block(`First Party Driver DLN: ${LICENCE} Ontario`,30,200),
 block("First Party Driver At-Fault: 100%",30,220),
 block("Third Party Driver: ******",30,250),block("Third Party Driver DLN: ******",30,270)]);
function context(parsed,pages){
 assert.ok(parsed,"Fixture must exercise the actual layout parser.");
 const bytes=Buffer.from(JSON.stringify(pages));
 const hash=createHash("sha256").update(bytes).digest("hex");
 const id=String(parsed.documentId),sectionId=`${id}-${parsed.documentType}-section`;
 const record={id,documentType:parsed.documentType,sourceHash:hash,
  logicalDocuments:[{id:sectionId,physicalFileId:id,documentType:parsed.documentType,
   presenceStatus:"FOUND",startPage:Math.min(...pages.map(p=>p.page)),
   endPage:Math.max(...pages.map(p=>p.page))}],
  packagePages:pages.map(p=>({...p,extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE"}))};
 return {record,hash,observation:{...parsed,logicalDocumentId:sectionId}};
}
const issues=ctx=>analyzeDriverHistory({drivers:[]},[ctx]).blockingIssues.map(i=>i.code);
function mvrContext(){const pages=[mvr()];return context(parseMvrLayout(raw(pages)),pages);}
test("CGI MVR parser count proof uses physical page 9 with no data.page fallback",()=>{
 const c=mvrContext();
 assert.equal(c.observation.data.page,undefined);
 assert.equal(c.observation.page,undefined);
 assert.equal(c.observation.data.reportedConvictionCount,0);
 assert.equal(c.observation.fieldEvidence.reportedConvictionCount[0].page,9);
 assert.deepEqual(issues(c),[]);
});
test("actual MVR parser proof cannot be replaced by pulledDate.page",()=>{
 const c=mvrContext();
 delete c.observation.fieldEvidence.reportedConvictionCount;
 c.observation.fieldEvidence.pulledDate=[{page:9}];
 assert(issues(c).includes("MISSING_REPORTED_COUNT_PAGE"));
});
test("actual MVR count evidence with contradictory pages is blocked",()=>{
 const c=mvrContext(),proof=c.observation.fieldEvidence.reportedConvictionCount[0];
 c.record.logicalDocuments[0].endPage=10;
 c.record.packagePages.push({...c.record.packagePages[0],page:10,pageNumber:10});
 c.observation.fieldEvidence.reportedConvictionCount.push({...proof,page:10});
 assert(issues(c).includes("CONFLICTING_REPORTED_COUNT_PAGE"));
});
test("actual MVR proof cannot cross its verified logical section",()=>{
 const c=mvrContext();
 c.observation.fieldEvidence.reportedConvictionCount[0].logicalDocumentId="OTHER-SECTION";
 assert(issues(c).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});
test("actual MVR proof cannot cross physical document or hash",()=>{
 for(const mutation of [{documentId:"OTHER-DOCUMENT"},{sourceHash:"0".repeat(64)}]){
  const c=mvrContext();
  Object.assign(c.observation.fieldEvidence.reportedConvictionCount[0],mutation);
  assert(issues(c).includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
 }
});
test("actual MVR proof on withdrawn physical page is blocked",()=>{
 const c=mvrContext();
 c.record.withdrawnSectionRanges=[{startPage:9,endPage:9}];
 assert(issues(c).includes("WITHDRAWN_REPORT_SECTION"));
});
test("MVR missing count declaration remains incomplete rather than zero",()=>{
 const pages=[mvr(null)],parsed=parseMvrLayout(raw(pages));
 assert.equal(parsed.data.reportedConvictionCount,undefined);
 assert.equal(parsed.data.convictions,undefined);
 assert(issues(context(parsed,pages)).includes("REPORT_COMPLETENESS_UNRECORDED"));
});
test("MVR contradictory count declarations do not produce clean-history proof",()=>{
 const p=mvr();
 p.blocks.push(block("***Number of Convictions: 1 ***",140,215));
 p.text=p.blocks.map(b=>b.text).join("\n");
 const parsed=parseMvrLayout(raw([p]));
 assert.equal(parsed.data.reportedConvictionCount,undefined);
 assert(parsed.warnings.some(w=>/Contradictory conviction counts/.test(w.message)));
 assert(issues(context(parsed,[p])).includes("REPORT_COMPLETENESS_UNRECORDED"));
});
test("DASH six-year zero summary does not create entire-report count or clean claims",()=>{
 const pages=[dashHeader()],parsed=parseDashLayout(raw(pages));
 assert.equal(parsed.data.reportedClaimCount,undefined);
 assert.equal(parsed.fieldEvidence.reportedClaimCount,undefined);
 assert.equal(parsed.data.claims,undefined);
 assert(parsed.warnings.some(w=>w.code==="NEEDS_REVIEW"&&w.field==="claims"));
 assert(issues(context(parsed,pages)).includes("REPORT_COMPLETENESS_UNRECORDED"));
});
test("DASH recent zero preserves historical claims and their real page evidence",()=>{
 const pages=[dashHeader(),historicalClaim()],parsed=parseDashLayout(raw(pages));
 assert.equal(parsed.data.claims.length,1);
 assert.equal(parsed.data.claims[0].loss_date,"2018-02-03");
 assert.equal(parsed.data.claims[0].driver_licence_number,LICENCE);
 assert(parsed.data.claims[0].__evidence.every(e=>e.page===12));
 assert.equal(parsed.data.reportedClaimCount,undefined);
 assert.equal(parsed.fieldEvidence.reportedClaimCount,undefined);
 assert(issues(context(parsed,pages)).includes("REPORT_COMPLETENESS_UNRECORDED"));
});
test("DASH limited summary copied to reportedClaimCount is rejected by the actual gate",()=>{
 const pages=[dashHeader()],c=context(parseDashLayout(raw(pages)),pages);
 // Simulate a wrong downstream mapper. The layout parser itself does not do this.
 c.observation.data.reportedClaimCount=0;
 c.observation.data.claims=[];
 c.observation.fieldEvidence.reportedClaimCount=[{
  page:11,text:"Number of Claims in Last 6 Years: 0",documentId:c.record.id,
  logicalDocumentId:c.observation.logicalDocumentId,sourceHash:c.hash,documentType:"DASH"}];
 const codes=issues(c);
 assert(codes.includes("LIMITED_LOOKBACK_CLAIM_COUNT"));
 assert(codes.includes("UNVERIFIED_REPORTED_COUNT_EVIDENCE"));
});

import test from "node:test";
import assert from "node:assert/strict";
import {extractPdfPage} from "../lib/pdf-page-ocr-runner.ts";
import {reusablePage} from "../lib/pdf-page-ocr-status.ts";
const makeFile=()=>new File([Uint8Array.of(1,2,3)],"page-7.jpg",{type:"image/jpeg"});
const helpers={
 needsOcr:t=>!t||t.trim().length<40,
 normalize:t=>t.replace(/\s+/g," ").trim(),
 classify:(name,mime,text)=>({documentType:text.includes("OWNERSHIP")?"OWNERSHIP":"OTHER",confidence:.95,reason:"synthetic"}),
 geometry:(ocr,layout,page)=>({width:600,height:800,blocks:[],trusted:false,reason:"Unverified OCR orientation"})
};
const goodText="SYNTHETIC VEHICLE OWNER DOCUMENT WITH ENOUGH TEXT FOR EMBEDDED PDF.";
function source({text="",blank=false,render=true}={}){
 return {
  pageCount:8,
  async embeddedPage(n){ return {page:n,width:600,height:800,text}; },
  async embeddedText(){return text},
  async isBlankPage(){return blank},
  async renderPage(){if(!render)throw Error("PDF render failed");return makeFile();},
  async close(){}
 };
}
async function run(s,extract){
 return extractPdfPage({source:s,pageNumber:7,fileName:"owner.pdf",maxOcrBytes:8*1024*1024,helpers,
    ocr:{extract:extract??(async()=>{throw Error("Should not OCR")})}});
}
test("embedded text bypasses OCR even if OCR is offline",async()=>{
 const p=await run(source({text:goodText}),async()=>{throw Error("Provider offline")});
 assert.equal(p.pageOcrStatus,"EMBEDDED_TEXT");
 assert.equal(p.extractionProvider,"embedded_pdf_text");
 assert.equal(p.page,7);
 assert.equal(reusablePage(p),true);
});
test("strict operator-empty page marked blank, does not waste OCR",async()=>{
 const p=await run(source({blank:true}),async()=>{throw Error("must not OCR blank")});
 assert.equal(p.pageOcrStatus,"BLANK_PAGE");
 assert.equal(reusablePage(p),true);
});
test("scanned textless page passes to local OCR as page 1 derivative but keeps physical page 7",async()=>{
 let calls=0;
 const p=await run(source({text:""}),async(file,opts)=>{
   calls++;
   assert.equal(opts.startPage,1);
   assert.equal(file.name,"page-7.jpg");
   return {text:"OWNERSHIP VIN 1HGBH41JXMN109186",confidence:.87,
     metadata:{provider:"local_tesseract"},
     pages:[{page:1,text:"OWNERSHIP VIN 1HGBH41JXMN109186",width:600,height:800,blocks:[]}]};
 });
 assert.equal(calls,1);
 assert.equal(p.page,7);
 assert.equal(p.pageOcrStatus,"COMPLETED");
 assert.equal(p.extractionProvider,"local_tesseract");
 assert.equal(p.classification.documentType,"OWNERSHIP");
 assert.equal(p.ocrGeometryVerified,false);
 assert.ok(p.confidence<=.5);
});
test("OCR unavailable leaves page NEEDS_OCR rather than claiming successful extraction",async()=>{
 const p=await run(source(),async()=>{throw Object.assign(new Error("Local OCR not configured"),{code:"OCR_NOT_CONFIGURED"})});
 assert.equal(p.pageOcrStatus,"NEEDS_OCR");
 assert.equal(p.extractionStatus,"FAILED");
 assert.equal(reusablePage(p),false);
});
test("OCR returned nothing is OCR_FAILED, not Blank nor No",async()=>{
 const p=await run(source(),async()=>({text:"",pages:[],metadata:{provider:"local_tesseract"}}));
 assert.equal(p.pageOcrStatus,"OCR_FAILED");
 assert.equal(p.extractionStatus,"FAILED");
});
test("OCR timeout is OCR_FAILED, eligible for retry",async()=>{
 const p=await run(source(),async()=>{throw Object.assign(new Error("timeout"),{code:"OCR_TIMEOUT"})});
 assert.equal(p.pageOcrStatus,"OCR_FAILED");
});
test("PDF rendering failure is distinguishable from OCR failure",async()=>{
 const p=await run(source({render:false}));
 assert.equal(p.pageOcrStatus,"PDF_RENDER_FAILED");
});
test("untrusted provider result must not be silently accepted",async()=>{
 const p=await run(source(),async()=>({text:"OWNERSHIP",metadata:{provider:"unknown_external_provider"}}));
 assert.equal(p.extractionStatus,"FAILED");
});
test("errors during native extraction still permit local OCR fallback",async()=>{
 const s=source();
 s.embeddedPage=async()=>{throw Error("ToUnicode failure")};
 const p=await run(s,async()=>({text:"OWNERSHIP",confidence:.75,metadata:{provider:"local_tesseract"},pages:[]}));
 assert.equal(p.extractionStatus,"COMPLETE");
 assert.equal(p.pageOcrStatus,"COMPLETED");
});
test("blank detector error never converts a scan to blank",async()=>{
 const s=source();
 s.isBlankPage=async()=>{throw Error("operator read failed")};
 const p=await run(s,async()=>{throw Object.assign(new Error("offline"),{code:"OCR_OFFLINE"})});
 assert.equal(p.pageOcrStatus,"NEEDS_OCR");
});

test("low confidence OCR stays low, never upgraded to a verified source",async()=>{
 const h={...helpers,geometry:()=>({width:600,height:800,blocks:[],trusted:true})};
 const p=await extractPdfPage({source:source(),pageNumber:7,fileName:"scanned.pdf",
   maxOcrBytes:8000000,helpers:h,ocr:{extract:async()=>({text:"possible VIN",
   confidence:.16,metadata:{provider:"local_tesseract"},pages:[{rotation:0,text:"possible VIN"}]})}});
 assert.equal(p.extractionStatus,"COMPLETE");
 assert.ok(p.confidence<.85);
 assert.equal(p.pageOcrStatus,"COMPLETED");
});

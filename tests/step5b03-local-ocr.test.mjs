import test from "node:test";
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {requestLocalTesseract, localOcrHealth, tesseractConfig, parseTesseractTsv} from "../local-server/local-tesseract.mjs";
import {pageStatus, reusablePage, pageFailures, isOcrUnavailable, ownershipNeedsSourceVerification} from "../lib/pdf-page-ocr-status.ts";

const tsv = `level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t640\t480\t-1\t
5\t1\t1\t1\t1\t1\t5\t10\t40\t20\t97.1\tVIN
5\t1\t1\t1\t1\t2\t50\t10\t200\t20\t95.2\t1HGBH41JXMN109186
5\t1\t1\t1\t2\t1\t5\t45\t60\t20\t85\tOwner`;
const file = () => new File([Uint8Array.from([137,80,78,71,13,10,26,10])],"synthetic.png",{type:"image/png"});
test("TSV preserves lines, word coordinates, confidence",()=>{
 const x=parseTesseractTsv(tsv);
 assert.equal(x.text,"VIN 1HGBH41JXMN109186\nOwner");
 assert.equal(x.width,640);
 assert.equal(x.blocks.length,3);
 assert.equal(x.blocks[1].boundingBox.x,50);
 assert.ok(x.confidence>.9);
});
test("OCR uses local executable with no shell, original input is temporary",async()=>{
 let seenPath;
 const runner=async (binary,args,opts)=>{
   assert.equal(binary,"/opt/local/tesseract");
   assert.deepEqual(args.slice(1),["stdout","-l","eng","--oem","1","--psm","3","tsv"]);
   assert.equal(opts.shell,false);
   assert.equal(opts.windowsHide,true);
   seenPath=args[0];
   assert.ok(existsSync(seenPath));
   assert.equal((await readFile(seenPath)).length,8);
   return {stdout:tsv};
 };
 const result=await requestLocalTesseract(file(),{env:{BROKERDESK_TESSERACT_EXE:"/opt/local/tesseract"},runner});
 assert.equal(result.metadata.mode,"LOCAL_ONLY");
 assert.equal(result.metadata.requiresBrokerVerification,true);
 assert.equal(result.pages[0].rotation,undefined); // no false orientation proof
 assert.equal(result.pages[0].blocks.length,3);
 assert.equal(result.text,"VIN 1HGBH41JXMN109186\nOwner");
 assert.ok(!existsSync(seenPath),"Temporary image must be erased");
});
test("malformed TSV fails",()=>assert.throws(()=>parseTesseractTsv("not tsv"),{code:"OCR_INVALID_TSV"}));
test("empty OCR output does not turn into No/clean evidence", async()=>{
 const runner=async()=>({stdout:tsv.split("\n").slice(0,2).join("\n")});
 await assert.rejects(()=>requestLocalTesseract(file(),{runner}),{code:"OCR_EMPTY_RESULT"});
});
test("invalid MIME does not reach OCR process",async()=>{
 await assert.rejects(()=>requestLocalTesseract(new File(["abc"],"f.pdf",{type:"application/pdf"})),{code:"OCR_INVALID_INPUT"});
});
test("oversized derived image rejected",async()=>{
 const huge=new File([new Uint8Array(8*1024*1024+1)],"big.jpg",{type:"image/jpeg"});
 await assert.rejects(()=>requestLocalTesseract(huge),{code:"OCR_LOCAL_SIZE_LIMIT"});
});
test("missing executable fails closed",async()=>{
 const runner=async()=>{throw Object.assign(new Error("spawn ENOENT"),{code:"ENOENT"});};
 await assert.rejects(()=>requestLocalTesseract(file(),{runner}),{code:"OCR_NOT_CONFIGURED"});
});
test("timeout fails closed",async()=>{
 const runner=async()=>{throw Object.assign(new Error("timed out"),{killed:true});};
 await assert.rejects(()=>requestLocalTesseract(file(),{runner}),{code:"OCR_TIMEOUT"});
});
test("invalid local engine path rejected",()=>assert.throws(()=>tesseractConfig({BROKERDESK_TESSERACT_EXE:"./untrusted"}),{code:"OCR_INVALID_CONFIG"}));
test("health detects local Tesseract 5 only",async()=>{
 const health=await localOcrHealth({},async(_cmd,args)=>args[0]==="--list-langs"?
   {stdout:"List of available languages (2):\neng\nosd\n"}:{stdout:"tesseract 5.5.0\n"});
 assert.equal(health.state,"ONLINE");
 assert.equal(health.mode,"LOCAL_ONLY");
 const old=await localOcrHealth({},async()=>({stderr:"tesseract 4.1.1\n"}));
 assert.equal(old.state,"DEGRADED");
});
test("health missing tool gives NOT_CONFIGURED",async()=>{
 const health=await localOcrHealth({},async()=>{throw Object.assign(new Error("not installed"),{code:"ENOENT"})});
 assert.equal(health.state,"NOT_CONFIGURED");
});
test("page diagnostic distinction",()=>{
 const basic={classification:{documentType:"OTHER",confidence:.1,reason:"test"},sourceHash:""};
 assert.equal(pageStatus({...basic,extractionStatus:"COMPLETE",extractionProvider:"embedded_pdf_text",text:"hello"}),"EMBEDDED_TEXT");
 assert.equal(pageStatus({...basic,extractionStatus:"COMPLETE",extractionProvider:"local_tesseract",text:"hello"}),"COMPLETED");
 assert.equal(pageStatus({...basic,extractionStatus:"FAILED",extractionProvider:"none",error:"cannot render pdf"}),"PDF_RENDER_FAILED");
 assert.equal(pageStatus({...basic,extractionStatus:"FAILED",extractionProvider:"none"}),"NEEDS_OCR");
});
test("blank page can be reused, failed page is retried",()=>{
 const blank={page:1,extractionStatus:"COMPLETE",pageOcrStatus:"BLANK_PAGE",text:"",extractionProvider:"embedded_pdf_text"};
 const fail={page:2,extractionStatus:"FAILED",pageOcrStatus:"NEEDS_OCR",text:"",error:"offline"};
 assert.equal(reusablePage(blank),true);
 assert.equal(reusablePage(fail),false);
 const failed=pageFailures({packagePages:[blank,fail]});
 assert.deepEqual(failed.map(p=>p.page),[2]);
});
test("offline vs failed OCR classification",()=>{
 assert.equal(isOcrUnavailable(Object.assign(new Error("Local OCR offline"),{code:"OCR_OFFLINE"})),true);
 assert.equal(isOcrUnavailable(Object.assign(new Error("timeout"),{code:"OCR_TIMEOUT"})),false);
});

test("an OCR-generated Ownership VIN never silently auto-verifies",()=>{
 const sections=[{startPage:1,endPage:1}];
 const record={packagePages:[{page:1,extractionStatus:"COMPLETE",extractionProvider:"local_tesseract",
   pageOcrStatus:"COMPLETED",text:"VIN 1HGBH41JXMN109186"}]};
 assert.equal(ownershipNeedsSourceVerification(record,sections),true);
 record.packagePages[0].extractionProvider="embedded_pdf_text";
 assert.equal(ownershipNeedsSourceVerification(record,sections),false);
 record.packagePages[0].extractionStatus="FAILED";
 assert.equal(ownershipNeedsSourceVerification(record,sections),true);
});

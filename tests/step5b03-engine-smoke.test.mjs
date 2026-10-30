import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {join,dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {localOcrHealth,requestLocalTesseract} from "../local-server/local-tesseract.mjs";
const home=dirname(fileURLToPath(import.meta.url));
test("real local Tesseract 5 reads only a synthetic test image",async(t)=>{
 const health=await localOcrHealth();
 if(health.state!=="ONLINE"){
  if(process.env.BROKERDESK_REQUIRE_REAL_TESSERACT==="1")assert.fail("Mandatory Tesseract 5 English OCR integration unavailable: "+health.state);
  t.skip("Tesseract 5 English model not installed on this machine");return;
 }
 const bytes=await readFile(join(home,"synthetic-ownership.png"));
 const result=await requestLocalTesseract(new File([bytes],"synthetic.png",{type:"image/png"}));
 assert.equal(result.metadata.provider,"local_tesseract");
 assert.equal(result.metadata.mode,"LOCAL_ONLY");
 assert.match(result.text,/SYNTHETIC/);
 assert.match(result.text,/VIN/);
 assert.ok(result.pages?.[0]?.blocks?.length>0);
});

test("rotated synthetic scan never becomes automatically VIN-verified",async(t)=>{
 const health=await localOcrHealth();
 if(health.state!=="ONLINE"){
  if(process.env.BROKERDESK_REQUIRE_REAL_TESSERACT==="1")assert.fail("Mandatory rotated Tesseract 5 OCR integration unavailable: "+health.state);
  t.skip("Tesseract 5 not installed");return;
 }
 const bytes=await readFile(join(home,"synthetic-ownership-rotated.png"));
 try {
   const result=await requestLocalTesseract(new File([bytes],"rotated.png",{type:"image/png"}));
   assert.equal(result.metadata.geometryOrientationVerified,false);
   assert.equal(result.metadata.requiresBrokerVerification,true);
 } catch(error) {
   // Tesseract may be unable to read 90-degree input: that must fail closed.
   assert.equal(error.code,"OCR_EMPTY_RESULT");
 }
});

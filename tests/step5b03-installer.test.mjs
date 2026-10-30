import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const own=dirname(fileURLToPath(import.meta.url));
const project=resolve(own,"..");
async function fixture(){
 const home=await mkdtemp(join(tmpdir(),"brokerdesk-step5b03-fixture-"));
 const raw=JSON.parse(await readFile(join(own,"fixtures","step5b03-anchor-snapshot.json"),"utf8"));
 for(const [file,text] of Object.entries(raw)){
   const path=join(home,file);
   await mkdir(dirname(path),{recursive:true});
   await writeFile(path,text);
 }
 for(const file of ["lib/pdf-page-ocr-status.ts","lib/pdf-page-ocr-runner.ts",
  "lib/local-ocr-transport.ts","local-server/local-tesseract.mjs",
  "scripts/install-step5b03.mjs"]){
    const path=join(home,file);await mkdir(dirname(path),{recursive:true});
    await copyFile(join(project,file),path);
 }
 return home;
}
function install(dir, args=[]){
 return spawnSync(process.execPath,[join(dir,"scripts/install-step5b03.mjs"),...args],
  {encoding:"utf8",timeout:12000});
}
test("dry-run, exact anchor install, re-run is idempotent",async()=>{
 const dir=await fixture();
 try{
  const before=await readFile(join(dir,"components/ingestion-panel.tsx"),"utf8");
  const dry=install(dir,["--dry-run"]);
  assert.equal(dry.status,0,dry.stderr);
  assert.equal(await readFile(join(dir,"components/ingestion-panel.tsx"),"utf8"),before);
  const installed=install(dir);
  assert.equal(installed.status,0,installed.stderr);
  const changed=await readFile(join(dir,"components/ingestion-panel.tsx"),"utf8");
  assert.match(changed,/HttpLocalTesseractTransport/);
  assert.doesNotMatch(changed,/cloudProvider|cloudTransport|runCloudOcr|OCR.Space/);
  const second=install(dir);
  assert.equal(second.status,0,second.stderr);
  assert.match(second.stdout,/Installed 0 changes/);
  assert.equal(await readFile(join(dir,"components/ingestion-panel.tsx"),"utf8"),changed);
  const parser=await readFile(join(dir,"lib/package-analysis.ts"),"utf8");
  assert.match(parser,/extractPdfPage/);
  assert.match(parser,/reusablePage/);
  const server=await readFile(join(dir,"local-server/server.mjs"),"utf8");
  assert.match(server,/\/local-ocr\/health/);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test("a missing source anchor aborts all edits",async()=>{
 const dir=await fixture();
 try {
   const target=join(dir,"lib/document-ocr-ui.ts");
   await writeFile(target,(await readFile(target,"utf8")).replace("Regenerate OCR (uses quota)","changed upstream"));
   const baseline=await readFile(join(dir,"lib/package-analysis.ts"),"utf8");
   const result=install(dir,["--dry-run"]);
   assert.notEqual(result.status,0);
   assert.match(result.stderr,/expected one anchor/);
   assert.equal(await readFile(join(dir,"lib/package-analysis.ts"),"utf8"),baseline);
 }finally{await rm(dir,{recursive:true,force:true})}
});

// Execute the cache-scheduling loop emitted by the installer, then the real
// extractPdfPage worker with a synthetic PDF adapter. This is a scheduling unit
// regression, not a substitute for the repository's tests/layout-parsers.mjs.
async function installedCacheLoop() {
 const dir=await fixture();
 try{
  const result=install(dir);
  assert.equal(result.status,0,result.stderr);
  const code=await readFile(join(dir,"lib/package-analysis.ts"),"utf8");
  const start=code.indexOf("  for (let page = 1;");
  const end=code.indexOf("\n",start);
  assert(start>=0&&end>start,"One emitted single-line page-cache scheduling loop is required.");
  return new Function("source","existing","options","reusablePage",
   "const pages=[],pending=[];"+code.slice(start,end)+";return {pages,pending};");
 }finally{await rm(dir,{recursive:true,force:true});}
}
const cacheText="SYNTHETIC NATIVE PDF PAGE WITH ENOUGH TEXT TO AVOID OCR.";
const cacheBlock={text:cacheText,confidence:.99,boundingBox:{x:20,y:20,width:400,height:12}};
const cachedPage=(extra={})=>({page:1,pageNumber:1,text:cacheText,
 confidence:.99,extractionProvider:"embedded_pdf_text",extractionStatus:"COMPLETE",
 classification:{documentType:"OTHER",confidence:1,reason:"synthetic"},...extra});
async function exerciseCache(cache,{geometry=true,force=false,pageCount=1}={}) {
 const {reusablePage}=await import("../lib/pdf-page-ocr-status.ts");
 const {extractPdfPage}=await import("../lib/pdf-page-ocr-runner.ts");
 let nativeReads=0,ocrCalls=0;
 const source={pageCount,
   ...(geometry?{async embeddedPage(n){nativeReads++;return {
     page:n,pageNumber:n,text:cacheText,width:600,height:800,blocks:[cacheBlock]};}}:{}),
   async embeddedText(){nativeReads++;return cacheText;},
   async renderPage(){throw Error("Native pages must not be rendered for OCR.");}
 };
 const schedule=(await installedCacheLoop())(source,new Map(cache.map(p=>[p.page,p])),{force},reusablePage);
 for(const n of schedule.pending) schedule.pages.push(await extractPdfPage({
   source,pageNumber:n,fileName:"SYNTHETIC.pdf",maxOcrBytes:1000000,
   ocr:{async extract(){ocrCalls++;throw Error("Native refresh must not call OCR.");}},
   helpers:{needsOcr:t=>!t||t.trim().length<40,normalize:t=>t,
    classify:()=>({documentType:"OTHER",confidence:1,reason:"synthetic"}),
    geometry:()=>({trusted:false})}
 }));
 return {...schedule,nativeReads,ocrCalls};
}
test("layout cache: old native text without blocks is re-extracted once without OCR",async()=>{
 for(const blocks of [undefined,[]]){
  const out=await exerciseCache([cachedPage({blocks})]);
  assert.deepEqual(out.pending,[1]);
  assert.equal(out.nativeReads,1);
  assert.equal(out.ocrCalls,0);
  assert(out.pages[0].blocks.length>0);
  const repeated=await exerciseCache(out.pages);
  assert.deepEqual(repeated.pending,[]);
  assert.equal(repeated.nativeReads,0,"Do not repeat a successful layout refresh.");
  assert.equal(repeated.ocrCalls,0);
 }
});
test("layout cache: native page with layout is reused",async()=>{
 const p=cachedPage({blocks:[cacheBlock]});
 const out=await exerciseCache([p]);
 assert.deepEqual(out.pending,[]);assert.equal(out.pages[0],p);
 assert.equal(out.nativeReads,0);assert.equal(out.ocrCalls,0);
});
test("layout cache: explicitly confirmed blank page is reused without geometry or OCR",async()=>{
 const p=cachedPage({text:"",pageOcrStatus:"BLANK_PAGE"});
 const out=await exerciseCache([p]);
 assert.deepEqual(out.pending,[]);assert.equal(out.pages[0],p);
 assert.equal(out.nativeReads,0);assert.equal(out.ocrCalls,0);
});
test("layout cache: completed non-embedded OCR caches are not OCRed again",async()=>{
 for(const extractionProvider of ["local_tesseract","ocr_space","paddle_ocr"]){
  const p=cachedPage({extractionProvider,pageOcrStatus:"COMPLETED"});
  const out=await exerciseCache([p]);
  assert.deepEqual(out.pending,[]);assert.equal(out.pages[0],p);
  assert.equal(out.nativeReads,0);assert.equal(out.ocrCalls,0);
 }
});
test("layout cache: adapter without embedded geometry keeps text-only behavior",async()=>{
 const p=cachedPage();
 const out=await exerciseCache([p],{geometry:false});
 assert.deepEqual(out.pending,[]);assert.equal(out.pages[0],p);
 assert.equal(out.nativeReads,0);
});
test("layout cache: failed and missing pages still require extraction",async()=>{
 for(const cache of [[],[cachedPage({extractionStatus:"FAILED",pageOcrStatus:"BLANK_PAGE"})]]){
  const out=await exerciseCache(cache);
  assert.deepEqual(out.pending,[1]);assert.equal(out.nativeReads,1);
 }
});
test("layout cache: force continues to bypass valid caches",async()=>{
 const out=await exerciseCache([cachedPage({blocks:[cacheBlock]})],{force:true});
 assert.deepEqual(out.pending,[1]);assert.equal(out.nativeReads,1);
});
test("layout cache: refresh only the stale physical page in a mixed cache",async()=>{
 const p1=cachedPage({extractionProvider:"local_tesseract",pageOcrStatus:"COMPLETED"});
 const p2=cachedPage({page:2,pageNumber:2});
 const p3=cachedPage({page:3,pageNumber:3,text:"",pageOcrStatus:"BLANK_PAGE"});
 const out=await exerciseCache([p1,p2,p3],{pageCount:3});
 assert.deepEqual(out.pending,[2]);assert.equal(out.nativeReads,1);assert.equal(out.ocrCalls,0);
 assert.equal(out.pages.find(p=>p.page===1),p1);assert.equal(out.pages.find(p=>p.page===3),p3);
 const refreshed=out.pages.find(p=>p.page===2);
 assert.equal(refreshed.pageNumber,2);assert(refreshed.blocks.length>0);
});

test("layout cache: text blocks without usable coordinates must be re-extracted",async()=>{
 const invalidBlocks=[
  [{text:cacheText}],
  [{text:cacheText,boundingBox:{x:20,y:20,width:400}}],
  [{text:cacheText,boundingBox:{x:NaN,y:20,width:400,height:12}}],
  [{text:cacheText,boundingBox:{x:20,y:Infinity,width:400,height:12}}],
  [{text:cacheText,boundingBox:{x:20,y:20,width:0,height:12}}],
  [{text:cacheText,boundingBox:{x:20,y:20,width:400,height:-1}}],
  [{text:" \t",boundingBox:{x:20,y:20,width:400,height:12}}]
 ];
 for(const blocks of invalidBlocks) {
  const out=await exerciseCache([cachedPage({blocks})]);
  assert.deepEqual(out.pending,[1],"Nonempty blocks alone are not usable PDF geometry.");
  assert.equal(out.nativeReads,1);
  assert.equal(out.ocrCalls,0);
  assert(out.pages[0].blocks[0].boundingBox);
 }
});
test("layout cache: coordinates at the page origin remain valid",async()=>{
 const p=cachedPage({blocks:[{...cacheBlock,boundingBox:{x:0,y:0,width:400,height:12}}]});
 const out=await exerciseCache([p]);
 assert.deepEqual(out.pending,[]);
 assert.equal(out.pages[0],p);
 assert.equal(out.nativeReads,0);
});

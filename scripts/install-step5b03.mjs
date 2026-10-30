#!/usr/bin/env node
/**
 * Step 5B-03 anchored installer, after Step 5B-01 and 5B-02.
 * Validates ALL source edits before any writes; --dry-run never writes.
 * Does not install binaries or upload files. Preserve default v0.3.
 */
import { readFileSync as nativeReadFileSync, existsSync, writeFileSync as nativeWriteFileSync, renameSync, unlinkSync } from "node:fs";
// Installer-only newline adapter: exact anchors are checked against Git-blob LF,
// while original Windows CRLF source bytes are preserved on writes and rollback.
const sourceNewlines = new Map();
const sourceKey = path => String(path).replace(/\.step5b\d{2}\.tmp$/, "");
function readFileSync(path, ...args) {
  const value = nativeReadFileSync(path, ...args);
  if (typeof value !== "string") return value;
  sourceNewlines.set(sourceKey(path), value.includes("\r\n") ? "\r\n" : "\n");
  return value.replace(/\r\n/g, "\n");
}
function writeFileSync(path, value, ...args) {
  const ending = sourceNewlines.get(sourceKey(path));
  const source = ending === "\r\n" && typeof value === "string"
    ? value.replace(/\r?\n/g, "\r\n") : value;
  return nativeWriteFileSync(path, source, ...args);
}

import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const dry=process.argv.includes("--dry-run");
const marker="Step 5B-03";
function one(text, from, to, label) {
  const count=text.split(from).length-1;
  if(count!==1)throw new Error(`${label}: expected one anchor, found ${count}. No changes applied.`);
  return text.replace(from,to);
}
function span(text, start, end, replacement, label) {
  const startAt=text.indexOf(start);
  if(startAt===-1 || text.indexOf(start,startAt+1)!==-1)
    throw new Error(`${label}: worker start missing/ambiguous.`);
  const endAt=text.indexOf(end,startAt+start.length);
  if(endAt===-1 || text.indexOf(end,endAt+end.length)!==-1)
    throw new Error(`${label}: worker end missing/ambiguous.`);
  return text.slice(0,startAt)+replacement+text.slice(endAt+end.length);
}
const patches=[
["lib/extraction-types.ts", text => one(text,
  'extractionProvider: "embedded_pdf_text" | "ocr_space" | "paddle_ocr" | "none"; extractionStatus: "COMPLETE" | "FAILED";',
  `extractionProvider: "embedded_pdf_text" | "ocr_space" | "paddle_ocr" | "local_tesseract" | "none"; extractionStatus: "COMPLETE" | "FAILED"; /** Step 5B-03, supplementary page diagnostic; legacy status preserved */ pageOcrStatus?: import("./pdf-page-ocr-status.ts").PageOcrStatus;`,
  "Page OCR types")],
["lib/browser-pdf-adapter.ts", text => one(text,
  '      pageCount: pdfDocument.numPages,',
  `      pageCount: pdfDocument.numPages,
      // Step 5B-03: only zero PDF rendering operators qualify as a known blank.
      // A white-looking scan is NOT assumed blank; it still needs OCR.
      async isBlankPage(pageNumber) {
        const page=await pdfDocument.getPage(pageNumber);
        const operators=await page.getOperatorList();
        return operators.fnArray.length===0;
      },`,
  "PDF conservatively blank detection")],
["lib/package-analysis.ts", text => {
  text=one(text,
    'import { trustedOcrPage } from "./ocr-page-geometry.ts";',
    'import { trustedOcrPage } from "./ocr-page-geometry.ts";\nimport { reusablePage } from "./pdf-page-ocr-status.ts"; // Step 5B-03\nimport { extractPdfPage } from "./pdf-page-ocr-runner.ts";',
    "Page status imports");
  text=one(text,
    'embeddedText(page: number): Promise<string>; renderPage(page: number, targetBytes: number): Promise<File>; close(): Promise<void> | void;',
    'embeddedText(page: number): Promise<string>; isBlankPage?(page: number): Promise<boolean>; renderPage(page: number, targetBytes: number): Promise<File>; close(): Promise<void> | void;',
    "Adapter blank page interface");
  text=one(text,
    'if (!options.force && cached?.extractionStatus === "COMPLETE" && (!source.embeddedPage || cached.extractionProvider !== "embedded_pdf_text" || Boolean(cached.blocks?.length))) pages.push(cached); else pending.push(page);',
    'if (!options.force && cached && reusablePage(cached) && (!source.embeddedPage || cached.extractionProvider !== "embedded_pdf_text" || Boolean(cached.blocks?.some(block => Boolean(block.text?.trim()) && block.boundingBox && [block.boundingBox.x, block.boundingBox.y, block.boundingBox.width, block.boundingBox.height].every(Number.isFinite) && block.boundingBox.width > 0 && block.boundingBox.height > 0)) || cached.pageOcrStatus === "BLANK_PAGE")) pages.push(cached); else pending.push(page);',
    "Retry only incomplete pages");
  // Preserve existing counters while counting any installed local OCR provider.
  text=one(text,
    'ocr: pages.filter((page) => page.extractionProvider === "ocr_space").length, failed:',
    'ocr: pages.filter((page) => ["ocr_space","paddle_ocr","local_tesseract"].includes(page.extractionProvider)).length, failed:',
    "Interim OCR progress");
  const start='    let cursor = 0; const worker = async () => {';
  const end='    await Promise.all(Array.from({ length: Math.max(1, Math.min(2, options.concurrency ?? 1, pending.length || 1)) }, worker));';
  text=span(text,start,end,`
    // Step 5B-03: retry only missing pages; do not alter original file bytes.
    let cursor=0;
    const worker=async()=>{
      while(cursor<pending.length){
        const pageNumber=pending[cursor++];
        const result=await extractPdfPage({source,pageNumber,fileName:record.fileName,
          ocr,maxOcrBytes:options.maxOcrBytes,
          helpers:{needsOcr:embeddedTextNeedsOcr,normalize:normalizeOcrText,
            classify:classifyDocument,geometry:trustedOcrPage}});
        pages.push(result);
        await persist();
      }
    };
    await Promise.all(Array.from({length:Math.max(1,Math.min(2,options.concurrency??1,pending.length||1))},worker));
`, "Page worker");
  text=one(text,
    '(page.extractionProvider === "ocr_space" || page.extractionProvider === "paddle_ocr") && !page.ocrGeometryVerified',
    '(["ocr_space","paddle_ocr","local_tesseract"].includes(page.extractionProvider)) && (!page.ocrGeometryVerified || (page.confidence ?? 0) < .85)',
    "Untrusted local OCR requires review");
  text=one(text,
    'packageProgress: { status: failed ? "PARTIAL" : "COMPLETE",',
    'packageProgress: { status: failed ? "PARTIAL" : "COMPLETE",',
    "Status anchor"); // same string, marker elsewhere guarantees change
  return text;
}],
["lib/document-ocr-ui.ts", text => {
  text=one(text,
    'import { hasReusableText, savedText } from "./local-reparse.ts";',
    'import { hasReusableText, savedText } from "./local-reparse.ts";\nimport { reusablePage } from "./pdf-page-ocr-status.ts"; // Step 5B-03',
    "UI retry imports");
  text=one(text,
    '  const reusable = hasReusableText(record);\n  const pages = record.packagePages ?? [];',
    '  const pages = record.packagePages ?? [];\n  const reusable = hasReusableText(record) || (pages.length>0 && pages.every(reusablePage));',
    "OCR blank pages are complete");
  text=one(text,
    'pages.some(p => p.extractionStatus !== "COMPLETE" || !p.text?.trim())',
    'pages.some(p => !reusablePage(p))',
    "Partial page determination");
  text=one(text,
    'record.raw?.metadata?.provider === "ocr_space" || pages.some(p => p.extractionProvider === "ocr_space" || p.extractionProvider === "paddle_ocr")',
    'record.raw?.metadata?.provider === "local_tesseract" || pages.some(p => ["ocr_space","paddle_ocr","local_tesseract"].includes(p.extractionProvider))',
    "Recognize local OCR");
  text=one(text,
    'regenerateLabel: "Regenerate OCR (uses quota)",',
    'regenerateLabel: "Regenerate OCR (local CPU)",',
    "Local OCR label");
  return text;
}],
["lib/broker-file-intake.ts", text => {
  text=one(text,
    'import { currentPhysicalFile, sectionWithdrawn } from "./ownership-receipt.ts";',
    'import { currentPhysicalFile, sectionWithdrawn } from "./ownership-receipt.ts";\nimport { ownershipNeedsSourceVerification } from "./pdf-page-ocr-status.ts"; // Step 5B-03',
    "Ownership page proof import");
  return one(text,
    '    const parsed=activeParsedSources(record);\n    return sections.some(section=>{',
    `    // OCR is derived data, not VIN attestation. Never silently auto-verify.
    if (ownershipNeedsSourceVerification(record,sections)) return false;
    const parsed=activeParsedSources(record);
    return sections.some(section=>{`,
    "Scanned Ownership cannot auto-verify a VIN");
}],
["local-server/server.mjs", text => {
  text=one(text,
    'import { ocrSpaceHealth, requestOcrSpace } from "./ocr-space.mjs";',
    'import { ocrSpaceHealth, requestOcrSpace } from "./ocr-space.mjs";\nimport { localOcrHealth, requestLocalTesseract } from "./local-tesseract.mjs"; // Step 5B-03',
    "Local OCR server import");
  return one(text,
    '    if (request.method === "GET" && url.pathname === "/ocr-space/health")',
    `    if (request.method === "GET" && url.pathname === "/local-ocr/health")
      return sendJson(response,request,200,await localOcrHealth());
    if (request.method === "POST" && url.pathname === "/local-ocr") {
      const form=await readForm(request);
      const file=form.get("file");
      try { return sendJson(response,request,200,await requestLocalTesseract(file)); }
      catch(error) { return sendJson(response,request,error.status||502,
        {error:error.message,code:error.code||"OCR_LOCAL_FAILED"}); }
    }
    if (request.method === "GET" && url.pathname === "/ocr-space/health")`,
    "Local OCR routes");
}],
["components/ingestion-panel.tsx", text => {
  text=one(text,
    'import { documentOcrUi } from "@/lib/document-ocr-ui";',
    'import { documentOcrUi } from "@/lib/document-ocr-ui";\nimport { HttpLocalTesseractTransport, LocalTesseractProvider } from "@/lib/local-ocr-transport";\nimport { PAGE_OCR_LABELS, pageStatus, reusablePage } from "@/lib/pdf-page-ocr-status"; // Step 5B-03',
    "Ingestion local OCR import");
  text=one(text,
    'import { EmbeddedPdfTextProvider, HttpOcrSpaceTransport, HttpPaddleOcrTransport, OcrServerHealth, OcrSpaceProvider, OptionalAzureDocumentProvider, PaddleOcrProvider, RoutingDocumentExtractor } from "@/lib/ocr-providers";',
    'import { EmbeddedPdfTextProvider, OcrServerHealth, RoutingDocumentExtractor } from "@/lib/ocr-providers";',
    "Remove obsolete cloud OCR imports");
  text=one(text,
    '  const ocrTransport = useMemo(() => new HttpPaddleOcrTransport(), []);\n  const cloudTransport = useMemo(() => new HttpOcrSpaceTransport(), []);\n  const cloudProvider = useMemo(() => new OcrSpaceProvider(store, cloudTransport), [store, cloudTransport]);\n  const extractor = useMemo(() => new RoutingDocumentExtractor([new LocalTextProvider(store), new EmbeddedPdfTextProvider(store), cloudProvider, new PaddleOcrProvider(store, ocrTransport), new OptionalAzureDocumentProvider()]), [store, cloudProvider, ocrTransport]);',
    `  // Step 5B-03: local Tesseract only; existing cloud routes are not called.
  const localTransport=useMemo(()=>new HttpLocalTesseractTransport(),[]);
  const extractor=useMemo(()=>new RoutingDocumentExtractor([
    new LocalTextProvider(store),new EmbeddedPdfTextProvider(store),
    new LocalTesseractProvider(store,localTransport)
  ]),[store,localTransport]);`,
    "Private local routing");
  text=one(text,
    'const timer = window.setTimeout(() => { void cloudTransport.health().then(setOcrHealth)',
    'const timer = window.setTimeout(() => { void localTransport.health().then(setOcrHealth)',
    "Local OCR health polling");
  text=one(text,
    '}, [cloudTransport]);',
    '}, [localTransport]);',
    "Local transport effect");
  text=one(text,
    'currentHealth = await cloudTransport.health()',
    'currentHealth = await localTransport.health()',
    "Upload OCR health");
  text=one(text,
    '      cloudProvider.setAutoEnabled(autoOcr && currentHealth.state === "ONLINE");',
    '      // Local OCR is used only for unreadable pages; no cloud fallback.',
    "Disable automatic cloud");
  text=one(text,
    `if (!autoOcr || currentHealth.state !== "ONLINE") throw new Error("OCR.Space is unavailable; embedded pages remain usable and scanned pages can be retried."); return cloudTransport.extract(page, { pageCount: 1 });`,
    `if (!autoOcr || currentHealth.state !== "ONLINE") throw Object.assign(new Error("Local OCR is not configured or offline."),{code:"OCR_NOT_CONFIGURED"}); return localTransport.extract(page);`,
    "PDF upload OCR callback");
  text=one(text,
    '      cloudProvider.setAutoEnabled(false);',
    '      // No external OCR provider is enabled.',
    "Local OCR cleanup");
  text=one(text,
    '  async function runCloudOcr(record: UploadedDocumentRecord, force = false) {',
    '  async function runLocalOcr(record: UploadedDocumentRecord, force = false) {',
    "Local OCR action");
  text=one(text,
    'record.packagePages?.some(p => p.extractionStatus !== "COMPLETE" || !p.text?.trim())',
    'record.packagePages?.some(p => !reusablePage(p))',
    "Smart manual OCR retry");
  text=one(text,
    '    if (ocrHealth.state === "NOT_CONFIGURED") { window.alert("OCR.Space is not configured. Configure it on the local server and restart BrokerDesk."); return; }',
    '    if (ocrHealth.state !== "ONLINE") { window.alert("Local Tesseract OCR is not available. Install Tesseract 5 and restart BrokerDesk."); return; }',
    "Local OCR status");
  text=one(text,
    'const updated = await analyzePdfPackage(record, file, pdfAdapter, cloudTransport,',
    'const updated = await analyzePdfPackage(record, file, pdfAdapter, localTransport,',
    "PDF reprocessing local transport");
  text=one(text,
    '    const section = record.logicalDocuments?.find((item) => item.presenceStatus === "FOUND"); cloudProvider.enableOnce(record.id, { pageCount: record.pageCount, startPage: section?.startPage, endPage: section?.endPage }); setOcrProcessingId(record.id);',
    '    setOcrProcessingId(record.id);',
    "Local image OCR instead of cloud enable");
  text=one(text,
    'OCR.Space · {label(ocrHealth.state)}',
    'Local Tesseract OCR · {label(ocrHealth.state)}',
    "Local OCR label");
  text=one(text,
    '"Cloud Test Provider · 1 MB / 3 pages default"',
    '"Local CPU · scanned pages only · no cloud upload"',
    "Local engine info");
  text=one(text,
    '"Configure OCR.Space on the local server to enable test OCR"',
    '"Install Tesseract 5 on this Windows PC"',
    "Local engine setup");
  text=one(text,
    'cloudTransport.health().then(setOcrHealth)',
    'localTransport.health().then(setOcrHealth)',
    "Refresh local health");
  text=one(text,
    'onClick={() => void runCloudOcr(record)',
    'onClick={() => void runLocalOcr(record)',
    "Use local OCR button");
  text=one(text,
    'onClick={() => void runCloudOcr(record, true)',
    'onClick={() => void runLocalOcr(record, true)',
    "Use local regenerate button");
  text=one(text,
    '        <div className="document-meta">',
    `        {record.packagePages?.length ? <details className="page-extraction-details">
          <summary>Page status / retry details</summary>
          <div>{record.packagePages.map(page=><div key={page.page}>
            <strong>Page {page.page}: {PAGE_OCR_LABELS[pageStatus(page)]}</strong>
            {page.extractionStatus==="FAILED"&&page.error?<small> — {page.error}</small>:null}
          </div>)}</div>
        </details>:null}
        <div className="document-meta">`,
    "Individual page statuses");
  return text;
}]
];
const plan=[];
for(const [rel,patch] of patches){
  const target=resolve(projectRoot,rel);
  if(!target.startsWith(projectRoot+sep) || !existsSync(target))
    throw new Error(`Required source not found: ${rel}. No changes applied.`);
  const before=readFileSync(target,"utf8");
  const already=before.includes(marker);
  const after=already?before:patch(before);
  if(!already && after===before)throw new Error(`No changes for ${rel}`);
  plan.push({rel,target,before,after,already});
}
for(const rel of ["lib/pdf-page-ocr-status.ts","lib/pdf-page-ocr-runner.ts","lib/local-ocr-transport.ts","local-server/local-tesseract.mjs"]){
  if(!existsSync(resolve(projectRoot,rel)))
    throw new Error(`Extract cumulative ZIP before installation: ${rel}`);
}
console.log(`${dry?"DRY RUN":"INSTALL"} Step 5B-03`);
for(const p of plan)console.log(`  ${p.already?"already installed":"validated"} ${p.rel}`);
if(dry)process.exit(0);
const changed=plan.filter(p=>!p.already);
try{
  for(const p of changed){
    const temp=p.target+".step5b03.tmp";
    writeFileSync(temp,p.after,"utf8");renameSync(temp,p.target);
  }
}catch(cause){
  for(const p of changed){
    try{writeFileSync(p.target,p.before,"utf8");}catch{}
    try{unlinkSync(p.target+".step5b03.tmp");}catch{}
  }
  throw cause;
}
console.log(`Installed ${changed.length} changes. CI deferred until cumulative Step 5B validation.`);

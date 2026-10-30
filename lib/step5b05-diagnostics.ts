/**
 * Step 5B-05 — evidence-backed PDF/OCR diagnostics.
 * Derive statuses from saved execution artifacts only. Missing older metadata
 * is UNRECORDED, never silently turned into a failed request or "parser none".
 * This module is display-only; it never mutates classification, parser data
 * or any evidence and it never enables a blocked submission.
 */
import type { UploadedDocumentRecord } from "./extraction-types.ts";

type Loose = Record<string, unknown>;
const obj=(value:unknown):Loose =>
  value&&typeof value==="object"&&!Array.isArray(value)?value as Loose:{};
const items=(value:unknown):Loose[] =>
  Array.isArray(value)?value.map(obj):[];
const text=(value:unknown)=>typeof value==="string"?value:"";
const count=(value:unknown):number =>
  Object.values(obj(value)).filter(v=>v!==null&&v!==undefined&&v!=="" &&
    !(Array.isArray(v)&&v.length===0)).length;
const OCR_PROVIDERS = /(?:ocr|tesseract|paddle|azure)/i;
function pageStatus(p:Loose):string{
  const explicit=text(p.diagnosticStatus||p.pageDiagnosticStatus);
  if (["EMBEDDED_TEXT","BLANK_PAGE","NEEDS_OCR","OCR_FAILED",
    "PDF_RENDER_FAILED","COMPLETED"].includes(explicit)) return explicit;
  const provider=text(p.extractionProvider);
  const status=text(p.extractionStatus);
  const error=text(p.error);
  if (/render/i.test(error)&&status==="FAILED")return "PDF_RENDER_FAILED";
  if (status==="COMPLETE") {
    if(OCR_PROVIDERS.test(provider))return "COMPLETED";
    return text(p.text).trim()?"EMBEDDED_TEXT":"BLANK_PAGE";
  }
  if (status==="FAILED"&&OCR_PROVIDERS.test(provider))return "OCR_FAILED";
  if (status==="FAILED")return "NEEDS_OCR";
  return "NEEDS_OCR";
}
export function buildDocumentDiagnostics(record:UploadedDocumentRecord){
  const r=record as unknown as Loose;
  const raw=obj(r.raw), metadata=obj(raw.metadata);
  const pages=items(r.packagePages);
  const sources=items(r.parsedSources);
  if (!sources.length&&r.parsed)sources.push(obj(r.parsed));
  const sections=items(r.logicalDocuments);
  const steps=pages.map(p=>({
    page:Number(p.page??p.pageNumber)||0,
    state:pageStatus(p),
    provider:text(p.extractionProvider)||"UNRECORDED",
    reason:text(p.error)||null
  })).sort((a,b)=>a.page-b.page);
  const ocrPages=steps.filter(p=>p.provider!=="UNRECORDED"&&OCR_PROVIDERS.test(p.provider));
  const ocrAttempt=metadata.requestSucceeded;
  const ocrRequestStatus=typeof ocrAttempt==="boolean" ?
    (ocrAttempt?"SUCCEEDED":"FAILED") :
    ocrPages.length?
      (ocrPages.some(p=>p.state==="OCR_FAILED")?"FAILED":
        ocrPages.every(p=>p.state==="COMPLETED")?"SUCCEEDED":"UNRECORDED"):
    (pages.length&&steps.every(p=>["EMBEDDED_TEXT","BLANK_PAGE"].includes(p.state))?
      "NOT_REQUESTED":"UNRECORDED");
  const parserRuns=sources.map(s=>({
    logicalDocumentId: text(s.logicalDocumentId)||null,
    documentType:text(s.documentType)||"UNRECORDED",
    parser: text(s.parserInvoked)||text(s.documentType)||"UNRECORDED",
    status:"PARSED",
    fieldCount:count(s.data)+items(s.entities).reduce((n,e)=>n+count(e.data),0),
  }));
  const parserSections=sections.map(s=>{
    const matched=parserRuns.filter(p=>p.logicalDocumentId===s.id);
    return {
      logicalDocumentId:text(s.id)||null,
      documentType:text(s.documentType)||"UNRECORDED",
      pages:{start:s.startPage??null,end:s.endPage??s.startPage??null},
      parser:matched.length?matched.map(x=>x.parser).join(", "):"UNRECORDED",
      status:matched.length?"PARSED":"UNRECORDED",
      parseStatus:s.parseStatus??"UNRECORDED",
      validationStatus:s.validationStatus??"UNRECORDED",
    };
  });
  const covered=new Set(parserSections.map(s=>s.logicalDocumentId));
  const orphaned=parserRuns.filter(p=>!covered.has(p.logicalDocumentId));
  const failed=steps.filter(p=>["OCR_FAILED","PDF_RENDER_FAILED"].includes(p.state)).map(p=>p.page);
  const pending=steps.filter(p=>p.state==="NEEDS_OCR").map(p=>p.page);
  return {
    schemaVersion:1,
    containerClassification:text(r.documentType)||"UNRECORDED",
    fileClassification:text(obj(r.classification).documentType)||"UNRECORDED",
    ocrRequestStatus, ocrProvider:text(metadata.provider)||null,
    pageCount:Number(r.pageCount??pages.length)||0,
    pageStates:steps,
    failedPageNumbers:failed,needsOcrPageNumbers:pending,
    logicalDocuments:[...parserSections,...orphaned.map(s=>({
      logicalDocumentId:s.logicalDocumentId,documentType:s.documentType,
      parser:s.parser,status:s.status,pages:null,
      parseStatus:"UNRECORDED",validationStatus:"UNRECORDED"
    }))],
    finalParsedFieldCount:parserRuns.reduce((sum,p)=>sum+p.fieldCount,0),
    fieldCountMeaning:"Number of saved structured observations, not correctness or accuracy.",
    reviewReasons:[
      ...(pending.length?[`${pending.length} page(s) still need OCR or manual classification.`]:[]),
      ...(failed.length?[`${failed.length} page(s) failed OCR/PDF rendering.`]:[]),
      ...(text(r.error)?[text(r.error)]:[]),
      ...(sections.some(s=>s.validationStatus==="NEEDS_REVIEW")?
        ["At least one logical section requires review."]:[])
    ]
  };
}

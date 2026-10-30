import type { PackagePage, UploadedDocumentRecord, LogicalDocument } from "./extraction-types.ts";

export type PageOcrStatus = "EMBEDDED_TEXT" | "BLANK_PAGE" | "NEEDS_OCR" |
  "OCR_FAILED" | "PDF_RENDER_FAILED" | "COMPLETED";
export const PAGE_OCR_LABELS:Record<PageOcrStatus,string> = {
  EMBEDDED_TEXT:"Embedded text",
  BLANK_PAGE:"Blank page",
  NEEDS_OCR:"Needs OCR",
  OCR_FAILED:"OCR failed",
  PDF_RENDER_FAILED:"PDF render failed",
  COMPLETED:"Completed"
};
export function pageStatus(page:PackagePage):PageOcrStatus {
  if (page.pageOcrStatus) return page.pageOcrStatus;
  if(page.extractionStatus==="COMPLETE")return page.extractionProvider==="embedded_pdf_text"?"EMBEDDED_TEXT":"COMPLETED";
  if(/render/i.test(page.error??""))return "PDF_RENDER_FAILED";
  return "NEEDS_OCR";
}
export function reusablePage(page:PackagePage|undefined) {
  if(!page || page.extractionStatus!=="COMPLETE") return false;
  if(pageStatus(page)==="BLANK_PAGE")return true;
  return Boolean(page.text?.trim());
}
export function pageFailures(record:UploadedDocumentRecord) {
  return (record.packagePages??[])
    .filter(p=>!reusablePage(p))
    .map(p=>({page:p.page,status:pageStatus(p),reason:p.error??"Page needs extraction"}));
}
export function isOcrUnavailable(error:unknown){
  const code=typeof error==="object" && error && "code" in error ? String(error.code):"";
  return ["OCR_NOT_CONFIGURED","OCR_OFFLINE","OCR_SERVER_OFFLINE"].includes(code) ||
    /not configured|not found|offline|unavailable/i.test(error instanceof Error?error.message:String(error));
}

/** A machine-recognized VIN is not a Broker source-bound Ownership attestation. */
export function ownershipNeedsSourceVerification(record:UploadedDocumentRecord, sections:LogicalDocument[]){
  return (record.packagePages??[]).some(page =>
    sections.some(section => page.page >= (section.startPage??1) &&
      page.page <= (section.endPage??section.startPage??1)) &&
    (page.extractionStatus!=="COMPLETE" ||
      page.extractionProvider!=="embedded_pdf_text"));
}

import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { hasReusableText, savedText } from "./local-reparse.ts";

export function documentOcrUi(record: UploadedDocumentRecord, providerState: string, busy = false) {
  const pdf = record.mimeType === "application/pdf" || /\.pdf$/i.test(record.fileName);
  const supportsOcr = pdf || record.mimeType.startsWith("image/") || /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(record.fileName);
  const reusable = hasReusableText(record);
  const pages = record.packagePages ?? [];
  const failedPages = pages.filter(page=>page.extractionStatus!=="COMPLETE" ||
    !page.text?.trim()).map(page=>page.pageNumber??page.page)
    .filter(page=>Number.isInteger(page)).sort((left,right)=>left-right);
  const expectedPages=record.pageCount??record.packageProgress?.total??pages.length;
  const missingPageCount=Math.max(0,expectedPages-pages.length);
  const partial = Boolean(record.packageProgress?.status === "PARTIAL" || pages.length && (pages.some(p => p.extractionStatus !== "COMPLETE" || !p.text?.trim()) || pages.length < (record.pageCount ?? record.packageProgress?.total ?? pages.length)));
  const needsExtraction = !reusable || partial;
  const unavailable = providerState !== "ONLINE";
  const missingFile = record.currentSourceHash === "MISSING";
  const processing = busy || record.packageProgress?.status === "ANALYZING";
  const results = record.parsedSources?.length ? record.parsedSources : record.parsed ? [record.parsed] : [];
  const fieldCount = results.reduce((sum, result) => sum + Object.values(result.data).filter(v => v !== undefined && v !== null && v !== "").length, 0);
  const reviewCount = results.reduce((sum, result) => sum + result.warnings.filter(w => w.severity !== "info").length, 0);
  const chars = pages.length ? pages.reduce((sum,p) => sum + (p.text?.length ?? 0), 0) : savedText(record.raw).length;
  const failed = record.state === "FAILED" || record.raw?.metadata?.status === "FAILED";
  const required = record.staleExtraction || /Re-extraction required/i.test(record.error ?? "");
  const complete = reusable && !partial;
  const cloudText = record.raw?.metadata?.provider === "ocr_space" || pages.some(p => p.extractionProvider === "ocr_space" || p.extractionProvider === "paddle_ocr");
  let status: string;
  if (failed) status = "OCR failed · manual review available";
  else if (partial) status = "Partial PDF processing · "+(
    failedPages.length?"failed page(s): "+failedPages.join(", "):
    missingPageCount?missingPageCount+" unprocessed page(s)":"missing/failed pages"
  )+" · extraction required";
  else if (processing) status = "Processing document…";
  else if (needsExtraction && supportsOcr && unavailable) status = providerState === "NOT_CONFIGURED" ? "OCR provider not configured" : "OCR provider unavailable";
  else if (required && needsExtraction) status = "Re-extraction required";
  else if (reusable) status = `Reparse available (local; no cloud request)${complete ? cloudText ? " · OCR Complete" : " · Text extraction complete" : ""}`;
  else if (results.length) status = "Saved parsing results · reusable extraction unavailable";
  else status = "Awaiting extraction";
  if (needsExtraction && supportsOcr && unavailable && !status.includes("provider")) status += providerState === "NOT_CONFIGURED" ? " · OCR provider not configured" : " · OCR provider unavailable";
  if (required && needsExtraction && !status.includes("Re-extraction required")) status += " · Re-extraction required";
  if (results.length || reusable) status += ` · ${fieldCount ? `${fieldCount} structured fields` : "No structured fields extracted"}${reviewCount ? ` · Needs review: ${reviewCount}` : ""}`;
  const pagePipeline=record.raw?.metadata?.provider==="page_package_pipeline";
  const parsedTypes=[...new Set(results.map(source=>source.documentType))];
  const logicalTypes=[...new Set((record.logicalDocuments??[]).map(section=>section.documentType))];
  return {
    summary: status, fieldCount, chars, failedPages, missingPageCount,
    diagnostics: {
      provider:record.raw?.metadata?.provider??"UNKNOWN",
      requestSucceeded:pagePipeline?"NOT_APPLICABLE_PAGE_PIPELINE":
        record.raw?.metadata?.requestSucceeded??"UNKNOWN",
      pageCount:expectedPages,charactersExtracted:chars,
      embeddedPages:record.packageProgress?.embedded??null,
      ocrPages:record.packageProgress?.ocr??null,
      failedPages,missingPageCount,
      physicalFileClassification:record.classification.documentType,
      logicalDocumentTypes:logicalTypes,
      parserInvoked:pagePipeline?(parsedTypes.length?parsedTypes:"NO_ACCEPTED_PARSED_SECTIONS"):
        record.raw?.metadata?.parserInvoked??record.raw?.metadata?.parser??"UNKNOWN",
      parsedSectionCount:results.length,
      candidateFieldCount:fieldCount,
      interpretation:"Candidate values only; not independently verified Key-in fields."
    },
    reparseLabel: "Reparse saved text (local)",
    ocrLabel: pdf ? "OCR missing/failed pages" : "OCR document",
    regenerateLabel: "Regenerate OCR (uses quota)",
    showOcr: supportsOcr && needsExtraction,
    showRegenerate: supportsOcr,
    canReparse: reusable && !processing,
    canOcr: supportsOcr && needsExtraction && !unavailable && !missingFile && !processing,
    canRegenerate: supportsOcr && !unavailable && !missingFile && !processing,
  };
}

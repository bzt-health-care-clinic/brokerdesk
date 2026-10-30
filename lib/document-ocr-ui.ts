import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { hasReusableText, savedText } from "./local-reparse.ts";
import { reusablePage } from "./pdf-page-ocr-status.ts"; // Step 5B-03

export function documentOcrUi(record: UploadedDocumentRecord, providerState: string, busy = false) {
  const pdf = record.mimeType === "application/pdf" || /\.pdf$/i.test(record.fileName);
  const supportsOcr = pdf || record.mimeType.startsWith("image/") || /\.(png|jpe?g|webp|tiff?|bmp)$/i.test(record.fileName);
  const pages = record.packagePages ?? [];
  const reusable = hasReusableText(record) || (pages.length>0 && pages.every(reusablePage));
  const partial = Boolean(record.packageProgress?.status === "PARTIAL" || pages.length && (pages.some(p => !reusablePage(p)) || pages.length < (record.pageCount ?? record.packageProgress?.total ?? pages.length)));
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
  const cloudText = record.raw?.metadata?.provider === "local_tesseract" || pages.some(p => ["ocr_space","paddle_ocr","local_tesseract"].includes(p.extractionProvider));
  let status: string;
  if (failed) status = "OCR failed · manual review available";
  else if (partial) status = "Partial PDF processing · missing/failed pages need extraction";
  else if (processing) status = "Processing document…";
  else if (needsExtraction && supportsOcr && unavailable) status = providerState === "NOT_CONFIGURED" ? "OCR provider not configured" : "OCR provider unavailable";
  else if (required && needsExtraction) status = "Re-extraction required";
  else if (reusable) status = `Reparse available (local; no cloud request)${complete ? cloudText ? " · OCR Complete" : " · Text extraction complete" : ""}`;
  else if (results.length) status = "Saved parsing results · reusable extraction unavailable";
  else status = "Awaiting extraction";
  if (needsExtraction && supportsOcr && unavailable && !status.includes("provider")) status += providerState === "NOT_CONFIGURED" ? " · OCR provider not configured" : " · OCR provider unavailable";
  if (required && needsExtraction && !status.includes("Re-extraction required")) status += " · Re-extraction required";
  if (results.length || reusable) status += ` · ${fieldCount ? `${fieldCount} structured fields` : "No structured fields extracted"}${reviewCount ? ` · Needs review: ${reviewCount}` : ""}`;
  return {
    summary: status, fieldCount, chars,
    reparseLabel: "Reparse saved text (local)",
    ocrLabel: pdf ? "OCR missing/failed pages" : "OCR document",
    regenerateLabel: "Regenerate OCR (local CPU)",
    showOcr: supportsOcr && needsExtraction,
    showRegenerate: supportsOcr,
    canReparse: reusable && !processing,
    canOcr: supportsOcr && needsExtraction && !unavailable && !missingFile && !processing,
    canRegenerate: supportsOcr && !unavailable && !missingFile && !processing,
  };
}

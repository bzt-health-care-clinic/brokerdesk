import { isDriverReport, reportBoundary, reportIdentity, savedPageText, SECTION_ANALYSIS_VERSION } from "./report-boundaries.ts";
import { classifyDocument, EXTRACTION_PIPELINE_VERSION, normalizeOcrText, PARSER_VERSION, parserFor } from "./document-ingestion.ts";
import type { DocumentType, LogicalDocument, PackagePage, ParsedSource, SuggestedLogicalDocument, UploadedDocumentRecord } from "./extraction-types.ts";
import { sectionRevision } from "./active-evidence.ts";

export const PACKAGE_EMBEDDED_TEXT_MIN_CHARACTERS = 40;
const REPEATED_SINGLE_DOCUMENT_TYPES = new Set<DocumentType>(["OWNERSHIP", "BILL_OF_SALE", "DRIVER_TRAINING_CERTIFICATE", "VEHICLE_PHOTO"]);
const label = (type: DocumentType) => type.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
const hash = (value: string | Uint8Array) => { let result = 2166136261; const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; for (const byte of bytes) result = Math.imul(result ^ byte, 16777619); return (result >>> 0).toString(16); };
const continuitySignals = (text: string) => [...new Set([...(text.match(/\bpage\s+\d+\s+(?:of|\/)\s*\d+\b/gi) ?? []), ...(text.match(/\b(?:continued|continuation)\b/gi) ?? []), ...(text.match(/\b(?:policy|report|quote)\s*(?:number|no\.?|#)?\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi) ?? [])])];

export interface PdfPageSource { pageCount: number; embeddedText(page: number): Promise<string>; renderPage(page: number, targetBytes: number): Promise<File>; close(): Promise<void> | void; }
export interface PdfPageAdapter { open(file: File): Promise<PdfPageSource>; }
export interface PageOcrTransport { extract(file: File, options?: { pageCount?: number; startPage?: number; endPage?: number }): Promise<{ text?: string; pages?: Array<{ text?: string; blocks?: unknown[]; rotation?: 0 | 90 | 180 | 270 }>; confidence?: number; metadata?: Record<string, unknown> }>; }

export class PdfBrowserRendererUnavailableError extends Error {
  readonly code = "PDF_BROWSER_RENDERER_UNAVAILABLE";
  constructor() { super("PDF browser renderer is unavailable outside the browser."); this.name = "PdfBrowserRendererUnavailableError"; }
}

let browserPdfAdapterPromise: Promise<PdfPageAdapter> | undefined;
export async function getBrowserPdfAdapter(): Promise<PdfPageAdapter> {
  if (typeof window === "undefined") throw new PdfBrowserRendererUnavailableError();
  browserPdfAdapterPromise ??= import("./browser-pdf-adapter").then(({ BrowserPdfPageAdapter }) => new BrowserPdfPageAdapter());
  return browserPdfAdapterPromise;
}

export function packageFailureRecord(record: UploadedDocumentRecord, error: unknown): UploadedDocumentRecord { return { ...record, state: "NEEDS_REVIEW", error: error instanceof Error ? `PDF page analysis failed: ${error.message}` : "PDF page analysis failed.", packageProgress: { status: "PARTIAL", processed: record.packageProgress?.processed ?? 0, total: record.packageProgress?.total ?? record.pageCount ?? 0, embedded: record.packageProgress?.embedded ?? 0, ocr: record.packageProgress?.ocr ?? 0, failed: Math.max(1, record.packageProgress?.failed ?? 0), updatedAt: new Date().toISOString() } }; }

export function discoverLogicalSections(record: UploadedDocumentRecord, pages: PackagePage[]) {
  const stamp = new Date().toISOString(); const manual = record.logicalDocuments?.filter((item) => item.classificationSource === "MANUAL") ?? [];
  const priorSuggestions = new Map((record.suggestedSections ?? []).map((item) => [item.id, item.suggestionStatus]));
  const manualPages = new Set(manual.flatMap((item) => Array.from({ length: Math.max(0, (item.endPage ?? item.startPage ?? 0) - (item.startPage ?? 0) + 1) }, (_, index) => (item.startPage ?? 0) + index)));
  const eligible = pages.filter((page) => page.extractionStatus === "COMPLETE" && page.classification.documentType !== "OTHER" && !manualPages.has(page.page) && !record.withdrawnSectionRanges?.some(range => page.page >= range.startPage && page.page <= range.endPage)); const groups: PackagePage[][] = []; const uncertain = new Set<PackagePage[]>();
  for (const page of eligible.sort((a, b) => a.page - b.page)) {
    const previous = groups.at(-1)?.at(-1); const signals = continuitySignals(page.text ?? ""); const previousSignals = continuitySignals(previous?.text ?? "");
    const sameContinuousDocument = previous && previous.page + 1 === page.page && previous.classification.documentType === page.classification.documentType && !REPEATED_SINGLE_DOCUMENT_TYPES.has(page.classification.documentType) && (signals.length > 0 || previousSignals.length > 0);
    if (previous && previous.page + 1 === page.page && previous.classification.documentType === page.classification.documentType && isDriverReport(page.classification.documentType)) {
      const relation = reportBoundary(groups.at(-1)!, page);
      if (relation === "CONTINUE") groups.at(-1)!.push(page);
      else { if (relation === "REVIEW") uncertain.add(groups.at(-1)!); groups.push([page]); if (relation === "REVIEW") uncertain.add(groups.at(-1)!); }
    } else if (sameContinuousDocument && !isDriverReport(page.classification.documentType)) groups.at(-1)!.push(page); else groups.push([page]);
  }
  // Attach page-continuous OTHER-classified pages to adjacent driver-report groups instead of
  // silently dropping them: continuation pages often lack title keywords and get classified OTHER.
  // The group is marked uncertain so the broker must review the boundary before accepting.
  const otherPages = pages.filter((page) => page.extractionStatus === "COMPLETE" && page.classification.documentType === "OTHER" && !manualPages.has(page.page) && !record.withdrawnSectionRanges?.some(range => page.page >= range.startPage && page.page <= range.endPage)).sort((a, b) => a.page - b.page);
  for (const group of groups) {
    if (!isDriverReport(group[0].classification.documentType)) continue;
    let nextPage = group.at(-1)!.page + 1;
    const trailing: PackagePage[] = [];
    for (;;) {
      const candidate = otherPages.find((page) => page.page === nextPage);
      if (!candidate) break;
      trailing.push(candidate);
      nextPage += 1;
    }
    if (trailing.length) { group.push(...trailing); uncertain.add(group); }
  }
  const suggestions: SuggestedLogicalDocument[] = groups.map(group => {
    const first = group[0]; const last = group.at(-1)!;
    const confidence = Math.min(...group.map(page => page.classification.confidence));
    const identity = reportIdentity(savedPageText(first));
    const end = reportIdentity(savedPageText(last));
    const report = isDriverReport(first.classification.documentType);
    const needsReview = report && (uncertain.has(group) || !(identity.reportId || identity.licence || identity.subjectName && identity.reportDate) || Boolean(identity.page && identity.page !== 1) || Boolean(end.page && end.total && end.page !== end.total));
    const evidenceSignals = [...new Set(group.flatMap(page => continuitySignals(page.text ?? "")))];
    if (report) evidenceSignals.push(needsReview ? "Report boundary needs broker review" : "Report identity / sequence supports this section");
    const id = `${record.id}-suggested-${first.page}-${last.page}-${first.classification.documentType}`;
    const prior = record.logicalDocuments?.find(s => s.id === id);
    return { id, physicalFileId: record.id, documentType: first.classification.documentType, title: label(first.classification.documentType), startPage: first.page, endPage: last.page,
      subjectName: prior?.subjectName ?? (report ? identity.subjectName : undefined), subjectType: report ? "DRIVER" : prior?.subjectType, subjectId: prior?.subjectId,
      documentSubtype: prior?.documentSubtype, presenceStatus: "FOUND", parseStatus: needsReview ? "NEEDS_REVIEW" : "NOT_EVALUATED", validationStatus: "NOT_EVALUATED", classificationSource: "AUTOMATIC",
      classificationConfidence: confidence, createdAt: prior?.createdAt ?? stamp, updatedAt: stamp,
      suggestionStatus: priorSuggestions.get(id) === "IGNORED" ? "IGNORED" : needsReview ? "PENDING" : priorSuggestions.get(id) ?? (confidence >= .9 ? "ACCEPTED" : "PENDING"), evidenceSignals };
  });
  return { manual, suggestions };
}

export async function parseSections(record: UploadedDocumentRecord, pages: PackagePage[], sections: LogicalDocument[]) {
  const sources: ParsedSource[] = [];
  for (const section of sections) {
    const parser = parserFor(section.documentType); if (!parser) continue; const selected = pages.filter((page) => page.page >= (section.startPage ?? 1) && page.page <= (section.endPage ?? section.startPage ?? 1)).map(page => ({ ...page, text: savedPageText(page) })); const text = selected.map((page) => page.text ?? "").join("\n"); if (!text.trim()) continue;
    const parsed = await parser.parse({ text, rawText: text, normalizedText: normalizeOcrText(text), pages: selected, confidence: Math.min(...selected.map((page) => page.confidence ?? .8)), metadata: { fileId: record.id, originalPhysicalFile: record.originalFileName ?? record.fileName, startPage: section.startPage, endPage: section.endPage } }, { fileName: record.fileName });
    for (const evidence of Object.values(parsed.fieldEvidence).flat()) { const page = selected.find((item) => item.page === evidence.page) ?? selected[0]; evidence.provider = page?.extractionProvider; evidence.physicalFileName = record.originalFileName ?? record.fileName; }
    sources.push({ ...parsed, documentId: record.id, logicalDocumentId: section.id, sourceRevision: sectionRevision(section), subjectType: section.subjectType, subjectId: section.subjectId });
  }
  return sources;
}

export async function analyzePdfPackage(record: UploadedDocumentRecord, file: File, adapter: PdfPageAdapter, ocr: PageOcrTransport, options: { maxOcrBytes: number; concurrency?: number; force?: boolean; onProgress?: (record: UploadedDocumentRecord) => Promise<void> | void } ): Promise<UploadedDocumentRecord> {
  const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
  if (record.sourceHash && record.sourceHash !== sourceHash) record = { ...record, packagePages: [], raw: undefined, parsed: undefined, parsedSources: undefined };
  record = { ...record, sourceHash, currentSourceHash: sourceHash };
  const source = await adapter.open(file); const existing = new Map((record.packagePages ?? []).map((page) => [page.page, page])); const pages: PackagePage[] = []; const pending: number[] = [];
  for (let page = 1; page <= source.pageCount; page += 1) { const cached = existing.get(page); if (!options.force && cached?.extractionStatus === "COMPLETE") pages.push(cached); else pending.push(page); }
  let current: UploadedDocumentRecord = { ...record, extractionVersion: EXTRACTION_PIPELINE_VERSION, parserVersion: PARSER_VERSION, staleExtraction: false, pageCount: source.pageCount, containerType: source.pageCount > 1 ? "COMBINED_AUTO_PACKAGE" : record.containerType, packagePages: [...pages].sort((a, b) => a.page - b.page), packageProgress: { status: "ANALYZING", processed: pages.length, total: source.pageCount, embedded: pages.filter((page) => page.extractionProvider === "embedded_pdf_text").length, ocr: pages.filter((page) => page.extractionProvider === "ocr_space" || page.extractionProvider === "paddle_ocr").length, failed: pages.filter((page) => page.extractionStatus === "FAILED").length, updatedAt: new Date().toISOString() } };
  let persistChain = Promise.resolve(); const persist = async () => { current.packagePages = [...pages].sort((a, b) => a.page - b.page); current.packageProgress = { status: "ANALYZING", processed: pages.length, total: source.pageCount, embedded: pages.filter((page) => page.extractionProvider === "embedded_pdf_text").length, ocr: pages.filter((page) => page.extractionProvider === "ocr_space").length, failed: pages.filter((page) => page.extractionStatus === "FAILED").length, updatedAt: new Date().toISOString() }; const snapshot = structuredClone(current); persistChain = persistChain.then(async () => { await options.onProgress?.(snapshot); }); await persistChain; };
  try {
    let cursor = 0; const worker = async () => { while (cursor < pending.length) { const pageNumber = pending[cursor++]; try { const embedded = await source.embeddedText(pageNumber); if (embedded.length >= PACKAGE_EMBEDDED_TEXT_MIN_CHARACTERS) pages.push({ page: pageNumber, pageNumber, text: embedded, confidence: .99, extractionProvider: "embedded_pdf_text", extractionStatus: "COMPLETE", classification: classifyDocument(record.fileName, "application/pdf", embedded), sourceHash: hash(embedded) }); else { const derivative = await source.renderPage(pageNumber, Math.floor(options.maxOcrBytes * .9)); try { const extracted = await ocr.extract(derivative, { pageCount: 1, startPage: 1, endPage: 1 }); const text = normalizeOcrText(extracted.text ?? extracted.pages?.map((page) => page.text ?? "").join("\n") ?? ""); pages.push({ page: pageNumber, pageNumber, text, blocks: extracted.pages?.[0]?.blocks as never, rotation: extracted.pages?.[0]?.rotation, confidence: extracted.confidence ?? .8, extractionProvider: String(extracted.metadata?.provider ?? "ocr_space") === "paddle_ocr" ? "paddle_ocr" : "ocr_space", extractionStatus: text ? "COMPLETE" : "FAILED", classification: classifyDocument(record.fileName, "image/jpeg", text), sourceHash: hash(new Uint8Array(await derivative.arrayBuffer())), error: text ? undefined : "OCR returned no text." }); } finally { /* Browser derivative is released after this iteration and is never persisted. */ } } } catch (error) { pages.push({ page: pageNumber, pageNumber, text: "", confidence: 0, extractionProvider: "none", extractionStatus: "FAILED", classification: { documentType: "OTHER", confidence: .1, reason: "Page extraction failed." }, sourceHash: "", error: error instanceof Error ? error.message : "Page extraction failed." }); } await persist(); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(2, options.concurrency ?? 1, pending.length || 1)) }, worker));
    const { manual, suggestions } = discoverLogicalSections(record, pages); const accepted = suggestions.filter((item) => item.suggestionStatus === "ACCEPTED"); const logicalDocuments = [...manual, ...accepted]; const parsedSources = await parseSections(record, pages, logicalDocuments);
    const failed = pages.filter((page) => page.extractionStatus === "FAILED").length; const charactersExtracted = pages.reduce((total, page) => total + (page.text?.length ?? 0), 0);
    const unanimousType = !failed && pages.length && pages.every(page => page.classification.documentType === pages[0].classification.documentType) && pages[0].classification.documentType !== "OTHER" ? pages[0].classification : undefined;
    current = { ...current, documentType: unanimousType?.documentType ?? current.documentType, classification: unanimousType ?? current.classification, state: failed || suggestions.some(s => isDriverReport(s.documentType) && s.suggestionStatus === "PENDING") ? "NEEDS_REVIEW" : "PARSED", extractionVersion: EXTRACTION_PIPELINE_VERSION, parserVersion: PARSER_VERSION, packagePages: [...pages].sort((a, b) => a.page - b.page), sectionAnalysisVersion: SECTION_ANALYSIS_VERSION, suggestedSections: suggestions, logicalDocuments, parsedSources, raw: { metadata: { ...record.raw?.metadata, provider: "page_package_pipeline", originalPhysicalFile: record.originalFileName ?? record.fileName, pageLevel: true, charactersExtracted, pageCount: pages.length } }, packageProgress: { status: failed ? "PARTIAL" : "COMPLETE", processed: pages.length, total: source.pageCount, embedded: pages.filter((page) => page.extractionProvider === "embedded_pdf_text").length, ocr: pages.filter((page) => page.extractionProvider === "ocr_space" || page.extractionProvider === "paddle_ocr").length, failed, updatedAt: new Date().toISOString() } };
    await options.onProgress?.(structuredClone(current)); return current;
  } finally { await source.close(); }
}

import { isDriverReport, savedPageText, SECTION_ANALYSIS_VERSION } from "./report-boundaries.ts";
import { PARSER_VERSION, parserFor, requiredParserVersion } from "./document-ingestion.ts";
import { discoverLogicalSections, parseSections } from "./package-analysis.ts";
import { sectionRevision } from "./active-evidence.ts";
import type { LogicalDocument, ParsedSource, RawExtractedDocument, UploadedDocumentRecord } from "./extraction-types.ts";

export function savedText(raw?: RawExtractedDocument) {
  return raw?.rawText?.trim() || raw?.text?.trim() || raw?.normalizedText?.trim() || raw?.pages?.map(savedPageText).join("\n").trim() || "";
}
export function hasReusableText(record: UploadedDocumentRecord) {
  if (record.currentSourceHash === "MISSING") return false;
  if (record.sourceHash && record.currentSourceHash && record.sourceHash !== record.currentSourceHash) return false;
  return record.packagePages?.length ? record.packagePages.some(p => p.extractionStatus === "COMPLETE" && savedPageText(p).trim()) : Boolean(savedText(record.raw)) && record.raw?.metadata?.status !== "FAILED";
}
function preserveCorrections(parsed: ParsedSource, old?: ParsedSource): ParsedSource {
  if (!old?.corrections) return parsed;
  const next = { ...parsed, data: { ...parsed.data }, corrections: structuredClone(old.corrections) };
  for (const [field, correction] of Object.entries(next.corrections)) next.data[field] = correction.correctedValue;
  return next;
}
export async function reparseDocument(record: UploadedDocumentRecord, reportsOnly = false): Promise<UploadedDocumentRecord> {
  if (!hasReusableText(record)) return { ...record, state: "NEEDS_REVIEW", staleExtraction: true, error: "Re-extraction required: saved OCR is missing, failed, or belongs to different source content." };
  const next = structuredClone(record);
  if (next.packagePages?.length) {
    const pages = next.packagePages.filter(p => p.extractionStatus === "COMPLETE" && savedPageText(p).trim());
    const discovered = discoverLogicalSections(next, pages);
    const regroupReports = next.sectionAnalysisVersion !== SECTION_ANALYSIS_VERSION && pages.some(p => isDriverReport(p.classification.documentType));
    const preserved = next.logicalDocuments?.filter(s => s.classificationSource === "MANUAL" || !isDriverReport(s.documentType)) ?? discovered.suggestions.filter(s => !isDriverReport(s.documentType) && s.suggestionStatus === "ACCEPTED");
    const sections = regroupReports
      ? [...preserved, ...discovered.suggestions.filter(s => isDriverReport(s.documentType) && s.suggestionStatus === "ACCEPTED")]
      : next.logicalDocuments !== undefined ? next.logicalDocuments : [...discovered.manual, ...discovered.suggestions.filter(s => s.suggestionStatus === "ACCEPTED")];
    if (regroupReports) {
      next.suggestedSections = [...(next.suggestedSections ?? []).filter(s => !isDriverReport(s.documentType)), ...discovered.suggestions.filter(s => isDriverReport(s.documentType))];
      const withdrawn = (next.parsedSources ?? []).filter(p => p.logicalDocumentId && !sections.some(s => s.id === p.logicalDocumentId));
      next.withdrawnParsedSources = [...(next.withdrawnParsedSources ?? []), ...withdrawn];
    }
    next.sectionAnalysisVersion = SECTION_ANALYSIS_VERSION;
    next.logicalDocuments = sections;
    const old = next.parsedSources ?? [];
    const parseable = reportsOnly ? sections.filter(s => isDriverReport(s.documentType)) : sections;
    next.parsedSources = [...(reportsOnly ? old.filter(p => !isDriverReport(p.documentType)) : []), ...(await parseSections(next, pages, parseable)).map(parsed => {
      const matching = old.filter(p => p.documentType === parsed.documentType && (p.logicalDocumentId ? p.logicalDocumentId === parsed.logicalDocumentId : p.fieldEvidence[Object.keys(p.fieldEvidence)[0]]?.[0]?.page === parsed.fieldEvidence[Object.keys(parsed.fieldEvidence)[0]]?.[0]?.page));
      const sameType = old.filter(p => p.documentType === parsed.documentType);
      const uniqueLegacy = sameType.length === 1 && !sameType[0].logicalDocumentId && sections.filter(s => s.documentType === parsed.documentType).length === 1 ? sameType[0] : undefined;
      return preserveCorrections(parsed, matching.length === 1 ? matching[0] : uniqueLegacy);
    })];
    next.parsed = undefined;
  } else {
    const parser = parserFor(next.documentType);
    next.parsed = parser && next.logicalDocuments?.length !== 0 ? preserveCorrections(await parser.parse(structuredClone(next.raw!), { fileName: next.fileName }), next.parsed) : undefined;
    if (next.parsed) {
      const section = next.logicalDocuments?.length === 1 ? next.logicalDocuments[0] : undefined;
      next.parsed = { ...next.parsed, documentId: next.id, ...(section ? { logicalDocumentId: section.id, sourceRevision: sectionRevision(section), subjectType: section.subjectType, subjectId: section.subjectId } : {}) };
    }
  }
  const warnings = [...(next.parsed?.warnings ?? []), ...(next.parsedSources ?? []).flatMap(p => p.warnings)];
  if (next.suggestedSections?.some(s => isDriverReport(s.documentType) && s.suggestionStatus === "PENDING")) warnings.push({ code: "REPORT_BOUNDARY_REVIEW", severity: "medium", message: "Report boundaries need confirmation; proposed sections are not active evidence." });
  if (next.withdrawnParsedSources?.some(s => s.corrections && Object.keys(s.corrections).length)) warnings.push({ code: "CORRECTION_SUPPORT_REVIEW", severity: "medium", message: "Corrections on withdrawn report sections are retained in history and require association review." });
  const incomplete = next.packagePages?.some(p => p.extractionStatus !== "COMPLETE" || !savedPageText(p).trim());
  next.state = warnings.length || incomplete ? "NEEDS_REVIEW" : "PARSED";
  next.validation = { presence: "FOUND", parseStatus: next.state, validationStatus: "NOT_EVALUATED", warnings, missingFields: warnings.flatMap(w => w.field ? [w.field] : []) };
  next.parserVersion = PARSER_VERSION; next.staleExtraction = false;
  next.error = incomplete ? "Re-extraction required for missing or failed pages; successful pages were reparsed locally." : undefined;
  return next;
}
export async function refreshParserVersion(record: UploadedDocumentRecord) {
  const sourceChanged = Boolean(record.sourceHash && record.currentSourceHash && record.sourceHash !== record.currentSourceHash);
  const reports = [record.documentType, ...(record.packagePages ?? []).map(p => p.classification.documentType)].some(isDriverReport);
  const boundariesChanged = reports && record.packagePages?.length && record.sectionAnalysisVersion !== SECTION_ANALYSIS_VERSION;
  return (record.parserVersion ?? 0) < requiredParserVersion(record) || boundariesChanged || sourceChanged ? reparseDocument(record, !sourceChanged && (record.parserVersion ?? 0) >= 3 && reports) : record;
}
/** Metadata changes only: no extractor/transport is accepted by this function. */
export async function updateLogicalSections(record: UploadedDocumentRecord, sections: LogicalDocument[]): Promise<UploadedDocumentRecord> {
  const changedIds = new Set((record.logicalDocuments ?? []).filter(old => !sections.some(s => s.id === old.id && sectionRevision(s) === sectionRevision(old))).map(s => s.id));
  const previous = [...(record.parsedSources ?? []), ...(record.parsed ? [record.parsed] : [])];
  const withdrawn = previous.filter(s => !s.logicalDocumentId || changedIds.has(s.logicalDocumentId));
  const remaining = previous.filter(s => s.logicalDocumentId && !changedIds.has(s.logicalDocumentId));
  const deleted = (record.logicalDocuments ?? []).filter(old => !sections.some(s => s.id === old.id));
  let next: UploadedDocumentRecord = {
    ...record, logicalDocuments: sections, parsed: undefined, parsedSources: remaining,
    withdrawnParsedSources: [...(record.withdrawnParsedSources ?? []), ...withdrawn],
    withdrawnSectionRanges: [...(record.withdrawnSectionRanges ?? []), ...deleted.map(s => ({ startPage: s.startPage ?? 1, endPage: s.endPage ?? s.startPage ?? 1 }))],
    suggestedSections: record.suggestedSections?.map(s => changedIds.has(s.id) ? { ...s, suggestionStatus: "IGNORED" } : s),
    state: "NEEDS_REVIEW",
  };
  if (hasReusableText(next)) {
    // For non-package sources a single section defines the parser.
    if (!next.packagePages?.length && sections.length === 1) next.documentType = sections[0].documentType;
    next = await reparseDocument(next);
  } else next.error = "Section evidence withdrawn. Saved text is unavailable; extraction needs review.";
  return next;
}


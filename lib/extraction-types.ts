import type { CaseType } from "./insurance-types.ts";

export type DocumentType = "AUTO_APPLICATION" | "AUTO_QUOTE" | "OWNERSHIP" | "BILL_OF_SALE" | "VEHICLE_PHOTO" | "SAFETY_INSPECTION" | "STUDENT_PROOF" | "ANTI_THEFT_PROOF" | "RETIREMENT_PROOF" | "MVR" | "DASH" | "DRIVER_TRAINING_CERTIFICATE" | "PAYMENT_AUTHORIZATION" | "CANCELLATION_REQUEST" | "PRIOR_AUTO_POLICY" | "LEASE_DOCUMENT" | "FINANCE_DOCUMENT" | "WINTER_TIRE_PROOF" | "HAB_APPLICATION" | "HAB_QUOTE" | "PRIOR_PROPERTY_POLICY" | "MORTGAGE_DOCUMENT" | "OPCF_FORM" | "POLICY_CHANGE" | "PORTAL_SCREENSHOT" | "VOID_CHEQUE" | "CTSAC_MEMBERSHIP_APPLICATION" | "DEGREE_CERTIFICATE" | "DIPLOMA" | "OTHER" | "MANUAL" | "CLIENT_CONFIRMED_FACT";
export type ProcessingState = "UPLOADED" | "CLASSIFYING" | "CLASSIFIED" | "EXTRACTING" | "OCR_PENDING" | "PARSED" | "NEEDS_REVIEW" | "FAILED";

export interface ExtractionInput { fileId: string; fileName: string; mimeType: string; documentType?: DocumentType; }
export interface BoundingBox { x: number; y: number; width: number; height: number; }
export interface ExtractedBlock { text: string; confidence?: number; boundingBox?: BoundingBox; }
export interface ExtractedPage { page: number; pageNumber?: number; text?: string; confidence?: number; width?: number; height?: number; rotation?: 0 | 90 | 180 | 270; blocks?: ExtractedBlock[]; }
export interface PackagePage extends ExtractedPage { extractionProvider: "embedded_pdf_text" | "ocr_space" | "paddle_ocr" | "none"; extractionStatus: "COMPLETE" | "FAILED"; classification: ClassificationResult; sourceHash: string; error?: string; }
export interface RawExtractedDocument { text?: string; rawText?: string; normalizedText?: string; pages?: ExtractedPage[]; metadata?: Record<string, unknown>; confidence?: number; }
export interface FieldEvidence { page?: number; text?: string; boundingBox?: BoundingBox; confidence?: number; provider?: string; physicalFileName?: string; }
export interface ExtractionWarning { code: string; message: string; field?: string; severity: "high" | "medium" | "info"; }
export interface ParseContext { caseType?: CaseType; fileName?: string; }
export interface ParsedSource<T = Record<string, unknown>> { documentId: string; documentType: DocumentType; parsedAt: string; confidence: number; data: T; warnings: ExtractionWarning[]; fieldEvidence: Record<string, FieldEvidence[]>; corrections?: Record<string, ManualCorrection>; }
export type ProviderStatus = "READY" | "NOT_CONFIGURED" | "UNAVAILABLE";
export interface DocumentExtractor { id?: string; status?: ProviderStatus; canHandle?(input: ExtractionInput): Promise<boolean>; extract(input: ExtractionInput): Promise<RawExtractedDocument>; }
export interface ExtractionProvider extends DocumentExtractor { id: string; status: ProviderStatus; canHandle(input: ExtractionInput): Promise<boolean>; }
export interface DocumentParser<T = Record<string, unknown>> { parse(raw: RawExtractedDocument, context?: ParseContext): Promise<ParsedSource<T>>; }
export interface ClassificationResult { documentType: DocumentType; confidence: number; reason: string; }
export interface DocumentValidationSummary { presence: "FOUND" | "MISSING"; parseStatus: "PARSED" | "NEEDS_REVIEW" | "FAILED"; validationStatus: "NOT_EVALUATED" | "COMPLETE" | "INCOMPLETE"; missingFields: string[]; warnings: ExtractionWarning[]; }
export type LogicalParseStatus = "NOT_EVALUATED" | "NEEDS_REVIEW" | "PARSED" | "FAILED";
export type LogicalValidationStatus = "NOT_EVALUATED" | "VALID" | "INCOMPLETE" | "INVALID";
export interface LogicalDocument { subjectId?: string; id: string; caseId?: string; physicalFileId: string; documentType: DocumentType; title: string; startPage?: number; endPage?: number; subjectName?: string; subjectType?: string; documentSubtype?: string; presenceStatus: "MISSING" | "FOUND"; parseStatus: LogicalParseStatus; validationStatus: LogicalValidationStatus; classificationSource: "AUTOMATIC" | "MANUAL" | "MIGRATED"; classificationConfidence?: number; createdAt: string; updatedAt: string; }
export interface SuggestedLogicalDocument extends LogicalDocument { suggestionStatus: "PENDING" | "ACCEPTED" | "IGNORED"; evidenceSignals: string[]; }
export interface PackageProgress { status: "NOT_STARTED" | "ANALYZING" | "COMPLETE" | "PARTIAL"; processed: number; total: number; embedded: number; ocr: number; failed: number; updatedAt: string; }
export interface UploadedDocumentRecord { id: string; fileName: string; originalFileName?: string; currentFileName?: string; mimeType: string; size: number; pageCount?: number; containerType?: string; documentType: DocumentType; classification: ClassificationResult; state: ProcessingState; extractionVersion?: number; parserVersion?: number; staleExtraction?: boolean; logicalDocuments?: LogicalDocument[]; suggestedSections?: SuggestedLogicalDocument[]; packagePages?: PackagePage[]; packageProgress?: PackageProgress; parsedSources?: ParsedSource[]; raw?: RawExtractedDocument; parsed?: ParsedSource; validation?: DocumentValidationSummary; error?: string; }

export interface SourceValue<T> { source: string; value: T; confidence?: number; evidence?: FieldEvidence[]; documentId?: string; }
export interface ReconciledField<T> { value: T | null; status: "resolved" | "conflict" | "missing"; selectedSource?: string; sourceValues: SourceValue<T>[]; }
export interface ManualCorrection<T = unknown> { originalExtractedValue: T; correctedValue: T; correctedBy: string; correctedAt: string; }
// Physical-file identity is distinct from each rendered page's sourceHash.
export interface UploadedDocumentRecord { sectionAnalysisVersion?: number; sourceHash?: string; currentSourceHash?: string; withdrawnParsedSources?: ParsedSource[]; withdrawnSectionRanges?: { startPage: number; endPage: number }[]; }
export interface ParsedSource<T = Record<string, unknown>> { claimRecordId?: string; logicalDocumentId?: string; sourceRevision?: string; subjectType?: string; subjectId?: string; lineOfBusiness?: "AUTO" | "HAB"; }

/** Extracted groups are source observations, not confirmed rated vehicles or policy drivers. */
export interface ParsedEntity {
  id: string;
  kind: 'VEHICLE' | 'DRIVER' | 'PROPERTY' | 'POLICY_HISTORY';
  label: string;
  excluded?: boolean;
  data: Record<string, unknown>;
  fieldEvidence: Record<string, FieldEvidence[]>;
  warnings: ExtractionWarning[];
}
export interface ParsedSource<T = Record<string, unknown>> {
  entities?: ParsedEntity[];
  entityId?: string;
  entityLabel?: string;
  excluded?: boolean;
  layoutVersion?: number;
}

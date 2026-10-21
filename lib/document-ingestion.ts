import { enrichDriverReport, reportRaw } from "./report-details.ts";
import { isDriverReport, reportHeader } from "./report-boundaries.ts";
import type { ClassificationResult, DocumentExtractor, DocumentParser, DocumentType, ExtractionInput, ExtractionProvider, ExtractionWarning, ParsedSource, RawExtractedDocument, UploadedDocumentRecord } from "./extraction-types.ts";
import { ownershipFields } from "./ownership-fields.ts";
const CRITICAL_FIELD_CONFIDENCE = .9;
export const EXTRACTION_PIPELINE_VERSION = 2;
export const PARSER_VERSION = 5;
// Reparse only sources whose structured fields changed; binary proof photos and
// signature-only files do not need OCR to remain valid supporting evidence.
export function requiredParserVersion(record: UploadedDocumentRecord) {
  const kinds=[record.documentType,...(record.logicalDocuments??[]).map(s=>s.documentType),
    ...(record.packagePages??[]).map(page=>page.classification.documentType)];
  const expanded=new Set<DocumentType>([
    "AUTO_APPLICATION","AUTO_QUOTE","HAB_APPLICATION","HAB_QUOTE","POLICY_CHANGE"]);
  return kinds.some(type=>isDriverReport(type)||expanded.has(type))?PARSER_VERSION:3;
}

export function invalidateStaleExtraction(record: UploadedDocumentRecord): UploadedDocumentRecord {
  if (!record.raw && !record.parsed && !record.packagePages?.length && !record.parsedSources?.length) return record;
  const extractionStale = record.extractionVersion !== EXTRACTION_PIPELINE_VERSION;
  const parserStale = (record.parserVersion ?? 0) < requiredParserVersion(record);
  if (!extractionStale && !parserStale) return record;
  return { ...record, state: "NEEDS_REVIEW", staleExtraction: true, raw: extractionStale ? undefined : record.raw, packagePages: extractionStale ? undefined : record.packagePages, packageProgress: extractionStale ? undefined : record.packageProgress, parsed: undefined, parsedSources: undefined, validation: undefined, error: extractionStale ? "Saved extraction was created by an older pipeline. Re-extract this document before using its fields." : "Saved parsed fields were created by an older parser. Re-extract this document before using its fields." };
}

const CLASSIFIERS: { type: DocumentType; score: number; patterns: RegExp[]; reason: string }[] = [
  { type: "PAYMENT_AUTHORIZATION", score: .96, patterns: [/payment authorization/i, /pre.?authorized debit/i, /credit card authorization/i], reason: "Document identifies a payment authorization." },
  { type: "CANCELLATION_REQUEST", score: .96, patterns: [/cancellation request/i, /request to cancel/i, /lost policy release/i], reason: "Document identifies a cancellation request." },
  { type: "VEHICLE_PHOTO", score: .9, patterns: [/vehicle photo/i, /vin photo/i, /damage photo/i], reason: "Filename identifies a vehicle photo." },
  { type: "DRIVER_TRAINING_CERTIFICATE", score: .94, patterns: [/driver training/i, /driving school.*graduation/i, /graduation certificate/i], reason: "Document identifies a driver-training graduation certificate." },
  { type: "BILL_OF_SALE", score: .94, patterns: [/bill of sale/i, /vehicle purchase agreement/i], reason: "Document identifies a vehicle Bill of Sale." },
  { type: "OPCF_FORM", score: .94, patterns: [/opcf\s*1[67]/i, /endorsement form/i], reason: "Document identifies an OPCF/endorsement form." },
  { type: "CTSAC_MEMBERSHIP_APPLICATION", score: .98, patterns: [/ctsac/i, /chinese teachers and scholars association/i, /individual membership application/i], reason: "Document identifies a CTSAC membership application." },
  { type: "DEGREE_CERTIFICATE", score: .94, patterns: [/degree certificate/i, /学位证/i], reason: "Document identifies a degree certificate." },
  { type: "DIPLOMA", score: .94, patterns: [/diploma/i, /毕业证/i], reason: "Document identifies a diploma." },
  { type: "OWNERSHIP", score: .98, patterns: [/ownership/i, /vehicle permit/i, /registration/i], reason: "Filename or text identifies a vehicle permit/ownership." },
  { type: "MVR", score: .98, patterns: [/\bmvr\b/i, /driver abstract/i, /motor vehicle record/i, /ontario driving record/i, /licence number[\s\S]{0,200}demerit points/i], reason: "Filename or text identifies a motor vehicle record." },
  { type: "DASH", score: .98, patterns: [/dash/i, /autoplus/i, /auto plus/i], reason: "Filename or text identifies DASH/AutoPlus history." },
  { type: "PORTAL_SCREENSHOT", score: .9, patterns: [/portal/i, /screenshot/i, /screen.?shot/i], reason: "Filename identifies a carrier portal screenshot." },
  { type: "POLICY_CHANGE", score: .94, patterns: [/change form/i, /policy change/i, /endorsement request/i], reason: "Filename or text identifies a policy change request." },
  { type: "MORTGAGE_DOCUMENT", score: .93, patterns: [/mortgage/i, /mortgagee/i], reason: "Filename or text identifies mortgage information." },
  { type: "LEASE_DOCUMENT", score: .92, patterns: [/lease/i, /lessor/i], reason: "Filename or text identifies a lease document." },
  { type: "FINANCE_DOCUMENT", score: .92, patterns: [/finance/i, /lienholder/i, /lien holder/i], reason: "Filename or text identifies finance/lienholder information." },
  { type: "VOID_CHEQUE", score: .96, patterns: [/void cheque/i, /void check/i], reason: "Filename or text identifies a void cheque." },
  { type: "WINTER_TIRE_PROOF", score: .92, patterns: [/winter tire/i, /snow tire/i], reason: "Filename or text identifies winter tire proof." },
  { type: "PRIOR_PROPERTY_POLICY", score: .9, patterns: [/prior home/i, /previous property/i, /prior property/i], reason: "Filename identifies a prior property policy." },
  { type: "PRIOR_AUTO_POLICY", score: .9, patterns: [/prior auto/i, /previous auto/i], reason: "Filename identifies a prior auto policy." },
  { type: "HAB_APPLICATION", score: .9, patterns: [/hab.*application/i, /home.*application/i, /tenant.*application/i, /condo.*application/i], reason: "Filename identifies a signed habitational application." },
  { type: "HAB_QUOTE", score: .9, patterns: [/hab.*quote/i, /home.*quote/i, /tenant.*quote/i, /condo.*quote/i], reason: "Filename identifies a habitational quote." },
  { type: "AUTO_APPLICATION", score: .9, patterns: [/auto.*application/i, /oaf.?1/i, /signed.*application/i], reason: "Filename identifies a signed Auto application." },
  { type: "AUTO_QUOTE", score: .9, patterns: [/auto.*quote/i, /vehicle.*quote/i], reason: "Filename identifies an Auto quote." },
];

/**
 * Filename and document titles identify documents; incidental field labels do
 * not. In particular "Driver Training: No", "Leased: No" and "Mortgages: 1"
 * must not turn a Quote or signed application into those document types.
 */
export function classifyDocument(fileName: string, mimeType: string, text = ""): ClassificationResult {
  const name = fileName.replace(/[._-]+/g, " ").trim();
  const head = text.slice(0, 1600);
  const from = (documentType: DocumentType, reason: string, confidence = .95): ClassificationResult =>
    ({ documentType, confidence, reason });

  const isSignaturePacket = /^g4sign[\s._-]/i.test(fileName);
  if (isSignaturePacket) {
    if (/\bHABITATIONAL\s+INSURANCE\b|\bAPPLICATION\s+FOR\s+HABITATIONAL\s+INSURANCE\b/i.test(head))
      return from("HAB_APPLICATION", "G4Sign habitational packet identified by cover/application title.");
    if (/\bAUTOMOBILE\s+INSURANCE\b|\bOAF\s*1\b|\bAPPLICATION\s+FOR\s+AUTOMOBILE\s+INSURANCE\b/i.test(head))
      return from("AUTO_APPLICATION", "G4Sign automobile packet identified by cover/application title.");
    return from("OTHER", "G4Sign packet requires an application title or broker classification.", .35);
  }
  if (/\b(?:signed\s+)?(?:home|hab|habitational|tenant|condo)\s+app(?:lication)?\b/i.test(name))
    return from("HAB_APPLICATION", "Filename identifies a signed habitational application.");
  if (/\b(?:signed\s+)?auto\s+app(?:lication)?\b/i.test(name))
    return from("AUTO_APPLICATION", "Filename identifies an auto application.");
  if (/\bowern\s*ship\b/i.test(name))
    return from("OWNERSHIP", "Filename identifies a rotated/scanned Ontario ownership permit.");

  // Explicit filenames outrank long unrelated body text or generic labels.
  for (const candidate of CLASSIFIERS)
    if (candidate.patterns.some(pattern => pattern.test(name)))
      return from(candidate.type, "Document filename identifies its type.", candidate.score);

  // These categories need a stand-alone TITLE, not just a word in a quote.
  const specialized: Partial<Record<DocumentType, RegExp>> = {
    DRIVER_TRAINING_CERTIFICATE: /^(?:driver\s+training\s+(?:graduation\s+)?certificate|driving\s+school\s+graduation|certificate\s+of\s+driver\s+training)\b/im,
    LEASE_DOCUMENT: /^(?:vehicle\s+)?(?:lease\s+agreement|leasing\s+contract)\b/im,
    FINANCE_DOCUMENT: /^(?:vehicle\s+)?(?:finance\s+agreement|financing\s+agreement|lienholder\s+agreement)\b/im,
    MORTGAGE_DOCUMENT: /^(?:mortgage\s+agreement|mortgage\s+statement|mortgagee\s+information)\b/im,
    PRIOR_PROPERTY_POLICY: /^(?:prior|previous)\s+(?:home|property)\s+insurance\s+policy\b/im,
    PRIOR_AUTO_POLICY: /^(?:prior|previous)\s+auto\s+insurance\s+policy\b/im,
  };
  for (const candidate of CLASSIFIERS) {
    const titleRequired = specialized[candidate.type];
    const matched = titleRequired ? titleRequired.test(head) : candidate.patterns.some(pattern => pattern.test(head));
    if (matched) return from(candidate.type, candidate.reason, candidate.score);
  }
  if (mimeType.startsWith("image/"))
    return from("PORTAL_SCREENSHOT", "Image detected; visual/filename classification required.", .43);
  return from("OTHER", "No reliable document title; manual classification required.", .35);
}

export class BrowserFileStore {
  private files = new Map<string, File>();
  register(id: string, file: File) { this.files.set(id, file); }
  get(id: string) { return this.files.get(id); }
}

export class LocalTextProvider implements ExtractionProvider {
  readonly id = "local_text";
  readonly status = "READY" as const;
  constructor(private store: BrowserFileStore) {}
  async canHandle(input: ExtractionInput) { return input.mimeType.startsWith("text/") || /\.(txt|csv|json|xml|md)$/i.test(input.fileName); }
  async extract(input: ExtractionInput): Promise<RawExtractedDocument> {
    const file = this.store.get(input.fileId);
    if (!file) throw new Error("Uploaded file is no longer available in this browser session.");
    const isText = file.type.startsWith("text/") || /\.(txt|csv|json|xml|md)$/i.test(file.name);
    if (isText) {
      const text = await file.text();
      return { text, pages: [{ page: 1, text }], metadata: { provider: "local_text", fileName: file.name }, confidence: .99 };
    }
    return { pages: [], metadata: { provider: "local_metadata", fileName: file.name, requiresProvider: file.type === "application/pdf" ? "pdf_text_or_ocr" : "image_ocr" }, confidence: .2 };
  }
}

const valueFrom = (text: string, labels: string[]) => {
  for (const label of labels) {
    const match = text.match(new RegExp(`(?:^|\\n)[ \\t]*${label}(?:[ \\t]*[:#-][ \\t]*|[ \\t]+|[ \\t]*\\n[ \\t]*)([^\\n\\r]+)`, "im"));
    if (match) return match[1].trim();
  }
  return undefined;
};

export function normalizeOcrText(text: string) {
  return text.normalize("NFKC").replace(/\u00a0/g, " ").replace(/[：]/g, ":").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[\t ]+/g, " ").trim()).filter(Boolean).join("\n");
}

export function sanitizedOcrPreview(text: string, limit = 500) {
  const labels = /\b(?:ONTARIO|VEHICLE|PERMIT|CERTIFICATE|REGISTRATION|REGISTERED|OWNER|NAME|NOM|ADDRESS|ADRESSE|VIN|V\.I\.N\.|IDENTIFICATION|PLATE|PLAQUE|MAKE|MARQUE|MODEL|MODELE|MODÈLE|YEAR|ANNEE|ANNÉE|BODY|TYPE|COLOUR|COLOR|LESSOR|LIENHOLDER)\b/gi;
  return normalizeOcrText(text).slice(0, limit).split("\n").map((line) => {
    if (/^(?:ONTARIO|VEHICLE\s+(?:PERMIT|REGISTRATION)|PERMIT|CERTIFICATE)(?:\s|$)/i.test(line)) return line.replace(/\b[A-HJ-NPR-Z0-9]{17}\b/gi, "[VIN REDACTED]").replace(/\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/gi, "[POSTAL REDACTED]");
    const found = [...line.matchAll(labels)].map((match) => match[0]); labels.lastIndex = 0;
    return found.length ? `${found.join(" / ")} [VALUE REDACTED]` : "[VALUE REDACTED]";
  }).join("\n");
}

const OWNERSHIP_LABEL = /\b(?:REGISTERED\s+OWNER|NAME\s*(?:\/\s*NOM)?|NOM|ADDRESS\s*(?:\/\s*ADRESSE)?|ADRESSE|V\.?I\.?N\.?|VEHICLE\s+IDENTIFICATION|PLATE\s*(?:\/\s*PLAQUE)?|PLAQUE|MAKE\s*(?:\/\s*MARQUE)?|MARQUE|MODEL\s*(?:\/\s*MOD[ÈE]LE)?|MOD[ÈE]LE|YEAR\s*(?:\/\s*ANN[ÉE]E)?|ANN[ÉE]E|BODY\s+TYPE|COLOUR|COLOR|LESSOR|LIENHOLDER|PERMIT\s*(?:\/\s*CERTIFICATE)?|CERTIFICATE)\b/i;
const isOwnershipLabel = (value: string) => OWNERSHIP_LABEL.test(value) || /V\.I\.N\./i.test(value);
const cleanCandidate = (value: string) => value.replace(/^[\s:/#|.-]+/, "").replace(/[\s|]+$/, "").trim();
function nearLabel(lines: string[], pattern: RegExp, maxFollowing = 2) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern); if (!match || match.index === undefined) continue;
    const sameLine = cleanCandidate(lines[index].slice(match.index + match[0].length));
    if (sameLine && !isOwnershipLabel(sameLine)) return sameLine;
    for (let offset = 1; offset <= maxFollowing && index + offset < lines.length; offset += 1) {
      const candidate = cleanCandidate(lines[index + offset]);
      if (!candidate) continue; if (isOwnershipLabel(candidate)) break; return candidate;
    }
  }
  return undefined;
}

function addressNearLabel(lines: string[]) {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/\b(?:OWNER\s+ADDRESS|ADDRESS\s*(?:\/\s*ADRESSE)?|ADRESSE)\b/i); if (!match || match.index === undefined) continue;
    const values: string[] = []; const sameLine = cleanCandidate(lines[index].slice(match.index + match[0].length)); if (sameLine && !isOwnershipLabel(sameLine)) values.push(sameLine);
    for (let offset = 1; offset <= 3 && index + offset < lines.length; offset += 1) { const candidate = cleanCandidate(lines[index + offset]); if (!candidate) continue; if (isOwnershipLabel(candidate)) break; values.push(candidate); }
    if (values.length) return values.join(", ");
  }
  return undefined;
}

function nextLineAfterLabel(lines: string[], pattern: RegExp) { for (let index = 0; index < lines.length; index += 1) if (pattern.test(lines[index])) { const candidate = cleanCandidate(lines[index + 1] ?? ""); if (candidate) return candidate; } return undefined; }

abstract class KeyValueParser implements DocumentParser<Record<string, unknown>> {
  abstract documentType: DocumentType;
  abstract fields: Record<string, string[]>;
  async parse(raw: RawExtractedDocument, context?: { fileName?: string }): Promise<ParsedSource<Record<string, unknown>>> {
    const text = raw.text ?? raw.pages?.map((page) => page.text ?? "").join("\n") ?? "";
    const data: Record<string, unknown> = {};
    const fieldEvidence: ParsedSource["fieldEvidence"] = {};
    for (const [field, labels] of Object.entries(this.fields)) {
      const value = valueFrom(text, labels);
      if (value !== undefined) {
        data[field] = value;
        const page = raw.pages?.find((item) => (item.text ?? "").includes(value));
        const block = page?.blocks?.find((item) => item.text.includes(value));
        fieldEvidence[field] = [{ page: page?.pageNumber ?? page?.page ?? 1, text: value, boundingBox: block?.boundingBox, confidence: block?.confidence ?? page?.confidence ?? raw.confidence ?? .8 }];
      }
    }
    const noText = !text.trim();
    const warnings: ExtractionWarning[] = noText ? [{ code: "EXTRACTION_PROVIDER_REQUIRED", message: "This PDF/image requires a configured text/OCR provider or manual entry.", severity: "medium" }] : [];
    const criticalFields = new Set(["vin", "licenceNumber", "policyNumber", "quoteNumber", "namedInsured", "registeredOwner", "memberNumber", "certificateNumber"]);
    for (const field of Object.keys(data)) {
      const confidence = fieldEvidence[field]?.[0]?.confidence ?? raw.confidence ?? 0;
      if (criticalFields.has(field) && confidence < CRITICAL_FIELD_CONFIDENCE) warnings.push({ code: field === "vin" ? "VIN_REVIEW_REQUIRED" : "CRITICAL_FIELD_REVIEW_REQUIRED", message: `${field} extraction confidence is below 90%; broker review is required.`, field, severity: "high" });
    }
    if (raw.metadata?.rotationReviewRequired) warnings.push({ code: "ROTATION_REVIEW_REQUIRED", message: "Document orientation could not be confirmed; review OCR output.", severity: "medium" });
    return { documentId: String(raw.metadata?.fileId ?? context?.fileName ?? crypto.randomUUID()), documentType: this.documentType, parsedAt: new Date().toISOString(), confidence: noText ? .2 : raw.confidence ?? .8, data, warnings, fieldEvidence };
  }
}

export class AutoApplicationParser extends KeyValueParser { documentType = "AUTO_APPLICATION" as const; fields = { insurer: ["Insurance Company", "Insurer", "Carrier"], quoteNumber: ["Quote", "Submission"], namedInsured: ["Named Insured", "Applicant", "Insured"], coInsured: ["Co-Insured", "Co Insured"], effectiveDate: ["Effective Date", "Effective"], vin: ["VIN"], vehicleUse: ["Primary Use", "Use"], annualKm: ["Annual KM", "Annual Kilometres"], commuteKm: ["Commute KM", "One-way commute"], g1Date: ["G1 Date", "G1"], g2Date: ["G2 Date", "G2"], gDate: ["G Date", "G"], telematicsPhone: ["Telematics Phone", "Registered Phone"], telematicsEmail: ["Telematics Email", "Registered Email"], premium: ["Annual Premium", "Premium"], driverName: ["Driver Name", "Driver", "Operator Name"], dob: ["Date of Birth", "DOB"], licenceNumber: ["Licence Number", "Driver Licence Number"], licenceClass: ["Licence Class", "DL Class"], liability: ["Third Party Liability", "Liability Limit", "Liability"], dcpdDeductible: ["DCPD Deductible"], allPerilsDeductible: ["All Perils Deductible"], deductibles: ["Deductibles"], endorsements: ["Endorsements", "OPCF Selections"], purchaseDate: ["Purchase Date"], purchasePrice: ["Purchase Price"], garagingAddress: ["Garaging Address", "Garage Address"], businessUsePercent: ["Business Use Percent", "Business Use %"], winterTires: ["Winter Tires"], leased: ["Leased"], previousInsurer: ["Previous Insurer"], priorPolicyNumber: ["Previous Policy Number", "Prior Policy Number"], insuredSince: ["Auto Insured Since", "Insured Since"], dateWithCompany: ["Date With Company"], continuousInsurance: ["Continuous Insurance"] }; }
export class AutoQuoteParser extends KeyValueParser { documentType = "AUTO_QUOTE" as const; fields = { insurer: ["Insurance Company", "Carrier", "Insurer"], quoteNumber: ["Quote Number", "Quote", "Submission"], namedInsured: ["Named Insured", "Insured"], coInsured: ["Co-Insured", "Co Insured", "Second Named Insured"], effectiveDate: ["Effective Date", "Effective"], vin: ["VIN"], annualKm: ["Annual KM"], commuteKm: ["Commute KM"], premium: ["Annual Premium", "Premium"], telematicsDiscount: ["Telematics Discount"], driverName: ["Driver Name", "Driver", "Operator Name"], dob: ["Date of Birth", "DOB"], licenceNumber: ["Licence Number", "Driver Licence Number"], licenceClass: ["Licence Class", "DL Class"], liability: ["Third Party Liability", "Liability Limit", "Liability"], dcpdDeductible: ["DCPD Deductible"], allPerilsDeductible: ["All Perils Deductible"], deductibles: ["Deductibles"], endorsements: ["Endorsements", "OPCF Selections"], purchaseDate: ["Purchase Date"], purchasePrice: ["Purchase Price"], garagingAddress: ["Garaging Address", "Garage Address"], businessUsePercent: ["Business Use Percent", "Business Use %"], winterTires: ["Winter Tires"], leased: ["Leased"], previousInsurer: ["Previous Insurer"], priorPolicyNumber: ["Previous Policy Number", "Prior Policy Number"], insuredSince: ["Auto Insured Since", "Insured Since"], dateWithCompany: ["Date With Company"], continuousInsurance: ["Continuous Insurance"] }; }
export class OwnershipParser extends KeyValueParser {
  documentType = "OWNERSHIP" as const;
  fields = {};
  async parse(raw: RawExtractedDocument, context?: { fileName?: string }): Promise<ParsedSource<Record<string, unknown>>> {
    const rawText = raw.rawText ?? raw.text ?? raw.pages?.map((page) => page.text ?? "").join("\n") ?? "";
    const normalizedText = raw.normalizedText ?? normalizeOcrText(rawText); const lines = normalizedText.split("\n");
    raw.rawText = rawText; raw.normalizedText = normalizedText;
    const vinCandidates = [...new Set(normalizedText.toUpperCase().match(/(?<![A-Z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Z0-9])/g) ?? [])];
    const resolved = ownershipFields(raw, normalizedText);
    const candidates: Record<string, string | number | undefined> = {
      ...resolved.data,
      vin: vinCandidates.length === 1 ? vinCandidates[0] : undefined,
      bodyType: nearLabel(lines, /\bBODY\s+TYPE\b/i),
      lessor: nearLabel(lines, /\bLESSOR\b/i),
      lienholder: nearLabel(lines, /\bLIEN\s*HOLDER\b/i),
      permitNumber: nearLabel(lines, /\b(?:PERMIT|CERTIFICATE)\s*(?:NUMBER|NO\.?|#)\b/i),
    };
    const data = Object.fromEntries(Object.entries(candidates).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== ""));
    const fieldEvidence = Object.fromEntries(Object.entries(data).map(([field, value]) => [field, resolved.evidence[field] ?? [{ page: raw.pages?.find((page) => (page.text ?? "").includes(String(value)))?.page, text: String(value), confidence: raw.confidence }]]));
    const warnings: ExtractionWarning[] = resolved.unresolved.map(field => ({ code: "NEEDS_REVIEW", field, message: `${field} is missing, rejected, or ambiguous; review the Ownership source.`, severity: "high" }));
    if (!normalizedText) warnings.push({ code: "EXTRACTION_PROVIDER_REQUIRED", message: "No OCR text was returned; the Ownership parser had no text to parse.", severity: "medium" });
    else if (!Object.keys(data).length) warnings.push({ code: "OWNERSHIP_NO_STRUCTURED_FIELDS", message: "OCR text was extracted, but no Ownership fields could be structured. Manual review is required.", severity: "medium" });
    if (vinCandidates.length > 1) warnings.push({ code: "VIN_MULTIPLE_CANDIDATES", message: "Multiple valid 17-character VIN candidates were found; select the correct VIN manually.", field: "vin", severity: "high" });
    for (const field of ["vin", "registeredOwner"]) if (data[field] && (raw.confidence ?? .8) < CRITICAL_FIELD_CONFIDENCE) warnings.push({ code: field === "vin" ? "VIN_REVIEW_REQUIRED" : "CRITICAL_FIELD_REVIEW_REQUIRED", message: `${field} extraction confidence is below 90%; broker review is required.`, field, severity: "high" });
    raw.metadata = { ...raw.metadata, parserInvoked: "OWNERSHIP", parserCandidateFields: Object.keys(data), vinCandidateCount: vinCandidates.length, finalParsedFieldCount: Object.keys(data).length, sanitizedPreview: sanitizedOcrPreview(rawText) };
    return { documentId: String(raw.metadata?.fileId ?? context?.fileName ?? crypto.randomUUID()), documentType: this.documentType, parsedAt: new Date().toISOString(), confidence: normalizedText ? raw.confidence ?? .8 : .2, data, warnings, fieldEvidence };
  }
}
export class BillOfSaleParser extends KeyValueParser { documentType = "BILL_OF_SALE" as const; fields = { purchaser: ["Purchaser", "Buyer"], seller: ["Seller"], vin: ["VIN"], year: ["Year"], make: ["Make"], model: ["Model"], purchaseDate: ["Purchase Date", "Date of Sale"], purchasePrice: ["Purchase Price", "Sale Price"] }; }
export class DriverTrainingCertificateParser extends KeyValueParser { documentType = "DRIVER_TRAINING_CERTIFICATE" as const; fields = { driverName: ["Driver Name", "Student Name", "Graduate"], drivingSchool: ["Driving School", "Institution"], graduationDate: ["Graduation Date", "Certificate Date"], certificateNumber: ["Certificate Number", "Certificate No"], course: ["Course", "Program"] }; }
export class MVRParser extends KeyValueParser { documentType = "MVR" as const; fields = { driverName: ["Driver Name", "Name"], dob: ["DOB", "Date of Birth"], licenceNumber: ["DL", "Licence Number", "Driver Licence"], licenceClass: ["Licence Class", "Class"], licenceStatus: ["Licence Status", "Status"], issueDate: ["Issue Date"], expiryDate: ["Licence Expiry", "Expiry Date", "Expiry"], demeritPoints: ["Demerit Points"], requestDate: ["Requested Date", "Request Date"], releaseDate: ["Release Date"], replyDate: ["Reply Date"], receivedDate: ["Received Date"], conditions: ["Licence Conditions", "Conditions"] }; async parse(raw: RawExtractedDocument, context?: { fileName?: string }) { raw = reportRaw(raw); return enrichDriverReport(await super.parse({ ...raw, text: reportHeader(raw.text ?? "") }, context), raw); } }
export class DashParser extends KeyValueParser { documentType = "DASH" as const; fields = { priorInsurer: ["Prior Insurer", "Insurer"], priorPolicyNumber: ["Policy Number", "Policy"], priorEffective: ["Policy Effective", "Effective"], priorExpiry: ["Policy Expiry", "Expiry"], policyStatus: ["Policy Status", "Status"], insuredSince: ["Insured Since"], claimsJson: ["Claims JSON"] }; async parse(raw: RawExtractedDocument, context?: { fileName?: string }) { raw = reportRaw(raw); return enrichDriverReport(await super.parse({ ...raw, text: reportHeader(raw.text ?? "") }, context), raw); } }
export class HabApplicationParser extends KeyValueParser { documentType = "HAB_APPLICATION" as const; fields = { insurer: ["Insurance Company", "Carrier"], namedInsured: ["Named Insured", "Insured"], coInsured: ["Co-Insured"], effectiveDate: ["Effective Date"], priorInsurer: ["Previous Property Insurer", "Prior Insurer"], priorPolicyNumber: ["Previous Property Policy Number", "Prior Policy Number"], priorEffective: ["Prior Effective Date"], priorExpiry: ["Prior Expiry Date"], propertyInsuredSince: ["Property Insured Since"], continuouslyInsuredSince: ["Continuously Insured Since"], occupiedSince: ["Occupied Since"], riskAddress: ["Risk Address", "Property Address"], policyType: ["Policy Type"], numberOfMortgages: ["Number of Mortgages"], mortgageeAddress: ["Mortgagee Address"], mortgagee: ["Mortgagee"], natureOfInterest: ["Nature of Interest"], lossPayee: ["Loss Payee"], premium: ["Annual Premium", "Premium"], occupancy: ["Occupancy", "Occupancy Type"], structure: ["Structure", "Structure Type"], construction: ["Construction", "Construction Type"], exteriorFinish: ["Exterior Finish", "Exterior"], yearBuilt: ["Year Built"], families: ["Number of Families", "Families"], units: ["Number of Units", "Units"], livingArea: ["Living Area", "Square Feet"], bedrooms: ["Bedrooms"], bathrooms: ["Bathrooms"], garage: ["Garage Type", "Garage"], roof: ["Roof Type", "Roof"], plumbing: ["Plumbing"], electrical: ["Electrical"], heating: ["Heating"], smokeFree: ["Smoke Free", "Smoke-Free"], swimmingPool: ["Swimming Pool", "Pool"], dogExposure: ["Dog / Animal Exposure", "Dog Exposure"], rental: ["Rental Property", "Rental"], airbnb: ["Airbnb"], vacant: ["Vacant"], businessUse: ["Business Use"], annualPremium: ["Annual Premium"], mortgageeAddress: ["Mortgagee Address"] }; }
export class HabQuoteParser extends KeyValueParser { documentType = "HAB_QUOTE" as const; fields = { insurer: ["Insurance Company", "Carrier"], quoteNumber: ["Quote", "Submission"], namedInsured: ["Named Insured", "Insured"], coInsured: ["Co-Insured", "Co Insured", "Second Named Insured"], effectiveDate: ["Effective Date"], propertyInsuredSince: ["Property Insured Since"], continuouslyInsuredSince: ["Continuously Insured Since"], occupiedSince: ["Occupied Since"], riskAddress: ["Risk Address"], policyType: ["Policy Type"], mortgagee: ["Mortgagee"], lossPayee: ["Loss Payee"], premium: ["Annual Premium", "Premium"], occupancy: ["Occupancy", "Occupancy Type"], structure: ["Structure", "Structure Type"], construction: ["Construction", "Construction Type"], exteriorFinish: ["Exterior Finish", "Exterior"], yearBuilt: ["Year Built"], families: ["Number of Families", "Families"], units: ["Number of Units", "Units"], livingArea: ["Living Area", "Square Feet"], bedrooms: ["Bedrooms"], bathrooms: ["Bathrooms"], garage: ["Garage Type", "Garage"], roof: ["Roof Type", "Roof"], plumbing: ["Plumbing"], electrical: ["Electrical"], heating: ["Heating"], smokeFree: ["Smoke Free", "Smoke-Free"], swimmingPool: ["Swimming Pool", "Pool"], dogExposure: ["Dog / Animal Exposure", "Dog Exposure"], rental: ["Rental Property", "Rental"], airbnb: ["Airbnb"], vacant: ["Vacant"], businessUse: ["Business Use"], annualPremium: ["Annual Premium"], mortgageeAddress: ["Mortgagee Address"] }; }
export class PolicyChangeParser extends KeyValueParser { documentType = "POLICY_CHANGE" as const; fields = { namedInsured: ["Insured"], clientCode: ["Client Code"], policyNumber: ["Policy Number", "Policy"], insurer: ["Carrier", "Insurance Company"], requestedEffectiveDate: ["Requested Effective Date", "Effective Date"], vehicleOrProperty: ["Vehicle", "Property"], vin: ["VIN"], requestedAction: ["Requested Action", "Action"], freeTextInstruction: ["Instruction", "Request"], previousValue: ["Previous Value", "Old Value"], requestedValue: ["Requested Value", "New Value"], oldVin: ["Old VIN", "Previous VIN"], newVin: ["New VIN", "Replacement VIN"], oldVehicle: ["Old Vehicle", "Removed Vehicle"], newVehicle: ["New Vehicle", "Added Vehicle"], oldDriver: ["Previous Driver", "Old Driver"], newDriver: ["New Driver"], oldAddress: ["Previous Address", "Old Address"], newAddress: ["New Address"], previousAnnualKm: ["Previous Annual KM"], requestedAnnualKm: ["Requested Annual KM"], previousCommuteKm: ["Previous Commute KM"], requestedCommuteKm: ["Requested Commute KM"], coverageChanges: ["Coverage Change", "Coverage Changes"], endorsements: ["Endorsement Changes", "OPCF"], policyNumber: ["Policy Number"] }; }
export class OpcfFormParser extends KeyValueParser { documentType = "OPCF_FORM" as const; fields = { namedInsured: ["Insured"], policyNumber: ["Policy Number", "Policy"], endorsement: ["Endorsement", "OPCF"], action: ["Action"], vehicle: ["Vehicle"], vin: ["VIN"], requestedEffectiveDate: ["Requested Effective Date", "Effective Date"], requestedBy: ["Requested By"], reason: ["Reason", "Notes"] }; }
export class PortalScreenshotParser extends KeyValueParser { documentType = "PORTAL_SCREENSHOT" as const; fields = { namedInsured: ["Insured"], address: ["Address"], effectiveDate: ["Effective Date"], vin: ["VIN"], annualKm: ["Annual KM"], premium: ["Premium"] }; }
export class MortgageParser extends KeyValueParser { documentType = "MORTGAGE_DOCUMENT" as const; fields = { numberOfMortgages: ["Number of Mortgages"], mortgageeAddress: ["Mortgagee Address", "Address"], mortgagee: ["Mortgagee", "Bank", "Lender"], natureOfInterest: ["Nature of Interest"], lossPayee: ["Loss Payee"] }; }
export class PriorPolicyParser extends KeyValueParser { documentType = "PRIOR_AUTO_POLICY" as const; fields = { priorInsurer: ["Insurer", "Insurance Company"], priorPolicyNumber: ["Policy Number", "Policy"], priorEffective: ["Effective Date"], priorExpiry: ["Expiry Date"], coverage: ["Coverage"] }; }
export class CtsacApplicationParser extends KeyValueParser { documentType = "CTSAC_MEMBERSHIP_APPLICATION" as const; fields = { chineseName: ["Chinese Name", "中文姓名"], englishName: ["English Name", "Name in English"], phone: ["Phone", "Telephone"], email: ["Email"], wechat: ["WeChat"], cityProvince: ["City / Province", "City", "Province"], employerInstitution: ["Employer / Institution", "Employer", "Institution"], positionTitle: ["Position / Title", "Position", "Title"], fieldSpecialty: ["Field / Specialty", "Specialty"], highestDegree: ["Highest Degree"], university: ["University"], applicantSignature: ["Applicant Signature", "Signature"], applicationDate: ["Application Date", "Date"], internalStatus: ["CTSAC Status", "Status"], memberNumber: ["Member Number"], reviewDate: ["Review Date"] }; }
export class DiplomaParser extends KeyValueParser { documentType = "DIPLOMA" as const; fields = { holderName: ["Holder Name", "Name", "姓名"], dateOfBirth: ["Date of Birth", "DOB"], university: ["University", "Institution", "学校"], degree: ["Degree", "Diploma", "学位"], major: ["Major", "Specialty", "专业"], issueDate: ["Issue Date", "Graduation Date", "Date"], certificateNumber: ["Certificate Number", "Certificate No"], countryInstitution: ["Country / Institution", "Country"] }; }

const parsers: Partial<Record<DocumentType, DocumentParser>> = {
  AUTO_APPLICATION: new AutoApplicationParser(), AUTO_QUOTE: new AutoQuoteParser(), OWNERSHIP: new OwnershipParser(), BILL_OF_SALE: new BillOfSaleParser(), DRIVER_TRAINING_CERTIFICATE: new DriverTrainingCertificateParser(), MVR: new MVRParser(), DASH: new DashParser(), HAB_APPLICATION: new HabApplicationParser(), HAB_QUOTE: new HabQuoteParser(), POLICY_CHANGE: new PolicyChangeParser(), OPCF_FORM: new OpcfFormParser(), PORTAL_SCREENSHOT: new PortalScreenshotParser(), MORTGAGE_DOCUMENT: new MortgageParser(), PRIOR_AUTO_POLICY: new PriorPolicyParser(), PRIOR_PROPERTY_POLICY: new PriorPolicyParser(), CTSAC_MEMBERSHIP_APPLICATION: new CtsacApplicationParser(), DIPLOMA: new DiplomaParser(), DEGREE_CERTIFICATE: new DiplomaParser(),
};

export function parserFor(type: DocumentType) { return parsers[type] ?? null; }

function validationFor(parsed: ParsedSource | undefined, state: UploadedDocumentRecord["state"]) {
  const warnings = parsed?.warnings ?? [];
  return { presence: "FOUND" as const, parseStatus: state === "FAILED" ? "FAILED" as const : state === "NEEDS_REVIEW" ? "NEEDS_REVIEW" as const : "PARSED" as const, validationStatus: warnings.some((item) => item.severity === "high") ? "INCOMPLETE" as const : "NOT_EVALUATED" as const, missingFields: warnings.flatMap((item) => item.field ? [item.field] : []), warnings };
}

export function applyManualCorrection(record: UploadedDocumentRecord, field: string, correctedValue: unknown, correctedBy = "Broker"): UploadedDocumentRecord {
  if (!record.parsed || !(field in record.parsed.data)) return record;
  const originalExtractedValue = record.parsed.data[field];
  const correctedAt = new Date().toISOString();
  const parsed = { ...record.parsed, data: { ...record.parsed.data, [field]: correctedValue }, corrections: { ...record.parsed.corrections, [field]: { originalExtractedValue, correctedValue, correctedBy, correctedAt } }, fieldEvidence: { ...record.parsed.fieldEvidence, [field]: record.parsed.fieldEvidence[field] ?? [] } };
  const state = parsed.warnings.some((item) => item.field !== field && item.severity === "high") ? "NEEDS_REVIEW" as const : "PARSED" as const;
  return { ...record, parsed, state, validation: validationFor(parsed, state) };
}

export async function ingestFiles(files: File[], store: BrowserFileStore, extractor: DocumentExtractor): Promise<UploadedDocumentRecord[]> {
  return Promise.all(files.map(async (file) => {
    const id = crypto.randomUUID();
    store.register(id, file);
    const initial = classifyDocument(file.name, file.type);
    const input: ExtractionInput = { fileId: id, fileName: file.name, mimeType: file.type, documentType: initial.documentType };
    try {
      const raw = await extractor.extract(input);
      raw.metadata = { ...raw.metadata, fileId: id };
      raw.rawText ??= raw.text ?? raw.pages?.map((page) => page.text ?? "").join("\n") ?? ""; raw.normalizedText ??= normalizeOcrText(raw.rawText);
      raw.metadata = { ...raw.metadata, charactersExtracted: raw.rawText.length, pageCount: raw.pages?.length ?? 0, sanitizedPreview: sanitizedOcrPreview(raw.rawText) };
      const classification = classifyDocument(file.name, file.type, raw.normalizedText);
      const parser = parserFor(classification.documentType);
      const parsed = parser ? await parser.parse(raw, { fileName: file.name }) : undefined;
      raw.metadata = { ...raw.metadata, classification: classification.documentType, classificationConfidence: classification.confidence, parser: parser ? classification.documentType : "none", parserInvoked: parser ? classification.documentType : "none", parsedFieldCount: Object.keys(parsed?.data ?? {}).length };
      const needsReview = classification.confidence < .8 || (parsed?.confidence ?? 0) < .8;
      const state = needsReview || Boolean(parsed?.warnings.length) ? "NEEDS_REVIEW" as const : "PARSED" as const;
      return { id, fileName: file.name, mimeType: file.type, size: file.size, documentType: classification.documentType, classification, state, extractionVersion: EXTRACTION_PIPELINE_VERSION, parserVersion: PARSER_VERSION, staleExtraction: false, raw, parsed, validation: validationFor(parsed, state) };
    } catch (error) {
      return { id, fileName: file.name, mimeType: file.type, size: file.size, documentType: initial.documentType, classification: initial, state: "FAILED", validation: validationFor(undefined, "FAILED"), error: error instanceof Error ? error.message : "Extraction failed" };
    }
  }));
}

export async function reprocessDocument(record: UploadedDocumentRecord, extractor: DocumentExtractor, force = false): Promise<UploadedDocumentRecord> {
  if (!force) {
    const { reparseDocument } = await import("./local-reparse.ts");
    return reparseDocument(record);
  }
  const input = { fileId: record.id, fileName: record.fileName, mimeType: record.mimeType, documentType: record.documentType };
  try {
    const raw = await extractor.extract(input);
    raw.metadata = { ...raw.metadata, fileId: record.id };
    raw.rawText ??= raw.text ?? raw.pages?.map((page) => page.text ?? "").join("\n") ?? ""; raw.normalizedText ??= normalizeOcrText(raw.rawText);
    raw.metadata = { ...raw.metadata, charactersExtracted: raw.rawText.length, pageCount: raw.pages?.length ?? 0, sanitizedPreview: sanitizedOcrPreview(raw.rawText) };
    const classification = /manually classified/i.test(record.classification.reason) ? record.classification : classifyDocument(record.fileName, record.mimeType, raw.normalizedText);
    const parser = parserFor(classification.documentType);
    const parsed = parser ? await parser.parse(raw, { fileName: record.fileName }) : undefined;
    raw.metadata = { ...raw.metadata, classification: classification.documentType, classificationConfidence: classification.confidence, parser: parser ? classification.documentType : "none", parserInvoked: parser ? classification.documentType : "none", parsedFieldCount: Object.keys(parsed?.data ?? {}).length };
    const state = (parsed?.confidence ?? 0) < .8 || Boolean(parsed?.warnings.length) ? "NEEDS_REVIEW" as const : "PARSED" as const;
    const stamp = new Date().toISOString();
    const logicalDocuments = record.logicalDocuments?.map((item) => item.classificationSource === "MANUAL" ? item : {
      ...item,
      documentType: classification.documentType,
      title: classification.documentType.replaceAll("_", " "),
      parseStatus: state === "PARSED" ? "PARSED" as const : "NEEDS_REVIEW" as const,
      classificationSource: "AUTOMATIC" as const,
      classificationConfidence: classification.confidence,
      updatedAt: stamp,
    });
    return { ...record, documentType: classification.documentType, classification, logicalDocuments, extractionVersion: EXTRACTION_PIPELINE_VERSION, parserVersion: PARSER_VERSION, staleExtraction: false, raw, parsed, state, validation: validationFor(parsed, state), error: undefined };
  } catch (error) {
    return { ...record, state: "FAILED", error: error instanceof Error ? error.message : "Extraction failed" };
  }
}

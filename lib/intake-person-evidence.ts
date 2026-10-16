import type { InsuranceCase } from "./insurance-types.ts";
import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";
import { normalizePolicyChangeTransactions } from "./policy-change.ts";

/** Explicit, auditable manual declarations. Never inferred from OCR words such as "Signature". */
export interface IntakeEvidenceBinding {
  document_id: string;
  logical_document_id?: string;
  document_type: DocumentType;
  source_sha256: string;
  start_page?: number;
  end_page?: number;
}
export interface InsuredNameComparison {
  application: IntakeEvidenceBinding;
  quote: IntakeEvidenceBinding;
  application_names: string[];
  quote_names: string[];
  confirmed_at: string;
  confirmed_by: string;
}
export interface ChangeSignerAttestation extends IntakeEvidenceBinding {
  name: string;
  signature_page: number;
  verified_at: string;
  verified_by: string;
}

export const normalizedPersonName = (name: unknown): string =>
  typeof name === "string" ? name.normalize("NFKC").replace(/\s+/g, " ").trim().toUpperCase() : "";

// Comparison-only canonicalization. Original spelling and punctuation are retained in records.
const nameTokens = (name: unknown): string[] => {
  if (typeof name !== "string") return [];
  return name.normalize("NFKC").toUpperCase()
    .replace(/[.,'’\x60\-_/\\()[\]{}:;!?"“”‘]/g, " ")
    .split(/\s+/).filter(Boolean).sort();
};
export function sameNamedPersons(first: unknown, second: unknown): boolean {
  if (!Array.isArray(first) || !Array.isArray(second) || first.length === 0 ||
    first.length !== second.length || first.length > 8) return false;
  const left = first.map(nameTokens), right = second.map(nameTokens);
  const key = (tokens: string[]) => tokens.join(" ");
  if (left.some(tokens => tokens.length === 0 || key(tokens).length > 120) ||
      right.some(tokens => tokens.length === 0 || key(tokens).length > 120)) return false;
  // Reordered/punctuated names count as duplicates within the same policyholder list.
  if (new Set(left.map(key)).size !== left.length ||
      new Set(right.map(key)).size !== right.length) return false;
  const sortedLeft = left.map(key).sort(), sortedRight = right.map(key).sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
export function insuredPersonNames(item: InsuranceCase): string[] {
  const insured = item.insured;
  const others = insured?.co_insured ?? [];
  if (!insured || !Array.isArray(others)) return [];
  const names = [insured.name, ...others.map(person => person?.name)];
  if (!sameNamedPersons(names, names)) return [];
  return names.map(normalizedPersonName);
}
const overlaps = (a: number | undefined, b: number | undefined, start: number, end: number) =>
  (a ?? 1) <= end && (b ?? a ?? 1) >= start;

export function activeBoundEvidence(ref: IntakeEvidenceBinding | undefined,
  records: UploadedDocumentRecord[], types: DocumentType[]): boolean {
  if (!ref?.document_id || !ref.source_sha256 || !types.includes(ref.document_type)) return false;
  const record = records.find(r => r.id === ref.document_id);
  if (!record || !record.sourceHash || record.staleExtraction ||
    record.currentSourceHash === "MISSING" ||
    (record.currentSourceHash && record.currentSourceHash !== record.sourceHash) ||
    record.sourceHash !== ref.source_sha256) return false;
  const sections = record.logicalDocuments === undefined ?
    [{ id: undefined as string | undefined, documentType: record.documentType,
       presenceStatus: "FOUND" as const, startPage: 1 as number | undefined,
       endPage: record.pageCount }] : record.logicalDocuments;
  return sections.some(section =>
    section.id === ref.logical_document_id &&
    section.documentType === ref.document_type && types.includes(section.documentType) &&
    section.presenceStatus === "FOUND" &&
    (ref.logical_document_id === undefined ||
      (section.startPage === ref.start_page && section.endPage === ref.end_page)) &&
    !(record.withdrawnSectionRanges ?? []).some(range =>
      overlaps(section.startPage,section.endPage,range.startPage,range.endPage)));
}
export function nameComparisonEvidenceValid(item: InsuranceCase,
  records: UploadedDocumentRecord[]): boolean {
  const review = item.named_insured_comparison;
  if (!review || !review.confirmed_at || !review.confirmed_by ||
    !item.signed || !item.signed_verified_at) return false;
  const appType: DocumentType = item.case_type === "new_auto" ? "AUTO_APPLICATION" : "HAB_APPLICATION";
  const quoteType: DocumentType = item.case_type === "new_auto" ? "AUTO_QUOTE" : "HAB_QUOTE";
  return review.application.document_id === item.signed_document_id &&
    review.application.logical_document_id === item.signed_logical_document_id &&
    activeBoundEvidence(review.application,records,[appType]) &&
    activeBoundEvidence(review.quote,records,[quoteType]) &&
    sameNamedPersons(review.application_names,review.application_names) &&
    sameNamedPersons(review.quote_names,review.quote_names);
}
export function selectedChangeEvidenceTypes(item: InsuranceCase): DocumentType[] {
  const transactionTypes = normalizePolicyChangeTransactions(
    item.policy_change?.requested_action ?? "",item.policy_change?.transaction_types ?? []);
  return transactionTypes.includes("CANCELLATION") ? ["CANCELLATION_REQUEST"] :
    transactionTypes.includes("NAME_CHANGE") ? ["POLICY_CHANGE","OPCF_FORM"] :
    transactionTypes.includes("PAYMENT_CHANGE") ? ["PAYMENT_AUTHORIZATION","POLICY_CHANGE"] :
    ["POLICY_CHANGE","OPCF_FORM"];
}
export function isCancellationChange(item: InsuranceCase): boolean {
  return normalizePolicyChangeTransactions(item.policy_change?.requested_action ?? "",
    item.policy_change?.transaction_types ?? []).includes("CANCELLATION");
}
export function requiresSeparateSigners(item: InsuranceCase): boolean {
  return insuredPersonNames(item).length > 1 || isCancellationChange(item);
}
export function changeSignersValid(item: InsuranceCase, records: UploadedDocumentRecord[]): boolean {
  const signers = item.transaction_authorization?.signers;
  const people = insuredPersonNames(item);
  if (!people.length || !Array.isArray(signers) ||
    !sameNamedPersons(signers.map(s => s.name),people)) return false;
  const types = selectedChangeEvidenceTypes(item);
  return signers.every(s =>
    Boolean(s.verified_at && s.verified_by && s.logical_document_id) &&
    Number.isInteger(s.signature_page) && s.start_page !== undefined &&
    s.end_page !== undefined && s.signature_page >= s.start_page &&
    s.signature_page <= s.end_page && activeBoundEvidence(s,records,types));
}

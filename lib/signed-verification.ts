import type { InsuranceCase } from "./insurance-types.ts";
import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { markCaseIncomplete } from "./case-completion.ts";

export interface SignedEvidenceRef {
  documentId?: string;
  logicalDocumentId?: string;
  /**
   * Fingerprint captured at verify time. If the section is re-classified or
   * its pages change afterwards, the confirmation is revoked: the broker must
   * re-verify against the new evidence. Confirmations made before v7 carry no
   * fingerprint and fall back to live checks (application type, not withdrawn).
   */
  documentType?: string;
  startPage?: number;
  endPage?: number;
}

export interface SignedStatusChange {
  next: InsuranceCase;
  statusChanged: "keyed->incomplete" | null;
}

export type SignedVerifyResult =
  | { ok: true; next: InsuranceCase }
  | { ok: false; reason: "no-evidence" };

export type SignedEvidenceProblem =
  | "no-evidence"
  | "file-missing"
  | "file-reclassified"
  | "section-missing"
  | "section-reclassified"
  | "pages-changed"
  | "section-withdrawn";

export type SignedEvidenceValidity =
  | { valid: true }
  | { valid: false; reason: SignedEvidenceProblem };

const APPLICATION_TYPES: ReadonlySet<string> = new Set(["AUTO_APPLICATION", "HAB_APPLICATION"]);

/**
 * Broker manually confirms the signed application after visually verifying the
 * signed document. This is the ONLY path that sets signed=true: reconciliation,
 * OCR, document ingestion never set it on their own, and JSON import strips it
 * (see importJson in app/page.tsx). Evidence is required: without a real
 * uploaded file id the confirmation is rejected.
 */
export function applySignedVerified(
  item: InsuranceCase,
  evidence: SignedEvidenceRef | undefined,
  verifiedAt: string,
): SignedVerifyResult {
  if (!evidence?.documentId) return { ok: false, reason: "no-evidence" };
  return {
    ok: true,
    next: {
      ...item,
      signed: true,
      signed_verified_at: verifiedAt,
      signed_document_id: evidence.documentId,
      signed_logical_document_id: evidence.logicalDocumentId,
      signed_evidence_document_type: evidence.documentType,
      signed_evidence_start_page: evidence.startPage,
      signed_evidence_end_page: evidence.endPage,
    },
  };
}

/**
 * Broker revokes the signed confirmation. A case that was already marked
 * complete (keyed) goes back to incomplete, since the completion gate would no
 * longer pass.
 */
export function applySignedUnverified(item: InsuranceCase): SignedStatusChange {
  const cleared: InsuranceCase = {
    ...item,
    signed: false,
    signed_verified_at: undefined,
    signed_document_id: undefined,
    signed_logical_document_id: undefined,
    signed_evidence_document_type: undefined,
    signed_evidence_start_page: undefined,
    signed_evidence_end_page: undefined,
  };
  if (cleared.status === "keyed") {
    return { next: markCaseIncomplete(cleared), statusChanged: "keyed->incomplete" };
  }
  return { next: cleared, statusChanged: null };
}

/**
 * The uploaded file backing a signed confirmation was deleted or withdrawn.
 * The confirmation is no longer trustworthy: clear it the same way a manual
 * revocation does, so the case must be re-verified before completion.
 */
export function applySignedEvidenceWithdrawn(
  item: InsuranceCase,
  removedDocumentIds: string[],
): SignedStatusChange & { withdrawn: boolean } {
  if (!item.signed || !item.signed_document_id || !removedDocumentIds.includes(item.signed_document_id)) {
    return { next: item, statusChanged: null, withdrawn: false };
  }
  const { next, statusChanged } = applySignedUnverified(item);
  return { next, statusChanged, withdrawn: true };
}

function overlapsWithdrawn(
  ranges: { startPage: number; endPage: number }[] | undefined,
  startPage?: number,
  endPage?: number,
): boolean {
  return (ranges ?? []).some(
    (range) => (startPage ?? 1) <= range.endPage && (endPage ?? startPage ?? 1) >= range.startPage,
  );
}

/**
 * Re-checks the evidence behind a signed confirmation against the CURRENT
 * uploaded-file state. Catches everything a physical-deletion check misses:
 * the section was re-classified, its pages changed after re-segmentation, it
 * was withdrawn, or the whole file was re-classified. Pure and unit-tested.
 *
 * Confirmations made before v7 carry no fingerprint (no stored documentType /
 * pages): they fall back to live checks — the section/file must still be
 * classified as an application and must not be withdrawn.
 */
export function isSignedEvidenceStillValid(
  records: UploadedDocumentRecord[],
  item: InsuranceCase,
): SignedEvidenceValidity {
  if (!item.signed) return { valid: true };
  if (!item.signed_document_id) return { valid: false, reason: "no-evidence" };
  const record = records.find((candidate) => candidate.id === item.signed_document_id);
  if (!record) return { valid: false, reason: "file-missing" };

  if (item.signed_logical_document_id) {
    const section = (record.logicalDocuments ?? []).find(
      (candidate) => candidate.id === item.signed_logical_document_id,
    );
    if (!section || section.presenceStatus !== "FOUND") {
      return { valid: false, reason: "section-missing" };
    }
    const expectedType = item.signed_evidence_document_type;
    if (expectedType ? section.documentType !== expectedType : !APPLICATION_TYPES.has(section.documentType)) {
      return { valid: false, reason: "section-reclassified" };
    }
    if (
      item.signed_evidence_start_page !== undefined &&
      item.signed_evidence_end_page !== undefined &&
      section.startPage !== undefined &&
      section.endPage !== undefined &&
      (section.startPage !== item.signed_evidence_start_page ||
        section.endPage !== item.signed_evidence_end_page)
    ) {
      return { valid: false, reason: "pages-changed" };
    }
    if (overlapsWithdrawn(record.withdrawnSectionRanges, section.startPage, section.endPage)) {
      return { valid: false, reason: "section-withdrawn" };
    }
    return { valid: true };
  }

  // Whole-file evidence (no section): the file itself must still be an application.
  const expectedType = item.signed_evidence_document_type;
  if (expectedType ? record.documentType !== expectedType : !APPLICATION_TYPES.has(record.documentType)) {
    return { valid: false, reason: "file-reclassified" };
  }
  return { valid: true };
}

/**
 * v5 stored a document-checklist item id in signed_document_id instead of a
 * real uploaded-file id. Such confirmations can never resolve to real evidence
 * and must be re-verified. Detected by matching the stored id against the
 * case's own checklist.
 */
export function isLegacyChecklistSignedId(item: InsuranceCase): boolean {
  return Boolean(
    item.signed &&
      item.signed_document_id &&
      (item.documents ?? []).some((doc) => doc.id === item.signed_document_id),
  );
}

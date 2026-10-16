import type { InsuranceCase } from "./insurance-types.ts";
import { markCaseIncomplete } from "./case-completion.ts";

export interface SignedEvidenceRef {
  documentId?: string;
  logicalDocumentId?: string;
}

export interface SignedStatusChange {
  next: InsuranceCase;
  statusChanged: "keyed->incomplete" | null;
}

/**
 * Broker manually confirms the signed application after visually verifying the
 * signed document. This is the ONLY path that sets signed=true: reconciliation,
 * OCR, document ingestion and JSON import must never set it on their own.
 */
export function applySignedVerified(
  item: InsuranceCase,
  evidence: SignedEvidenceRef | undefined,
  verifiedAt: string,
): InsuranceCase {
  return {
    ...item,
    signed: true,
    signed_verified_at: verifiedAt,
    signed_document_id: evidence?.documentId,
    signed_logical_document_id: evidence?.logicalDocumentId,
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

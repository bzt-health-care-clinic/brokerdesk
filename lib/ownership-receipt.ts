import type { LogicalDocument, UploadedDocumentRecord } from "./extraction-types.ts";

/**
 * A physical Ownership receipt is not proof of its VIN, owner, or subject.
 *
 * The function may show "received" for a hashed, classified scan without a
 * parsable logical section. It must NOT be used as an intake verification gate.
 * Intake still requires independently active VIN evidence for each vehicle.
 */
export type OwnershipReceiptKind =
  | "MISSING"
  | "RECEIVED_NEEDS_VERIFICATION"
  | "RECEIVED_WITH_SECTION";

export interface OwnershipReceipt {
  kind: OwnershipReceiptKind;
  received: boolean;
  physicalFileIds: string[];
}

export function currentPhysicalFile(record: UploadedDocumentRecord): boolean {
  return Boolean(
    record.id && record.sourceHash &&
    !record.staleExtraction &&
    record.currentSourceHash !== "MISSING" &&
    (!record.currentSourceHash || record.currentSourceHash === record.sourceHash)
  );
}

export function sectionWithdrawn(
  record: UploadedDocumentRecord,
  section: Pick<LogicalDocument, "startPage" | "endPage">
): boolean {
  return (record.withdrawnSectionRanges ?? []).some(range =>
    (section.startPage ?? 1) <= range.endPage &&
    (section.endPage ?? section.startPage ?? 1) >= range.startPage
  );
}

function activeOwnershipSections(record: UploadedDocumentRecord): LogicalDocument[] {
  return (record.logicalDocuments ?? []).filter(section =>
    section.documentType === "OWNERSHIP" &&
    section.presenceStatus === "FOUND" &&
    !sectionWithdrawn(record, section)
  );
}

function physicallyClassifiedOwnership(record: UploadedDocumentRecord): boolean {
  // Never use a physical-container label to override explicit logical sections.
  // This fallback is only for a standalone scan with no logical analysis output.
  if (record.logicalDocuments !== undefined && record.logicalDocuments.length > 0) return false;
  if ((record.withdrawnSectionRanges ?? []).length > 0) return false;
  return record.documentType === "OWNERSHIP" ||
    record.classification?.documentType === "OWNERSHIP";
}

export function ownershipReceiptStatus(records: UploadedDocumentRecord[]): OwnershipReceipt {
  const fileIds: string[] = [];
  let hasSection = false;
  for (const record of records) {
    if (!currentPhysicalFile(record)) continue;
    const activeSections = activeOwnershipSections(record);
    if (!activeSections.length && !physicallyClassifiedOwnership(record)) continue;
    if (!fileIds.includes(record.id)) fileIds.push(record.id);
    if (activeSections.length > 0) hasSection = true;
  }
  return {
    kind: !fileIds.length ? "MISSING" : hasSection
      ? "RECEIVED_WITH_SECTION" : "RECEIVED_NEEDS_VERIFICATION",
    received: fileIds.length > 0,
    physicalFileIds: fileIds,
  };
}

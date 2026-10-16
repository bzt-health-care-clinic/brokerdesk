import type { Alert, InsuranceCase } from "./insurance-types.ts";
import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";
import { estimateBrokerFee } from "./monthly-payment.ts";

export interface UnderwritingReviewResult { alerts: Alert[]; fingerprints: Record<string, string> }
const nonPaymentCancellation = /\bcancell?ed\s*(?:[-—–:]\s*)?(?:due\s+to\s+)?(?:default(?:ing)?\s+(?:policy\s+)?payment|non[-\s]?payment|failure\s+to\s+pay|for\s+non[-\s]?payment)\b/i;
const uwLicenceMessage = /prior\s+insurance\s+history\s+does\s+not\s+support\s+licensed?\s+date/i;
const multilineMessage = /multi[-\s]?line\s+discount\s+is\s+provided/i;
const signatureDate = /APPLICANT['’]?S[\s\S]{0,120}?SIGNATURE[\s\S]{0,420}?(20\d{2}[\/-]\d{2}[\/-]\d{2})/i;
const auditSignDate = /Signed\s+At\s*:\s*(\d{2}-\d{2}-20\d{2})/i;
const documentTypeForPage = (record: UploadedDocumentRecord, page: number): DocumentType => {
  const section = (record.logicalDocuments ?? []).find(section =>
    section.presenceStatus === "FOUND" && (section.startPage ?? 1) <= page && (section.endPage ?? section.startPage ?? 1) >= page);
  return section?.documentType ?? record.packagePages?.find(item => item.page === page)?.classification.documentType ?? record.documentType;
};
function activeTexts(record: UploadedDocumentRecord) {
  if (record.staleExtraction) return [];
  if (record.packagePages?.length) return record.packagePages.filter(page =>
    page.extractionStatus === "COMPLETE" && !record.withdrawnSectionRanges?.some(range =>
      page.page >= range.startPage && page.page <= range.endPage)).map(page => ({
        type: documentTypeForPage(record, page.page),
        text: page.text ?? "",
        page: page.page,
      }));
  // Older non-package records remain reviewable, but never create a page provenance guess.
  const text = record.raw?.rawText ?? record.raw?.normalizedText ?? record.raw?.text ?? "";
  return text ? [{ type: record.documentType, text, page: 0 }] : [];
}
function reviewAlert(
  code: Alert["code"], severity: Alert["severity"], message: string, resolved = false,
): Alert {
  return { id: `underwriting-${code}`, code, severity, message, resolved };
}
function normalizeFormDate(value: string) {
  const [year, month, day] = value.replaceAll("/", "-").split("-");
  return `${year}-${month}-${day}`;
}
function normalizeAuditDate(value: string) {
  const [month, day, year] = value.split("-");
  return `${year}-${month}-${day}`;
}

/**
 * Read-only review of the active, saved physical/document-section evidence.
 * Do NOT infer an application's checkbox answer from extracted "Yes No" text:
 * the check mark is usually an annotation or graphic omitted by text extraction.
 */
export function reviewUploadedDocuments(item: InsuranceCase, records: UploadedDocumentRecord[]): UnderwritingReviewResult {
  const alerts: Alert[] = [];
  const fingerprints: Record<string, string> = {};
  if (item.case_type === "new_auto") {
    const cancellation: Array<{ documentId: string; page: number; sourceHash: string; label: string }> = [];
    const licence: string[] = [];
    const multi: string[] = [];
    for (const record of records) {
      for (const page of activeTexts(record)) {
        const isQuote = page.type === "AUTO_QUOTE" || record.documentType === "AUTO_QUOTE";
        const isDash = page.type === "DASH" || record.documentType === "DASH";
        if (!isQuote && !isDash) continue;
        if (nonPaymentCancellation.test(page.text)) {
          cancellation.push({ documentId: record.id, page: page.page, sourceHash: record.sourceHash ?? "", label: isDash ? "DASH" : "Auto Quote" });
        }
        if (isQuote && uwLicenceMessage.test(page.text)) licence.push(record.id);
        if (isQuote && multilineMessage.test(page.text)) multi.push(record.id);
      }
    }
    if (cancellation.length) {
      // Two different phrasings describe the SAME cancellation fact: do not
      // manufacture a source conflict. One review item with both source labels.
      const origins = [...new Set(cancellation.map(entry => entry.label))].sort();
      const fingerprint = cancellation.map(entry =>
        `${entry.documentId}:${entry.sourceHash}:${entry.page}`).sort().join("|");
      fingerprints.PRIOR_NONPAYMENT_CANCELLATION_REVIEW = fingerprint;
      const reviewed = (item.broker_overrides ?? []).some(override =>
        override.alert_code === "PRIOR_NONPAYMENT_CANCELLATION_REVIEW" &&
        override.evidence_fingerprint === fingerprint && Boolean(override.reason.trim()));
      alerts.push(reviewAlert("PRIOR_NONPAYMENT_CANCELLATION_REVIEW", "high",
        `Prior auto policy cancelled for non-payment (${origins.join(" + ")}). Review the signed application's three-year cancellation question, confirm accurate underwriting disclosure and record the broker review. Quote and DASH cancellation wording is equivalent, not a discrepancy.`, reviewed));
    }
    if (licence.length) alerts.push(reviewAlert("LICENCE_HISTORY_UW_REVIEW", "medium",
      "Auto quote warns that prior insurance history does not support the licensed date. Confirm Canadian/U.S. licensing evidence and UW response."));
    if (multi.length) alerts.push(reviewAlert("MULTILINE_DISCOUNT_SUPPORT_REVIEW", "medium",
      "Auto quote includes a multi-line discount. Confirm eligible matching named insured and the required property-policy proof; never link unrelated insureds."));
  }
  if (item.case_type === "new_home") {
    const homeQuoteHasMultiLine = records.some(record =>
      activeTexts(record).some(page => (page.type === "HAB_QUOTE" || record.documentType === "HAB_QUOTE") &&
        /multi[-\\s]?line\\s+discount/i.test(page.text)));
    if (homeQuoteHasMultiLine) alerts.push(reviewAlert("MULTILINE_DISCOUNT_SUPPORT_REVIEW", "medium",
      "Home quote includes a multi-line discount. Review required matching named insured and eligible auto-policy proof; another customer's auto policy cannot substantiate this discount."));
  }
  if (item.case_type === "new_home" || item.case_type === "new_auto") {
    for (const record of records) {
      if (!(record.documentType === "HAB_APPLICATION" || record.documentType === "AUTO_APPLICATION" ||
          (record.logicalDocuments ?? []).some(x => x.documentType === "HAB_APPLICATION" || x.documentType === "AUTO_APPLICATION"))) continue;
      const pages = activeTexts(record);
      const formDate = pages.map(p => p.text.match(signatureDate)?.[1]).find(Boolean);
      const auditDate = pages.map(p => p.text.match(auditSignDate)?.[1]).find(Boolean);
      if (formDate && auditDate && normalizeFormDate(formDate) !== normalizeAuditDate(auditDate)) {
        alerts.push(reviewAlert("SIGNATURE_DATE_REVIEW", "medium",
          "Application form signature date differs from electronic signing audit timestamp. Visually review the signed page and audit trail; never auto-change a signature date."));
        break;
      }
    }
  }
  // Formula display is a broker estimate, not an insurer-approved finance tariff.
  const premium = item.payment.annual_premium ?? item.premium.quoted_annual;
  if ((item.case_type === "new_auto" || item.case_type === "new_home") &&
      /month/i.test(item.payment.plan) && premium != null) {
    const estimate = estimateBrokerFee(premium, item.case_type === "new_auto" ? "AUTO" : "HAB", "monthly");
    if (estimate && item.payment.total_cost != null && Math.abs(estimate.total - item.payment.total_cost) > 0.02) {
      alerts.push(reviewAlert("MONTHLY_PAYMENT_FEE_REVIEW", "medium",
        "Stored payment total differs from the broker worksheet estimate. Check carrier finance fees, payment schedule and tax; the worksheet is guidance, not an insurer tariff."));
    }
  }
  return { alerts, fingerprints };
}

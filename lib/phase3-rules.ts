import type { Alert, GroupDiscountValidation, InsuranceCase, TransactionIntent } from "./insurance-types.ts";
import { carrierRuleFor } from "./carrier-rules.ts";
import { comparePersonNames } from "./reconciliation.ts";

const overridden = (data: InsuranceCase, code: Alert["code"]) => data.broker_overrides?.some((item) => item.alert_code === code) ?? false;
const makeAlert = (data: InsuranceCase, code: Alert["code"], severity: Alert["severity"], message: string, field?: string, resolved = false): Alert => ({ id: `phase3-${code}-${field ?? "case"}`, code, severity, message, field, resolved: resolved || overridden(data, code) });

export function evaluateGroupDiscount(data: InsuranceCase): { validation: GroupDiscountValidation; alerts: Alert[] } {
  const carrierRule = carrierRuleFor(data.policy.company);
  const current = data.group_discount ?? { selected: false, status: carrierRule ? "NOT_CONFIRMED" : "NOT_APPLICABLE" };
  if (!carrierRule) return { validation: { ...current, status: "NOT_APPLICABLE" }, alerts: [] };
  if (!current.selectionConfirmed) return { validation: { ...current, status: "NOT_CONFIRMED" }, alerts: [makeAlert(data, "GROUP_DISCOUNT_SELECTION_UNCONFIRMED", "medium", "Confirm whether the Economical/Definity group discount is selected.", "group_discount.selected")] };
  if (!current.selected) return { validation: { ...current, status: "NOT_SELECTED" }, alerts: [] };
  const alerts: Alert[] = [];
  if (current.membershipDecision?.evidenceReview) alerts.push({ id: "membership-evidence-review", code: "EVIDENCE_REVIEW", severity: "high", message: "Membership decision retained, but its supporting evidence changed or was withdrawn. Review is required.", field: "group_discount.membershipDecision", resolved: false });
  const application = current.activeEvidence?.application.length ? current.ctsac_application : undefined;
  const diploma = current.activeEvidence?.diploma.length ? current.diploma : undefined;
  if (!application || !diploma) {
    alerts.push(makeAlert(data, "GROUP_DISCOUNT_DOCUMENT_MISSING", "high", "CTSAC application and degree/diploma evidence are both required for this group discount.", "group_discount.documents"));
    if (!application) alerts.push(makeAlert(data, "CTSAC_APPLICATION_MISSING", "high", "CTSAC Membership Application missing.", "group_discount.ctsac_application"));
    if (!diploma) alerts.push(makeAlert(data, "DIPLOMA_MISSING", "high", "Degree / Diploma supporting document missing.", "group_discount.diploma"));
    return { validation: { ...current, status: "MISSING_DOCUMENTS" }, alerts };
  }
  const hasName = Boolean(application.english_name || application.chinese_name);
  const hasContact = Boolean(application.phone || application.email);
  const hasProfessional = Boolean(application.employer_institution || application.position_title || application.field_specialty);
  const complete = hasName && hasContact && hasProfessional && Boolean(application.highest_degree && application.university && application.applicant_signature && application.application_date);
  if (!complete) alerts.push(makeAlert(data, "CTSAC_APPLICATION_INCOMPLETE", "high", "CTSAC application is incomplete. Name, contact, education/professional background, degree, university, signature, and date are required.", "group_discount.ctsac_application"));
  if (diploma.readable === false || !diploma.holder_name || !diploma.university || !diploma.degree) alerts.push(makeAlert(data, "DIPLOMA_UNREADABLE", "high", "Degree / Diploma must show holder name, educational institution, and degree evidence.", "group_discount.diploma"));

  const named = data.insured.name;
  const englishMatch = application.english_name ? comparePersonNames(named, application.english_name) : false;
  const diplomaEnglishMatch = diploma.holder_name ? comparePersonNames(named, diploma.holder_name) : false;
  const bilingualDocumentMatch = Boolean(application.chinese_name && diploma.holder_name && application.chinese_name.trim() === diploma.holder_name.trim());
  let identityStatus: GroupDiscountValidation["identity_status"] = "NEEDS_CONFIRMATION";
  if (englishMatch && diplomaEnglishMatch) identityStatus = "MATCH";
  else if (englishMatch && bilingualDocumentMatch) identityStatus = "PARTIAL_MATCH";
  else if ((application.english_name && !englishMatch) || (diploma.holder_name && !diplomaEnglishMatch && !bilingualDocumentMatch)) identityStatus = "CONFLICT";
  if (identityStatus === "CONFLICT") alerts.push(makeAlert(data, "DIPLOMA_NAME_MISMATCH", "high", "Diploma holder name conflicts with the named insured / CTSAC applicant.", "group_discount.identity"));
  else if (identityStatus === "NEEDS_CONFIRMATION") alerts.push(makeAlert(data, "GROUP_DISCOUNT_IDENTITY_UNCONFIRMED", "high", "Group discount applicant identity is not confirmed across the insured, CTSAC application, and diploma.", "group_discount.identity"));

  if (application.internal_status === "pending") alerts.push(makeAlert(data, "CTSAC_MEMBERSHIP_PENDING", "high", "CTSAC membership is pending.", "group_discount.membership_status"));
  else if (application.internal_status === "declined") alerts.push(makeAlert(data, "CTSAC_MEMBERSHIP_DECLINED", "high", "CTSAC membership is declined; group discount is not eligible.", "group_discount.membership_status"));
  else if (!application.internal_status || application.internal_status === "not_confirmed") alerts.push(makeAlert(data, "CTSAC_STATUS_UNCONFIRMED", "medium", "CTSAC status is not confirmed.", "group_discount.membership_status"));

  const hardFailure = alerts.some((item) => !item.resolved && item.severity === "high");
  const fullyValid = !hardFailure && alerts.every((item) => item.resolved) && application.internal_status === "approved" && (identityStatus === "MATCH" || identityStatus === "PARTIAL_MATCH");
  const status = application.internal_status === "declined" ? "FAILED" : application.internal_status === "pending" ? "PENDING_MEMBERSHIP" : fullyValid ? "VALIDATED" : "NEEDS_REVIEW";
  if (fullyValid) alerts.push(makeAlert(data, "GROUP_DISCOUNT_VALIDATED", "info", "Group discount evidence validated.", "group_discount", true));
  return { validation: { ...current, identity_status: identityStatus, status }, alerts };
}

export function checkQuoteLineOfBusiness(data: InsuranceCase): Alert[] {
  const auto = data.policy.auto_quote_number;
  const hab = data.policy.hab_quote_number;
  const source = data.field_sources.find((item) => item.field === "quoteLineOfBusiness" || item.field === "quote_number_line_of_business");
  if (source?.status === "conflict" || (auto && hab && auto === hab)) return [makeAlert(data, "QUOTE_NUMBER_LINE_OF_BUSINESS_CONFLICT", "high", "Auto and Home quote numbers are not clearly separated by line of business.", "quoteLineOfBusiness")];
  return [];
}

export function checkEffectiveDateIntent(data: InsuranceCase): Alert[] {
  const source = data.field_sources.find((item) => item.field === "effectiveDate" || item.field === "effective_date");
  const confirmed = data.client_confirmed_facts?.some((item) => item.field === "effectiveDate" || item.field === "effective_date");
  return source?.status === "conflict" && !confirmed ? [makeAlert(data, "EFFECTIVE_DATE_CONFLICT", "high", "Effective date conflict — confirm the most recent signed/client transaction intention.", "effectiveDate")] : [];
}

export function checkAutoCompletion(data: InsuranceCase): Alert[] {
  if (data.case_type !== "new_auto") return [];
  const alerts: Alert[] = [];
  if (data.drivers.length === 0) alerts.push(makeAlert(data, "REQUIRED_DRIVER_MISSING", "high", "At least one Auto driver is required.", "drivers"));
  for (const driver of data.drivers) if (!driver.mvr_received) alerts.push(makeAlert(data, "MVR_RECEIVED_DATE_MISSING", "high", `MVR received date is missing for ${driver.name}.`, "mvr_received"));
  return alerts;
}

export function runPhase3Rules(data: InsuranceCase): Alert[] {
  return [...checkQuoteLineOfBusiness(data), ...checkEffectiveDateIntent(data), ...checkAutoCompletion(data), ...evaluateGroupDiscount(data).alerts];
}

export function withGroupDiscountStatus(data: InsuranceCase): InsuranceCase {
  return { ...data, group_discount: evaluateGroupDiscount(data).validation };
}

export function determineTransactionIntent(finalInstruction: string): TransactionIntent {
  const text = finalInstruction.toLowerCase();
  if (/substitut|replace/.test(text)) return "SUBSTITUTE";
  if (/restore.*coverage|add back.*coverage/.test(text)) return "RESTORE_COVERAGE";
  if (/remove.*coverage/.test(text)) return "REMOVE_COVERAGE";
  if (/add.*driver/.test(text)) return "DRIVER_ADD";
  if (/(delete|remove).*driver/.test(text)) return "DRIVER_DELETE";
  if (/address/.test(text)) return "ADDRESS_CHANGE";
  if (/(delete|remove).*vehicle/.test(text)) return "DELETE";
  if (/add.*vehicle/.test(text)) return "ADD";
  if (/amend|change|correct/.test(text)) return "AMEND";
  return "OTHER";
}

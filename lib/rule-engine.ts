import { assessClaims, type ClaimAssessment } from "./claim-assessment.ts";
export { partitionClaims } from "./claim-assessment.ts";
import type {
  Alert,
  Claim,
  FieldSource,
  InsuranceCase,
  RuleConfig,
} from "./insurance-types.ts";
import { DEFAULT_RULE_CONFIG } from "./insurance-types.ts";
import { isPolicyChange, runPolicyChangeRules } from "./policy-change.ts";
import { canonicalFieldKey } from "./field-keys.ts";

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();
const alert = (
  code: Alert["code"],
  severity: Alert["severity"],
  message: string,
  field?: string,
  source?: FieldSource,
): Alert => ({
  id: `${code}-${field ?? "case"}`,
  code,
  severity,
  message,
  field,
  sourceValues: source?.values,
  resolved: source?.status === "resolved",
});

const isAuto = (data: InsuranceCase) =>
  data.case_type === "new_auto" || data.case_type === "auto_policy_change";

const source = (data: InsuranceCase, field: string) =>
  data.field_sources.find((item) => canonicalFieldKey(item.canonicalField ?? item.field) === canonicalFieldKey(field));

export function checkOwnership(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  if (!data.ownership?.received) {
    return [
      alert(
        "OWNERSHIP_MISSING",
        "high",
        "Ownership missing — please provide ownership before completing Auto review.",
        "ownership",
      ),
    ];
  }
  return [];
}

export function checkVin(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.ownership?.received || !data.vehicles[0]) return [];
  if (norm(data.ownership.vin) === norm(data.vehicles[0].vin)) return [];
  return [
    alert(
      "VIN_MISMATCH",
      "high",
      "Ownership VIN does not match application VIN.",
      "vin",
      source(data, "vin"),
    ),
  ];
}

export function checkVehicle(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.ownership?.received || !data.vehicles[0]) return [];
  const permit = data.ownership;
  const vehicle = data.vehicles[0];
  const mismatch =
    permit.year !== vehicle.year ||
    norm(permit.make) !== norm(vehicle.make) ||
    norm(permit.model) !== norm(vehicle.model);
  return mismatch
    ? [alert("VEHICLE_MISMATCH", "high", "Ownership vehicle does not match quoted vehicle.", "vehicle", source(data, "vehicle"))]
    : [];
}

export function checkNamedInsured(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.ownership?.received) return [];
  const owners = [data.ownership.registered_owner, ...(data.ownership.additional_owners ?? [])].map(norm);
  return owners.includes(norm(data.insured.name))
    ? []
    : [alert("OWNER_MISMATCH", "high", `Registered owner is ${data.ownership.registered_owner}, not ${data.insured.name}.`, "registered_owner", source(data, "registered_owner"))];
}

export function checkCoInsured(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.ownership?.received || data.insured.co_insured.length === 0) return [];
  const owners = [data.ownership.registered_owner, ...(data.ownership.additional_owners ?? [])].map(norm);
  return data.insured.co_insured
    .filter((person) => !owners.includes(norm(person.name)))
    .map((person) =>
      alert(
        "COINSURED_REVIEW",
        "high",
        `Co-Insured review required. Ownership and principal driver are ${data.ownership?.registered_owner} only. ${person.name} is listed as co-insured on Auto application. Consider removing co-insured.`,
        "co_insured",
        source(data, "co_insured"),
      ),
    );
}

export function checkLessor(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.ownership?.lessor || !data.vehicles[0]?.lessor) return [];
  const ownershipLessor = data.ownership.lessor;
  const applicationLessor = data.vehicles[0].lessor;
  const mismatched = norm(ownershipLessor.name) !== norm(applicationLessor.name) || norm(ownershipLessor.address) !== norm(applicationLessor.address);
  return mismatched
    ? [alert("LESSOR_MISMATCH", "medium", "Lessor address mismatch.", "lessor", source(data, "lessor"))]
    : [];
}

export function checkPriorPolicy(data: InsuranceCase): Alert[] {
  const alerts: Alert[] = [];
  const priorInsurer = source(data, "prior_insurer");
  if (priorInsurer?.status === "conflict") {
    alerts.push(alert("PRIOR_INSURER_CONFLICT", "high", "Prior insurer conflict.", "prior_insurer", priorInsurer));
  }
  if (data.prior_insurance.expiry_date && data.policy.effective_date && data.prior_insurance.expiry_date > data.policy.effective_date) {
    alerts.push(alert("PRIOR_POLICY_ACTIVE", "high", "Prior policy appears active after new policy inception. Confirm cancellation/replacement date before submission.", "prior_insurance.expiry_date", source(data, "prior_expiry")));
  }
  return alerts;
}

export function checkClaims(data: InsuranceCase, review: ClaimAssessment = assessClaims(data)): Alert[] {
  const alerts = data.claims.filter(claim => claim.source_active !== false && claim.portal_present === false).map(claim => alert("CLAIM_MISSING", "high", `Claim missing from portal: ${claim.loss_date || "date unknown"} — ${claim.loss_amount == null ? "amount unknown" : "$" + claim.loss_amount.toLocaleString()} — ${claim.at_fault_percent == null ? "fault unknown" : claim.at_fault_percent + "% AF"} (assessment: ${review.assessmentDate ?? "UNDETERMINED"}).`, "claims"));
  if (data.claims.length && !review.assessmentDate) alerts.push(alert("EVIDENCE_REVIEW", "medium", "Claim period classification is undetermined: the intended policy/change effective date is missing or invalid.", "claims.assessmentDate"));
  for (const claim of data.claims) if (claim.association_status === "UNASSIGNED" || claim.evidence_review || claim.possible_duplicate_ids?.length) alerts.push({ ...alert("EVIDENCE_REVIEW", "medium", `Claim ${claim.claim_number || claim.id}: ${claim.evidence_review ? "support withdrawn; manual facts retained" : claim.association_status === "UNASSIGNED" ? "claim driver association is unconfirmed" : "possible duplicate source records; not merged or summed"}.`, "claims"), id: `claim-review-${claim.id}` });
  return alerts;
}

export function checkMvr(data: InsuranceCase): Alert[] {
  return data.drivers.flatMap((driver) => {
    const alerts: Alert[] = [];
    if (driver.mvr_issue_date && driver.g_date && driver.mvr_issue_date !== driver.g_date) {
      const licenceSource = source(data, `licence_dates:${driver.name}`);
      if (licenceSource?.status === "conflict") alerts.push(alert("LICENCE_DATE_CONFLICT", "medium", `Licence date conflict for ${driver.name}. MVR Issue Date has not overwritten G/G2/G dates.`, "licence_dates", licenceSource));
    }
    if (driver.mvr_convictions && JSON.stringify(driver.convictions) !== JSON.stringify(driver.mvr_convictions)) {
      alerts.push(alert("MVR_CONVICTION_MISMATCH", "high", `Conviction information differs from MVR for ${driver.name}.`, "convictions", source(data, `convictions:${driver.name}`)));
    }
    return alerts;
  });
}

export function checkTelematics(data: InsuranceCase): Alert[] {
  return data.drivers.flatMap((driver) => {
    if (!driver.telematics.enabled) return [];
    const alerts: Alert[] = [];
    if (!driver.telematics.phone) alerts.push(alert("TELEMATICS_PHONE_MISSING", "medium", "Telematics phone missing — registered email found but no registered mobile number confirmed.", "telematics.phone"));
    if (!driver.telematics.email) alerts.push(alert("TELEMATICS_EMAIL_MISSING", "medium", "Telematics email missing — no registered app email confirmed.", "telematics.email"));
    return alerts;
  });
}

export function checkCoverage(data: InsuranceCase): Alert[] {
  return data.coverage.comparison.flatMap((row) => {
    if (!row.required) return [];
    if (row.portal === null || norm(row.portal) === "missing") {
      const endorsement = /^opcf|endorsement/i.test(row.name);
      return [alert(endorsement ? "ENDORSEMENT_MISSING" : "COVERAGE_MISSING", "high", `${row.name} is missing from portal.`, `coverage:${row.name}`)];
    }
    return [];
  });
}

export function checkPremium(data: InsuranceCase, config: RuleConfig): Alert[] {
  const quote = data.premium.quoted_annual;
  const portal = data.premium.portal_annual;
  if (quote === null || portal === null || quote === 0) return [];
  const difference = portal - quote;
  const percentage = Math.abs(difference / quote);
  return Math.abs(difference) > config.premiumDifferenceDollars || percentage > config.premiumDifferencePercent
    ? [alert("PREMIUM_DISCREPANCY", percentage > 0.1 ? "high" : "medium", "Premium discrepancy.", "premium", source(data, "premium"))]
    : [];
}

export function checkPropertyInsuranceHistory(data: InsuranceCase): Alert[] {
  const item = source(data, "property_insured_since");
  return item?.status === "conflict"
    ? [alert("PROPERTY_INSURED_SINCE_CONFLICT", "medium", "Property Insured Since conflict.", "property_insured_since", item)]
    : [];
}

export function checkMortgage(data: InsuranceCase): Alert[] {
  if (!data.habitational_risk || !data.mortgage || data.mortgage.number_of_mortgages == null || data.mortgage.number_of_mortgages === 0) return [];
  return data.mortgage.mortgagees.length === 0
    ? [alert("MORTGAGE_MISSING", "high", "Mortgage information is required but no mortgagee details were provided.", "mortgage")]
    : [];
}

export function checkDocuments(data: InsuranceCase): Alert[] {
  return data.documents
    .filter((document) => document.required && !document.received)
    .filter((document) => !(isAuto(data) && document.category === "ownership"))
    .map((document) => alert("SUPPORTING_DOCUMENT_MISSING", "high", `${document.name} missing.`, `document:${document.category}`));
}

export function runRules(data: InsuranceCase, config: RuleConfig = DEFAULT_RULE_CONFIG, claimReview: ClaimAssessment = assessClaims(data, config)): Alert[] {
  const evidenceAlerts: Alert[] = data.field_sources.filter(field => field.status === "conflict" || field.associationReview || field.evidenceReview).map(field => ({ id: `evidence-${field.field}`, code: field.status === "conflict" ? "SOURCE_CONFLICT" : "EVIDENCE_REVIEW", severity: field.status === "conflict" ? "high" : "medium", message: `${field.canonicalField ?? field.field}: ${field.associationReview ? "subject association not confirmed" : field.evidenceReview ? "supporting evidence changed or withdrawn; broker decision retained for review" : "conflicting active sources"}.`, field: field.field, sourceValues: field.values, resolved: false }));
  evidenceAlerts.push(...(data.provenanceWarnings ?? []).map((message, index): Alert => ({ id: `provenance-${index}`, code: "EVIDENCE_REVIEW", severity: "medium", message, resolved: false })));
  if (isPolicyChange(data)) return [...runPolicyChangeRules(data), ...checkPremium(data, config), ...evidenceAlerts];
  return [
    ...evidenceAlerts,
    ...checkOwnership(data),
    ...checkNamedInsured(data),
    ...checkCoInsured(data),
    ...checkVin(data),
    ...checkVehicle(data),
    ...checkLessor(data),
    ...checkPriorPolicy(data),
    ...checkMvr(data),
    ...checkClaims(data, claimReview),
    ...checkTelematics(data),
    ...checkCoverage(data),
    ...checkPremium(data, config),
    ...checkPropertyInsuranceHistory(data),
    ...checkMortgage(data),
    ...checkDocuments(data),
  ];
}

export function deriveStatus(data: InsuranceCase, alerts: Alert[]): InsuranceCase["status"] {
  if (data.status === "keyed" || data.status === "incomplete" || data.status === "on_hold") return data.status;
  const unresolved = alerts.filter((item) => !item.resolved);
  if (!data.signed || unresolved.some((item) => item.code === "OWNERSHIP_MISSING" || item.code === "SUPPORTING_DOCUMENT_MISSING")) return "missing_documents";
  if (data.uw_referral_pending) return "refer_uw";
  if (unresolved.some((item) => item.severity === "high")) return "needs_confirmation";
  if (unresolved.length > 0) return "needs_confirmation";
  return "ready_to_key_in";
}

export function resolveField(data: InsuranceCase, field: string, value: unknown, note = "", user = "Broker"): InsuranceCase {
  return {
    ...data,
    field_sources: data.field_sources.map((item) =>
      item.field === field
        ? { ...item, resolved_value: value, status: "resolved", evidenceReview: false, resolved_by_user: user, resolved_at: new Date().toISOString(), resolution_note: note }
        : item,
    ),
  };
}

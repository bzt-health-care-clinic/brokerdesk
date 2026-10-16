import { assessClaims, type ClaimAssessment } from "./claim-assessment.ts";
export { partitionClaims } from "./claim-assessment.ts";
import type {
  Alert,
  Claim,
  Conviction,
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

function vehicleOwnership(data: InsuranceCase, index: number) {
  const vehicle = data.vehicles[index];
  if (!vehicle) return undefined;
  if (vehicle.ownership?.received) return vehicle.ownership;
  if (data.vehicles.length === 1 && data.ownership?.received) return data.ownership;
  if (data.ownership?.received && vehicle.vin && norm(data.ownership.vin) === norm(vehicle.vin)
    && data.vehicles.filter(item => norm(item.vin) === norm(vehicle.vin)).length === 1) return data.ownership;
  return undefined;
}

const vehicleLabel = (data: InsuranceCase, index: number) => `vehicle ${index + 1}${data.vehicles[index].vin ? ` (${data.vehicles[index].vin})` : ""}`;

export function checkOwnership(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  if (!data.vehicles.length) return data.ownership?.received ? [] : [alert("OWNERSHIP_MISSING", "high", "Ownership missing — please provide ownership before completing Auto review.", "ownership")];
  return data.vehicles.flatMap((_, index) => vehicleOwnership(data, index) ? [] : [alert("OWNERSHIP_MISSING", "high", `Ownership missing for ${vehicleLabel(data, index)}.`, `vehicles.${index}.ownership`)]);
}

export function checkVin(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  return data.vehicles.flatMap((vehicle, index) => {
    const permit = vehicleOwnership(data, index); if (!permit) return [];
    if (vehicle.vin && permit.vin && norm(permit.vin) === norm(vehicle.vin)) return [];
    return [alert("VIN_MISMATCH", "high", `Ownership VIN is missing or does not match ${vehicleLabel(data, index)}.`, `vehicles.${index}.vin`, source(data, "vin"))];
  });
}

export function checkVehicle(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  return data.vehicles.flatMap((vehicle, index) => {
    const permit = vehicleOwnership(data, index); if (!permit) return [];
    const mismatch = !permit.year || !vehicle.year || permit.year !== vehicle.year ||
      !permit.make || !vehicle.make || norm(permit.make) !== norm(vehicle.make) ||
      !permit.model || !vehicle.model || norm(permit.model) !== norm(vehicle.model);
    return mismatch ? [alert("VEHICLE_MISMATCH", "high", `Ownership year/make/model is missing or does not match ${vehicleLabel(data, index)}.`, `vehicles.${index}.vehicle`, source(data, "vehicle"))] : [];
  });
}

export function checkNamedInsured(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  const permits = data.vehicles.length ? data.vehicles.map((_, index) => [vehicleOwnership(data, index), index] as const) : [[data.ownership?.received ? data.ownership : undefined, 0] as const];
  return permits.flatMap(([permit, index]) => {
    if (!permit) return [];
    const owners = [permit.registered_owner, ...(permit.additional_owners ?? [])].filter(Boolean).map(norm);
    return owners.length && data.insured.name && owners.includes(norm(data.insured.name)) ? []
      : [alert("OWNER_MISMATCH", "high", `Registered owner or named insured is missing or does not match for ${data.vehicles.length ? vehicleLabel(data, index) : "the Ownership source"}.`, `vehicles.${index}.registered_owner`, source(data, "registered_owner"))];
  });
}

export function checkOwnershipCompleteness(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  return data.vehicles.flatMap((_, index) => {
    const permit = vehicleOwnership(data, index); if (!permit) return [];
    const label = vehicleLabel(data, index);
    const findings: Alert[] = [];
    if (!permit.address) findings.push(alert("EVIDENCE_REVIEW", "high", `Ownership address is not confirmed for ${label}.`, `vehicles.${index}.ownership.address`));
    if (permit.leased === null || permit.leased === undefined) findings.push(alert("EVIDENCE_REVIEW", "high", `Lease status is unknown for ${label}; do not treat it as no lease.`, `vehicles.${index}.ownership.leased`));
    if (permit.leased === true && !permit.lessor?.name) findings.push(alert("EVIDENCE_REVIEW", "high", `Lessor is missing for leased ${label}.`, `vehicles.${index}.ownership.lessor`));
    if (!permit.lienholder?.name && !data.factConfirmations?.[`vehicles.${index}.lienholder.none`]?.confirmed) findings.push(alert("EVIDENCE_REVIEW", "medium", `Lienholder status is unknown for ${label}; confirm none or record the party.`, `vehicles.${index}.ownership.lienholder`));
    return findings;
  });
}

export function checkCoInsured(data: InsuranceCase): Alert[] {
  if (!isAuto(data) || !data.insured.co_insured.length) return [];
  return data.vehicles.flatMap((_, index) => {
    const permit = vehicleOwnership(data, index); if (!permit?.registered_owner) return [];
    const owners = [permit.registered_owner, ...(permit.additional_owners ?? [])].map(norm);
    return data.insured.co_insured.filter(person => !owners.includes(norm(person.name))).map(person => alert(
      "COINSURED_REVIEW", "medium", `Confirm why ${person.name} is jointly named although ${vehicleLabel(data, index)} records only ${permit.registered_owner} as owner.`, `vehicles.${index}.co_insured`, source(data, "co_insured")));
  });
}

export function checkLessor(data: InsuranceCase): Alert[] {
  if (!isAuto(data)) return [];
  // Check every vehicle: reconciliation writes ownership facts to each vehicle's own
  // ownership record; the top-level data.ownership is only a fallback and is usually
  // empty. Vehicles without ownership are skipped (a missing-ownership alert is raised
  // separately by checkOwnership).
  return data.vehicles.flatMap((vehicle, index) => {
    const ownershipLessor = vehicleOwnership(data, index)?.lessor;
    const applicationLessor = vehicle.lessor;
    if (!ownershipLessor || !applicationLessor) return [];
    const mismatched = norm(ownershipLessor.name) !== norm(applicationLessor.name) || norm(ownershipLessor.address) !== norm(applicationLessor.address);
    return mismatched
      ? [alert("LESSOR_MISMATCH", "medium", `Lessor mismatch for ${vehicleLabel(data, index)}.`, `vehicles.${index}.lessor`, source(data, "lessor"))]
      : [];
  });
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
    // Compare convictions as order-insensitive sets of complete normalized records:
    // the same convictions in a different order must not raise a mismatch, but any
    // field difference (offence date, severity, demerit points, speed over limit) must.
    const convictionKey = (conviction: Conviction) =>
      JSON.stringify([conviction.description ?? "", conviction.offence_date ?? "", conviction.conviction_date ?? "", conviction.speed_over_limit ?? "", conviction.severity ?? "", conviction.demerit_points ?? ""]);
    const convictionKeys = (convictions: Conviction[] | undefined) =>
      JSON.stringify((convictions ?? []).map(convictionKey).sort());
    if (driver.mvr_convictions && convictionKeys(driver.convictions) !== convictionKeys(driver.mvr_convictions)) {
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
  if (isPolicyChange(data)) return [...runPolicyChangeRules(data), ...checkCoverage(data), ...checkPremium(data, config), ...evidenceAlerts];
  return [
    ...evidenceAlerts,
    ...checkOwnership(data),
    ...checkNamedInsured(data),
    ...checkCoInsured(data),
    ...checkVin(data),
    ...checkVehicle(data),
    ...checkOwnershipCompleteness(data),
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

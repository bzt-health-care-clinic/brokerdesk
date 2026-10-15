import type { Alert, InsuranceCase, PolicyChange, PolicyChangeTransactionType } from "./insurance-types.ts";

export const POLICY_CHANGE_TRANSACTIONS: PolicyChangeTransactionType[] = ["VEHICLE_SUBSTITUTION", "ADD_VEHICLE", "DELETE_VEHICLE", "ADD_DRIVER", "DELETE_DRIVER", "DRIVER_REASSIGNMENT", "ADDRESS_CHANGE", "VEHICLE_USE_CHANGE", "ANNUAL_KM_CHANGE", "COMMUTE_CHANGE", "COVERAGE_CHANGE", "DEDUCTIBLE_CHANGE", "LESSOR_CHANGE", "LIENHOLDER_CHANGE", "PAYMENT_CHANGE", "CANCELLATION", "ENDORSEMENT_CHANGE", "OPCF16_ADD", "OPCF16_REMOVE", "OPCF16_REINSTATE", "OPCF17_ADD", "OPCF17_REMOVE", "OPCF17_REINSTATE", "OTHER_POLICY_CHANGE"];
export const POLICY_CHANGE_SECTION_ORDER = ["BASIC_INFORMATION", "CURRENT_POLICY_STATE", "REQUESTED_CHANGE", "RESULTING_POLICY_STATE", "DRIVER_VEHICLE_IMPACT", "COVERAGES_ENDORSEMENTS", "UW_BACKDATE", "NOTES", "PAYMENT_PREMIUM_IMPACT"] as const;
export const isPolicyChange = (item: InsuranceCase) => item.case_type === "auto_policy_change" || item.case_type === "home_policy_change";
export function createDefaultPolicyChangeState(effectiveDate = ""): PolicyChange { return { requested_action: "", vehicle_or_property: "", add: [], remove: [], keep: [], confirm: [], transaction_types: [], change_effective_date: effectiveDate, current_policy_state: {}, requested_changes: [], resulting_policy_state: {}, endorsement_changes: [], uw_required: false, uw_status: "NOT_REQUIRED", notes: "" }; }

export function normalizePolicyChangeTransactions(finalIntent: string, explicit: PolicyChangeTransactionType[] = []) {
  if (explicit.length) return [...new Set(explicit)];
  const text = finalIntent.toLowerCase();
  if (/replace|substitut/.test(text)) return ["VEHICLE_SUBSTITUTION" as const];
  if (/add.*vehicle/.test(text)) return ["ADD_VEHICLE" as const];
  if (/(delete|remove).*vehicle/.test(text)) return ["DELETE_VEHICLE" as const];
  if (/add.*driver/.test(text)) return ["ADD_DRIVER" as const];
  if (/(delete|remove).*driver/.test(text)) return ["DELETE_DRIVER" as const];
  if (/reassign.*driver|driver.*reassign/.test(text)) return ["DRIVER_REASSIGNMENT" as const];
  if (/address/.test(text)) return ["ADDRESS_CHANGE" as const];
  if (/annual.*km/.test(text)) return ["ANNUAL_KM_CHANGE" as const];
  if (/commut/.test(text)) return ["COMMUTE_CHANGE" as const];
  if (/use/.test(text)) return ["VEHICLE_USE_CHANGE" as const];
  if (/cancel/.test(text)) return ["CANCELLATION" as const];
  if (/payment|bank|credit card/.test(text)) return ["PAYMENT_CHANGE" as const];
  return ["OTHER_POLICY_CHANGE" as const];
}

const issue = (code: Alert["code"], severity: Alert["severity"], message: string, field: string): Alert => ({ id: `policy-change-${code}-${field}`, code, severity, message, field, resolved: false });
const received = (data: InsuranceCase, category: string) => data.documents.some((document) => document.category === category && document.received);

export function runPolicyChangeRules(data: InsuranceCase): Alert[] {
  if (!isPolicyChange(data) || !data.policy_change) return [];
  const change = data.policy_change; const types = normalizePolicyChangeTransactions(change.requested_action, change.transaction_types); const alerts: Alert[] = [];
  if (!(change.change_effective_date || change.requested_effective_date || data.policy.effective_date)) alerts.push(issue("SUPPORTING_DOCUMENT_MISSING", "high", "Policy change effective date is required.", "policy_change.change_effective_date"));
  if ((types.includes("ADD_VEHICLE") || types.includes("VEHICLE_SUBSTITUTION")) && !received(data, "ownership")) alerts.push(issue("OWNERSHIP_MISSING", "high", "Ownership is required for the added/replacement vehicle. A Bill of Sale is supporting evidence but does not replace Ownership.", "ownership"));
  if (types.includes("DELETE_VEHICLE") && data.vehicles.length < 1) alerts.push(issue("SUPPORTING_DOCUMENT_MISSING", "medium", "Confirm whether the policy will retain a rated vehicle or should use parking/suspension instead.", "policy_change.resulting_policy_state"));
  if ((change.uw_required || change.is_backdated) && !["APPROVED", "NOT_REQUIRED"].includes(change.uw_status ?? "PENDING")) alerts.push(issue("SUPPORTING_DOCUMENT_MISSING", "high", "Underwriting approval is pending; the policy change cannot be marked complete.", "policy_change.uw_status"));
  for (const endorsement of change.endorsement_changes ?? []) if (endorsement.supporting_document_required && !received(data, "signed_change_form")) alerts.push(issue("ENDORSEMENT_MISSING", "high", `Signed support is required for ${endorsement.endorsement}.`, `endorsement:${endorsement.endorsement}`));
  if (types.includes("PAYMENT_CHANGE") && !received(data, "payment_authorization")) alerts.push(issue("SUPPORTING_DOCUMENT_MISSING", "high", "Payment Authorization is required for this payment change.", "document:payment_authorization"));
  if (types.includes("CANCELLATION") && !received(data, "cancellation_request")) alerts.push(issue("SUPPORTING_DOCUMENT_MISSING", "high", "Cancellation Request documentation is required.", "document:cancellation_request"));
  return alerts;
}

export const policyChangeCanComplete = (data: InsuranceCase) => !runPolicyChangeRules(data).some((item) => item.severity === "high" && !item.resolved);

export function applyPolicyChangeState(data: InsuranceCase): InsuranceCase {
  if (!data.policy_change) return data; const next = structuredClone(data);
  for (const change of next.policy_change!.requested_changes ?? []) {
    if (change.type === "DELETE_DRIVER") next.drivers = next.drivers.filter((driver) => driver.name !== change.subject_name);
    if (change.type === "DELETE_VEHICLE") { const vin = String(change.previous_value ?? change.subject_id ?? ""); next.vehicles = next.vehicles.filter((vehicle) => vehicle.vin !== vin); }
    if (change.type === "DRIVER_REASSIGNMENT") { const driver = next.drivers.find((item) => item.name === change.subject_name); if (driver) driver.assigned_vehicle = String(change.new_value ?? ""); }
    if (change.type === "ANNUAL_KM_CHANGE" && next.vehicles[0]) next.vehicles[0].annual_km = Number(change.new_value);
    if (change.type === "COMMUTE_CHANGE" && next.vehicles[0]) next.vehicles[0].commute_km = Number(change.new_value);
    if (change.type === "VEHICLE_USE_CHANGE" && next.vehicles[0]) next.vehicles[0].primary_use = String(change.new_value);
  }
  return next;
}

export function transactionSummary(data: InsuranceCase) {
  const change = data.policy_change; if (!change) return ""; const types = normalizePolicyChangeTransactions(change.requested_action, change.transaction_types);
  return [`Transaction: ${types.join(" + ")}`, `Effective: ${change.change_effective_date || change.requested_effective_date || data.policy.effective_date || "Not provided"}`, `Requested: ${change.requested_action}`, `UW: ${change.uw_status ?? (change.uw_required ? "PENDING" : "NOT_REQUIRED")}`].join("\n");
}

import type { Claim, InsuranceCase } from "./insurance-types.ts";
import type { FieldEvidence, ParsedSource } from "./extraction-types.ts";
import { reportNumber } from "./report-details.ts";

const pick = (item: Record<string, unknown>, ...keys: string[]) => keys.map(key => item[key]).find(value => value !== undefined && value !== null && value !== "");
const text = (value: unknown) => value == null ? "" : String(value);
// Source-row identity is content based, not array position. Identical repeated
// rows remain separate occurrences; no accident/amount deduplication is implied.
function rowIdentity(row: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "__evidence").sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
  return JSON.stringify(stable(row));
}
export function claimRows(source: ParsedSource) {
  let rows = source.data.claims ?? source.data.claimsJson;
  if (typeof rows === "string") { try { rows = JSON.parse(rows); } catch { return []; } }
  return Array.isArray(rows) ? rows.map(row => row && typeof row === "object" ? row as Record<string, unknown> : { unparsed: row }) : [];
}

/** Adapt each source row, never merge accidents or inherit the report subject as driver. */
export function normalizedClaim(source: ParsedSource, row: Record<string, unknown>, index: number): Claim {
  const identity = rowIdentity(row);
  const occurrence = claimRows(source).slice(0, index).filter(previous => rowIdentity(previous) === identity).length;
  const role = text(pick(row, "party_role", "partyRole", "Party Role")).toUpperCase().replace(/[ -]/g, "_");
  const perspective = text(pick(row, "Record Perspective")).toUpperCase().replace(/[ -]/g, "_");
  const sourceRole = role === "FIRST_PARTY" || role === "THIRD_PARTY" ? role : perspective;
  const roleFault = sourceRole === "FIRST_PARTY" ? row["First Party At-Fault"] : sourceRole === "THIRD_PARTY" ? row["Third Party At-Fault"] : undefined;
  const roleDriver = sourceRole === "FIRST_PARTY" ? row["First Party Driver"] : sourceRole === "THIRD_PARTY" ? row["Third Party Driver"] : undefined;
  const evidence = (Array.isArray(row.__evidence) ? row.__evidence : source.fieldEvidence.claims ?? source.fieldEvidence.claimsJson ?? []) as FieldEvidence[];
  return {
    id: `${source.documentId}--${source.logicalDocumentId ?? "file"}--claim-${encodeURIComponent(identity)}-${occurrence}`,
    loss_date: text(pick(row, "loss_date", "lossDate", "Loss Date", "Date of Loss")),
    insurer: text(pick(row, "insurer", "Insurer")), policy_number: text(pick(row, "policy_number", "policyNumber", "Policy Number")),
    claim_number: text(pick(row, "claim_number", "claimNumber", "claimId", "Claim Number", "Claim No", "Claim ID")),
    coverage: text(pick(row, "coverage", "Coverage")), loss_amount: reportNumber(pick(row, "loss_amount", "lossAmount", "amount", "Loss Amount", "Total Loss", "Amount")), expense: reportNumber(pick(row, "expense", "expenses", "Expenses", "Expense", "Total Expense")),
    vehicle: text(pick(row, "vehicle", "Vehicle")), vehicle_vin: text(pick(row, "vehicle_vin", "vehicleVin", "vin", "VIN")),
    driver: text(pick(row, "driver", "driverName", "Driver", "Driver Name") ?? roleDriver), driver_licence_number: text(pick(row, "driver_licence_number", "driverLicenceNumber", "Driver Licence Number")),
    at_fault_percent: reportNumber(pick(row, "at_fault_percent", "atFaultPercent", "fault", "At Fault Percent", "Fault") ?? roleFault),
    status: text(pick(row, "status", "Status", "Claim Status")),
    party_role: sourceRole === "FIRST_PARTY" || sourceRole === "THIRD_PARTY" ? sourceRole : "UNKNOWN", reported_party_role: text(pick(row, "party_role", "partyRole", "Party Role", "Record Perspective")),
    report_id: text(pick(row, "report_id", "reportId", "Report ID") ?? source.data.reportId),
    driver_id: text(pick(row, "driver_id", "driverSubjectId")) || undefined, vehicle_id: text(pick(row, "vehicle_id", "vehicleSubjectId")) || undefined,
    source_active: true,
    source: { documentId: source.documentId, logicalDocumentId: source.logicalDocumentId, sourceRevision: source.sourceRevision, evidence: evidence.map(e => ({ ...source.fieldEvidence.claims?.find(other => other.page === e.page), ...e })), original: row },
  };
}

export function flagPossibleDuplicateClaims(claims: InsuranceCase["claims"]) {
  for (const claim of claims) {
    claim.possible_duplicate_ids = claims.filter(other => other.id !== claim.id && other.source_active !== false && claim.source_active !== false && (
      Boolean(claim.claim_number && other.claim_number === claim.claim_number && claim.insurer && other.insurer === claim.insurer) ||
      Boolean(claim.loss_date && other.loss_date === claim.loss_date && claim.vehicle_vin && other.vehicle_vin === claim.vehicle_vin && claim.coverage && other.coverage === claim.coverage)
    )).map(other => other.id);
  }
}

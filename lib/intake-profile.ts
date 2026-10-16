import { DEFAULT_RULE_CONFIG, type InsuranceCase, type PolicyChangeTransactionType, type Vehicle } from "./insurance-types.ts";
import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";
import { runRules } from "./rule-engine.ts";
import { runPhase3Rules } from "./phase3-rules.ts";
import { reviewUploadedDocuments } from "./document-underwriting.ts";
import { applyDocumentPresence } from "./document-package.ts";
import { isSignedEvidenceStillValid } from "./signed-verification.ts";
import { isPolicyChange, normalizePolicyChangeTransactions } from "./policy-change.ts";
import { changeSignersValid, insuredPersonNames, isCancellationChange, nameComparisonEvidenceValid, requiresSeparateSigners, sameNamedPersons } from "./intake-person-evidence.ts";
import type { ChangeSignerAttestation } from "./intake-person-evidence.ts";

export const INTAKE_PROFILE_VERSION = { "new-business": "new-business-v1.1", "policy-change": "policy-change-v1.1" } as const;
export const INTAKE_RULE_ENGINE_VERSION = "brokerdesk-rules-20261016-names-signers";
export type IntakeSystem = "new-business" | "policy-change";
export interface IntakeFinding { code: string; message: string; field?: string; document_id?: string; vehicle_id?: string }
export interface IntakeResult {
  passed: boolean;
  system: IntakeSystem;
  profile_version: string;
  rule_engine_version: string;
  blockers: IntakeFinding[];
  warnings: IntakeFinding[];
}
export interface ChangeAuthorization {
  verified: boolean;
  authorization_type: "CANCELLATION_REQUEST" | "NAME_CHANGE_REQUEST" | "SIGNED_CHANGE_FORM";
  document_id: string;
  logical_document_id?: string;
  document_type: DocumentType;
  source_sha256: string;
  verified_at: string;
  verified_by: string;
  start_page?: number;
  end_page?: number;
  signers?: ChangeSignerAttestation[];
}
export interface IntakeInsuranceCase extends InsuranceCase {
  transaction_authorization?: ChangeAuthorization;
}
const normalizeVin = (v: unknown) => String(v ?? "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
const digestPresent = (r: UploadedDocumentRecord) => Boolean(r.sourceHash && (!r.currentSourceHash || r.currentSourceHash === r.sourceHash) && !r.staleExtraction);
const activeSections = (r: UploadedDocumentRecord) => r.logicalDocuments === undefined
  ? [{ id: undefined as string | undefined, documentType: r.documentType, subjectId: undefined as string | undefined,
    presenceStatus: "FOUND" as const, startPage: 1, endPage: r.pageCount }]
  : r.logicalDocuments.filter(s => s.presenceStatus === "FOUND");
const activeEvidence = (records: UploadedDocumentRecord[], type: DocumentType) =>
  records.filter(digestPresent).flatMap(r => activeSections(r)
    .filter(s => s.documentType === type && !(r.withdrawnSectionRanges ?? []).some(w =>
      (s.startPage ?? 1) <= w.endPage && (s.endPage ?? s.startPage ?? 1) >= w.startPage))
    .map(s => ({ record: r, section: s })));

function validVehicleOwnership(vehicle: Vehicle, index: number, item: InsuranceCase, records: UploadedDocumentRecord[]) {
  const vin = normalizeVin(vehicle.vin);
  const owner = vehicle.ownership ?? (item.vehicles.length === 1 ? item.ownership : undefined);
  if (!vin || !owner?.received || vin !== normalizeVin(owner.vin)) return false;
  const found = activeEvidence(records, "OWNERSHIP");
  // Identical VIN in two vehicles is ambiguous, regardless of matching evidence.
  if (item.vehicles.filter(candidate => normalizeVin(candidate.vin) === vin).length !== 1) return false;
  return found.some(({record,section}) =>
    (vehicle.id && section.subjectId === vehicle.id) ||
    (record.parsedSources ?? []).some(src =>
      (src.documentType === "OWNERSHIP" && normalizeVin(src.data?.vin) === vin &&
        (!src.logicalDocumentId || src.logicalDocumentId === section.id)))
  );
}
export function authorizationEvidenceValid(item: IntakeInsuranceCase, records: UploadedDocumentRecord[]) {
  const auth = item.transaction_authorization;
  if (!auth?.verified || !auth.document_id || !auth.source_sha256 || !auth.verified_at) return false;
  if (isCancellationChange(item) && (auth.authorization_type !== "CANCELLATION_REQUEST" ||
    auth.document_type !== "CANCELLATION_REQUEST")) return false;
  if (requiresSeparateSigners(item) && !changeSignersValid(item, records)) return false;
  if (!requiresSeparateSigners(item) && auth.signers?.length && !changeSignersValid(item, records)) return false;
  const record = records.find(r => r.id === auth.document_id);
  if (!record || !digestPresent(record) || auth.source_sha256 !== record.sourceHash) return false;
  return activeSections(record).some(section =>
    section.id === auth.logical_document_id &&
    section.documentType === auth.document_type && section.presenceStatus === "FOUND" &&
    (!auth.logical_document_id || (section.startPage === auth.start_page && section.endPage === auth.end_page)) &&
    !(record.withdrawnSectionRanges ?? []).some(range =>
      (section.startPage ?? 1) <= range.endPage && (section.endPage ?? section.startPage ?? 1) >= range.startPage));
}
export function profileSystem(item: InsuranceCase): IntakeSystem {
  return isPolicyChange(item) ? "policy-change" : "new-business";
}
export function primaryTransactionType(item: InsuranceCase): PolicyChangeTransactionType | undefined {
  if (!isPolicyChange(item)) return undefined;
  return normalizePolicyChangeTransactions(item.policy_change?.requested_action ?? "",
    item.policy_change?.transaction_types ?? [])[0];
}
export function evaluateIntakeProfile(
  original: IntakeInsuranceCase,
  records: UploadedDocumentRecord[],
): IntakeResult {
  const system = profileSystem(original);
  const findings: IntakeFinding[] = [];
  const push = (code: string, message: string, field?: string, vehicle_id?: string, document_id?: string) =>
    findings.push({ code, message, ...(field ? {field} : {}), ...(vehicle_id ? {vehicle_id} : {}), ...(document_id ? {document_id} : {}) });
  const item = applyDocumentPresence(original, records);
  const ruleAlerts = [...runRules(item, DEFAULT_RULE_CONFIG), ...runPhase3Rules(item), ...reviewUploadedDocuments(item, records).alerts];
  // MVR received date is explicitly excluded from intake; all other HIGH rules remain.
  for (const a of ruleAlerts) if (!a.resolved && a.severity === "high" &&
    a.code !== "MVR_RECEIVED_DATE_MISSING") push(a.code, a.message, a.field);

  // Document presence is derived from current ACTIVE evidence, not a checklist
  // boolean supplied by the broker or package author.
  for (const doc of item.documents.filter(d => d.required && !d.received))
    push("INTAKE_REQUIRED_DOCUMENT", `Required source document missing: ${doc.name}.`, `document:${doc.category}`);

  if (system === "new-business") {
    if (!["new_auto", "new_home", "new_condo", "new_tenant"].includes(item.case_type))
      push("INTAKE_UNSUPPORTED_CASE_TYPE", "Only new business and policy changes can be submitted.", "case_type");
    const signedRecord = records.find(r => r.id === item.signed_document_id);
    if (!item.signed || !item.signed_verified_at || !signedRecord || !digestPresent(signedRecord) ||
      !isSignedEvidenceStillValid(records, item).valid)
      push("INTAKE_SIGNED_APPLICATION", "Signed application must be manually verified against an active, unchanged source PDF.", "signed", undefined, item.signed_document_id);
    // Compare both original documents and the Case identities; checklist flags cannot satisfy this.
    if (!nameComparisonEvidenceValid(item, records))
      push("INTAKE_INSURED_NAME_EVIDENCE", "Manually compare all named insureds on the signed application and Quote, linking both active source documents.", "named_insured_comparison");
    else {
      const review = item.named_insured_comparison!;
      if (!sameNamedPersons(review.application_names,review.quote_names) ||
        !sameNamedPersons(review.application_names,insuredPersonNames(item)))
        push("INTAKE_INSURED_NAME_MISMATCH",
          "Signed Application, Quote and Case policyholders differ in identity or count.", "named_insured_comparison");
    }
    if (item.case_type === "new_auto") {
      if (!item.vehicles.length) push("INTAKE_VEHICLE_REQUIRED", "Auto new business requires at least one rated vehicle.", "vehicles");
      for (const [index, vehicle] of item.vehicles.entries())
        if (!validVehicleOwnership(vehicle, index, item, records))
          push("INTAKE_VEHICLE_OWNERSHIP", `Ownership/VIN evidence is missing or not uniquely matched for vehicle ${index + 1} (${vehicle.vin || "VIN missing"}).`,
            `vehicles.${index}.ownership`, vehicle.id);
    }
  } else {
    if (!item.policy_change) push("INTAKE_CHANGE_DETAILS", "Policy change details are required.", "policy_change");
    if (!authorizationEvidenceValid(item, records))
      push("INTAKE_CHANGE_AUTHORIZATION", "Verify a signed customer authorization source for this policy change.", "transaction_authorization",
        undefined, item.transaction_authorization?.document_id);
    if (!insuredPersonNames(item).length)
      push("INTAKE_POLICYHOLDER_IDENTITY", "Confirm each distinct named policyholder before authorizing this transaction.", "insured");
    if (requiresSeparateSigners(item) && !changeSignersValid(item, records))
      push("INTAKE_POLICYHOLDER_SIGNATURES",
        "Cancellation or joint-name change requires distinct, manually verified policyholder signatures linked to active file sections and pages.", "transaction_authorization.signers");
    const types = item.policy_change ? normalizePolicyChangeTransactions(
      item.policy_change.requested_action, item.policy_change.transaction_types) : [];
    const changes = item.policy_change?.requested_changes ?? [];
    if (types.includes("ADD_VEHICLE") || types.includes("VEHICLE_SUBSTITUTION")) {
      const targets = changes.filter(ch => ch.type === "ADD_VEHICLE" || ch.type === "VEHICLE_SUBSTITUTION");
      // Do not silently apply one existing car's Ownership to the changed car.
      const keys = targets.length ? targets.map(ch => ch.subject_id || (typeof ch.new_value === "string" ? ch.new_value : "") ||
        (typeof ch.new_value === "object" && ch.new_value !== null ? String((ch.new_value as {vin?: string}).vin ?? "") : "")) : [item.policy_change?.vin ?? ""];
      for (const [index, key] of keys.entries()) {
        const candidates = item.vehicles.filter(v => Boolean(key) && (v.id === key || normalizeVin(v.vin) === normalizeVin(key)));
        if (candidates.length !== 1) {
          push("INTAKE_CHANGE_TARGET_UNCONFIRMED", `Changed vehicle ${index + 1} must be identified by unique VIN or vehicle ID.`,
            "policy_change.requested_changes");
        } else {
          const target = candidates[0];
          const vehicleIndex = item.vehicles.indexOf(target);
          if (!validVehicleOwnership(target, vehicleIndex, item, records))
            push("INTAKE_CHANGE_OWNERSHIP", `Ownership/VIN required for added or substituted vehicle (${target.vin || "VIN missing"}).`,
              `vehicles.${vehicleIndex}.ownership`, target.id);
        }
      }
    }
  }

  if (/\b(?:economical|definity)\b/i.test(item.policy.company) && !item.group_discount?.selectionConfirmed)
    push("INTAKE_ECONOMICAL_GROUP_UNCONFIRMED",
      "Economical/Definity group discount selection must be explicitly confirmed, including No.",
      "group_discount.selectionConfirmed");

  // De-duplicate overlapping High findings emitted by reused rules and the
  // submission-specific layer, while keeping per-vehicle references distinct.
  const unique = new Map(findings.map(f => [`${f.code}|${f.field ?? ""}|${f.vehicle_id ?? ""}`, f]));
  return { passed: unique.size === 0, system, profile_version: INTAKE_PROFILE_VERSION[system],
    rule_engine_version: INTAKE_RULE_ENGINE_VERSION, blockers: [...unique.values()], warnings: [] };
}

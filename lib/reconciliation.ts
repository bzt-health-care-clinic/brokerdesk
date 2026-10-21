import { claimRows, normalizedClaim, flagPossibleDuplicateClaims } from "./claim-records.ts";
import { canonicalFieldKey } from "./field-keys.ts";
import { activeParsedSources } from "./active-evidence.ts";
import type { FieldEvidence, ParsedSource, ReconciledField, SourceValue, UploadedDocumentRecord } from "./extraction-types.ts";
import type { FieldSource, FieldSourceName, InsuranceCase } from "./insurance-types.ts";
import { applyDocumentPresence } from "./document-package.ts";

export const SOURCE_PRIORITIES: Record<string, string[]> = {
  registeredOwner: ["OWNERSHIP", "AUTO_APPLICATION", "AUTO_QUOTE"], ownerAddress: ["OWNERSHIP"], vin: ["OWNERSHIP", "AUTO_APPLICATION", "AUTO_QUOTE", "DASH"], year: ["OWNERSHIP", "BILL_OF_SALE"], make: ["OWNERSHIP", "BILL_OF_SALE"], model: ["OWNERSHIP", "BILL_OF_SALE"], plate: ["OWNERSHIP"], lessor: ["OWNERSHIP", "LEASE_DOCUMENT"], vehicleUse: ["AUTO_APPLICATION", "AUTO_QUOTE", "DASH"], annualKm: ["AUTO_APPLICATION", "AUTO_QUOTE", "DASH"], licenceClass: ["MVR", "AUTO_APPLICATION", "AUTO_QUOTE"], g1Date: ["AUTO_APPLICATION", "AUTO_QUOTE", "MANUAL"], g2Date: ["AUTO_APPLICATION", "AUTO_QUOTE", "MANUAL"], gDate: ["AUTO_APPLICATION", "AUTO_QUOTE", "MANUAL"], convictions: ["MVR", "AUTO_APPLICATION", "AUTO_QUOTE"], claims: ["DASH", "PRIOR_AUTO_POLICY", "AUTO_APPLICATION"], coverage: ["AUTO_APPLICATION", "POLICY_CHANGE", "PRIOR_AUTO_POLICY", "AUTO_QUOTE"], premium: ["AUTO_QUOTE", "PORTAL_SCREENSHOT"],
};
const NEVER_AUTO_RESOLVE = new Set(["propertyInsuredSince", "priorInsurer"]);
const display = (value: unknown) => String(value ?? "").trim();
const comparison = (value: unknown) => (value && typeof value === "object" ? JSON.stringify(value) : display(value)).toUpperCase().replace(/\s+/g, " ");

export function reconcileField<T>(field: string, sources: ParsedSource[], priorities = SOURCE_PRIORITIES[field] ?? []): ReconciledField<T> {
  const values: SourceValue<T>[] = sources.flatMap((source) => {
    const originalKey = Object.keys(source.data).find(key => canonicalFieldKey(key) === canonicalFieldKey(field)) ?? field;
    const value = source.data[originalKey] as T | undefined;
    if (value === undefined || value === null || value === "") return [];
    return [{ source: source.documentType, value, confidence: source.fieldEvidence[originalKey]?.[0]?.confidence ?? source.confidence, evidence: source.fieldEvidence[originalKey], documentId: source.documentId }];
  });
  if (!values.length) return { value: null, status: "missing", sourceValues: [] };
  const confirmed = values.find((item) => item.source === "CLIENT_CONFIRMED_FACT");
  if (confirmed) return { value: confirmed.value, status: "resolved", selectedSource: confirmed.source, sourceValues: values };
  const unique = new Set(values.map((item) => comparison(item.value)));
  if (unique.size > 1 && NEVER_AUTO_RESOLVE.has(field)) return { value: null, status: "conflict", sourceValues: values };
  if (unique.size > 1) return { value: null, status: "conflict", sourceValues: values };
  const selected = [...values].sort((a, b) => {
    const ai = priorities.indexOf(a.source); const bi = priorities.indexOf(b.source);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  })[0];
  return { value: selected.value, status: "resolved", selectedSource: selected.source, sourceValues: values };
}

export function reconcileNamedInsured(ownership: ParsedSource | undefined, application: ParsedSource | undefined, quote: ParsedSource | undefined) {
  return reconcileField<string>("namedInsured", [ownership, application, quote].filter(Boolean) as ParsedSource[], ["OWNERSHIP", "AUTO_APPLICATION", "AUTO_QUOTE"]);
}

export function reconcileSources(sources: ParsedSource[]) {
  const fields = new Set(sources.flatMap((source) => Object.keys(source.data).map(canonicalFieldKey)));
  return Object.fromEntries([...fields].map((field) => [field, reconcileField(field, sources)]));
}

export function normalizePersonName(value: string) { return value.normalize("NFKD").replace(/[^\p{L}\p{N}, ]/gu, " ").replace(/\s+/g, " ").trim().toUpperCase(); }
export function comparePersonNames(left: string, right: string) {
  const a = normalizePersonName(left); const b = normalizePersonName(right);
  if (a === b) return true;
  const tokens = (value: string) => value.replaceAll(",", " ").split(" ").filter(Boolean).sort().join("|");
  return tokens(a) === tokens(b);
}
export function normalizeVin(value: string) { return value.toUpperCase().replace(/[\s-]/g, ""); }
export function compareVins(left: string, right: string) { return normalizeVin(left) === normalizeVin(right); }
export function normalizePostalCode(value: string) { const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, ""); return clean.length === 6 ? `${clean.slice(0, 3)} ${clean.slice(3)}` : clean; }
export function normalizeAddress(value: string) {
  return value.toUpperCase().replace(/\bROAD\b/g, "RD").replace(/\bSTREET\b/g, "ST").replace(/\bAVENUE\b/g, "AVE").replace(/\bSUITE\b/g, "UNIT").replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();
}
export function compareAddresses(left: string, right: string) {
  const a = normalizeAddress(left); const b = normalizeAddress(right);
  const streetNumber = (value: string) => value.match(/\b\d+\b/)?.[0];
  if (streetNumber(a) !== streetNumber(b)) return false;
  return a === b;
}
export function evidenceFor(field: string, source: ParsedSource): FieldEvidence[] { return source.fieldEvidence[field] ?? []; }

const sourceName = (value: string) => value.toLowerCase() as FieldSourceName;
const numeric = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};


const driverFields = new Set(["driverName", "dob", "licenceNumber", "licenceClass", "g1Date", "g2Date", "gDate", "expiryDate", "demeritPoints", "requestDate", "releaseDate", "replyDate", "receivedDate", "issueDate", "licenceStatus", "conditions", "convictions", "reportId", "reportDate","licenceProvince"]);
const vehicleFields = new Set(["registeredOwner", "ownerAddress", "vin", "year", "make", "model", "plate", "lessor", "lienholder", "vehicleUse", "annualKm", "commuteKm"]);
const supportId = (source: ParsedSource) => JSON.stringify([source.documentId, source.logicalDocumentId, source.sourceRevision, source.entityId]);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const nonempty = (v: unknown) => v !== undefined && v !== null && v !== "";

function association(data: InsuranceCase, source: ParsedSource, field: string) {
  if (source.claimRecordId && field.startsWith("claim.")) return { type: "CLAIM", lob: "AUTO", id: source.claimRecordId, primary: !data.case_type.includes("home") };
  const type = source.entityId && ["DRIVER","VEHICLE","PROPERTY"].includes(source.subjectType ?? "") ? source.subjectType! : driverFields.has(field) ? "DRIVER" : vehicleFields.has(field) ? "VEHICLE" : ["propertyInsuredSince", "continuouslyInsuredSince", "occupiedSince", "riskAddress", "numberOfMortgages", "mortgagee", "mortgageeAddress", "natureOfInterest", "lossPayee", "policyType","occupancy","structure","construction","exteriorFinish","yearBuilt","families","units","livingArea","bedrooms","bathrooms","garage","roof","plumbing","electrical","heating","smokeFree","swimmingPool","dogExposure","rental","airbnb","vacant","businessUse"].includes(field) ? "PROPERTY" : "POLICY";
  const lob = source.lineOfBusiness ?? (/HAB|PROPERTY|MORTGAGE/.test(source.documentType) ? "HAB" : /AUTO|OWNERSHIP|MVR|DASH|VEHICLE|LEASE|FINANCE/.test(source.documentType) ? "AUTO" : data.case_type.includes("home") ? "HAB" : "AUTO");
  const primaryLob = data.case_type.includes("home") ? "HAB" : "AUTO";
  if (type === "POLICY" || type === "PROPERTY") return { type, lob, id: type === "POLICY" ? data.policy.id! : data.habitational_risk?.id, primary: lob === primaryLob };
  const entities = type === "DRIVER" ? data.drivers : data.vehicles;
  const manual = source.subjectId && source.subjectType === type ? entities.filter(e => e.id === source.subjectId) : [];
  if (manual.length === 1) return { type, lob, id: manual[0].id, primary: lob === primaryLob };
  // An invalid explicit association must not silently fall back to a different subject.
  if (source.subjectId) return { type, lob, id: undefined, primary: false };
  const identifier = type === "DRIVER" ? comparison(source.data.licenceNumber).replace(/[ -]/g, "") : normalizeVin(String(source.data.vin ?? ""));
  const matches = identifier && (type === "DRIVER" || /^[A-HJ-NPR-Z0-9]{17}$/.test(identifier))
    ? entities.filter(e => (type === "DRIVER" ? comparison((e as InsuranceCase["drivers"][number]).licence_number).replace(/[ -]/g, "") : normalizeVin((e as InsuranceCase["vehicles"][number]).vin)) === identifier) : [];
  return { type, lob, id: matches.length === 1 ? matches[0].id : undefined, primary: lob === primaryLob };
}

// Paths use stable IDs for collections, never array indexes.
function slot(data: InsuranceCase, path: string[]): { target: Record<string, unknown>; key: string } | undefined {
  let value: unknown = data;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(value)) value = /^\d+$/.test(part) ? value[Number(part)] : value.find(item => item.id === part);
    else if (value && typeof value === "object") value = (value as Record<string, unknown>)[part];
    else return undefined;
  }
  return value && typeof value === "object" ? { target: value as Record<string, unknown>, key: path.at(-1)! } : undefined;
}
const policyPaths: Record<string, string[]> = { insurer: ["policy", "company"], quoteNumber: ["policy", "quote_number"], effectiveDate: ["policy", "effective_date"], namedInsured: ["insured", "name"], priorInsurer: ["prior_insurance", "insurer"], previousInsurer: ["prior_insurance", "insurer"], priorPolicyNumber: ["prior_insurance", "policy_number"], priorEffective: ["prior_insurance", "effective_date"], priorExpiry: ["prior_insurance", "expiry_date"], insuredSince: ["prior_insurance", "insured_since"], dateWithCompany: ["prior_insurance", "date_with_company"], continuousInsurance: ["prior_insurance", "continuous_insurance"] };
const driverPaths: Record<string, string> = { licenceProvince: "licence_province", licenceClass: "licence_class", g1Date: "g1_date", g2Date: "g2_date", gDate: "g_date", requestDate: "mvr_requested", releaseDate: "mvr_release_date", replyDate: "mvr_reply_date", receivedDate: "mvr_received", issueDate: "mvr_issue_date", expiryDate: "licence_expiry", licenceStatus: "licence_status", conditions: "licence_conditions", demeritPoints: "mvr_demerit_points", convictions: "mvr_convictions" };
const vehiclePaths: Record<string, string> = { vin: "vin", vehicleUse: "primary_use", annualKm: "annual_km", commuteKm: "commute_km" };
const ownershipPaths: Record<string, string> = { registeredOwner: "registered_owner", ownerAddress: "address", vin: "vin", year: "year", make: "make", model: "model", plate: "plate", lessor: "lessor", lienholder: "lienholder" };
const habPropertyPaths: Record<string, string[]> = {
  riskAddress: ["habitational_risk", "risk_address"], policyType: ["habitational_risk", "policy_type"], occupiedSince: ["habitational_risk", "occupied_since"],
  propertyInsuredSince: ["prior_insurance", "insured_since"], continuouslyInsuredSince: ["prior_insurance", "continuous_insurance"],
  occupancy:["habitational_risk","occupancy"],structure:["habitational_risk","structure"],
  construction:["habitational_risk","construction"],exteriorFinish:["habitational_risk","exterior_finish"],
  yearBuilt:["habitational_risk","year_built"],families:["habitational_risk","families"],
  units:["habitational_risk","units"],livingArea:["habitational_risk","living_area"],
  bedrooms:["habitational_risk","bedrooms"],bathrooms:["habitational_risk","bathrooms"],
  garage:["habitational_risk","garage"],roof:["habitational_risk","roof"],
  plumbing:["habitational_risk","plumbing"],electrical:["habitational_risk","electrical"],
  heating:["habitational_risk","heating"],smokeFree:["habitational_risk","smoke_free"],
  swimmingPool:["habitational_risk","swimming_pool"],dogExposure:["habitational_risk","dog_animal_exposure"],
  rental:["habitational_risk","rental"],airbnb:["habitational_risk","airbnb"],
  vacant:["habitational_risk","vacant"],businessUse:["habitational_risk","business_use"],
  numberOfMortgages: ["mortgage", "number_of_mortgages"], mortgagee: ["mortgage", "mortgagees", "0", "name"], mortgageeAddress: ["mortgage", "mortgagees", "0", "address"], natureOfInterest: ["mortgage", "nature_of_interest"], lossPayee: ["mortgage", "loss_payees", "0", "name"],
};

export function reconcileDocumentsIntoCase(current: InsuranceCase, records: UploadedDocumentRecord[]): InsuranceCase {
  const next = applyDocumentPresence(current, records);
  next.policy.id ??= crypto.randomUUID();
  for (const subject of [...next.drivers, ...next.vehicles]) subject.id ??= crypto.randomUUID();
  if (next.habitational_risk) next.habitational_risk.id ??= crypto.randomUUID();
  const sources = records.flatMap(activeParsedSources);
  const claimSources: ParsedSource[] = [];
  const activeClaimIds = new Set<string>();
  for (const source of sources.filter(s => s.documentType === "DASH")) claimRows(source).forEach((row, index) => {
    const claim = normalizedClaim(source, row, index);
    const driverScope = association(next, { ...source, subjectType: "DRIVER", subjectId: claim.driver_id, data: { licenceNumber: claim.driver_licence_number } }, "licenceNumber");
    const vehicleScope = association(next, { ...source, subjectType: "VEHICLE", subjectId: claim.vehicle_id, data: { vin: claim.vehicle_vin } }, "vin");
    claim.driver_id = driverScope.primary ? driverScope.id : undefined;
    claim.vehicle_id = vehicleScope.primary ? vehicleScope.id : undefined;
    claim.report_subject_id = association(next, { ...source, data: { ...source.data, licenceNumber: source.data.reportSubjectLicence ?? source.data.licenceNumber } }, "licenceNumber").id;
    claim.association_status = claim.driver_id ? "ASSIGNED" : "UNASSIGNED";
    activeClaimIds.add(claim.id);
    if (!next.claims.some(c => c.id === claim.id)) next.claims.push({ id: claim.id, loss_date: "", insurer: "", policy_number: "", claim_number: "", coverage: "", loss_amount: null, at_fault_percent: null, status: "", source: claim.source });
    const entries = Object.entries(claim).filter(([key, value]) => key !== "id" && value !== undefined);
    claimSources.push({ ...source, claimRecordId: claim.id, data: Object.fromEntries(entries.map(([key, value]) => [`claim.${key}`, value])), fieldEvidence: Object.fromEntries(entries.map(([key]) => [`claim.${key}`, claim.source!.evidence])) });
  });
  type Bucket = { field: string; scope: ReturnType<typeof association>; entries: { source: ParsedSource; key: string }[] };
  const buckets = new Map<string, Bucket>();
  for (const source of [...sources, ...claimSources]) for (const key of Object.keys(source.data)) {
    if (source.documentType === "DASH" && (key === "claims" || key === "claimsJson")) continue;
    const field = canonicalFieldKey(key);
    if (!nonempty(source.data[key])) continue;
    const scope = association(next, source, field);
    const identity = !scope.id ? `UNASSIGNED:${source.documentId}:${source.logicalDocumentId ?? "file"}:${source.entityId ?? "scalar"}:${field}` : scope.type === "POLICY" && scope.primary ? field : `${scope.lob}:${scope.type}:${scope.id}:${field}`;
    const bucket = buckets.get(identity) ?? { field, scope, entries: [] };
    bucket.entries.push({ source, key }); buckets.set(identity, bucket);
  }
  const previous = new Map(current.field_sources.map(f => [f.canonicalField ? f.field : canonicalFieldKey(f.field), f]));
  const allKeys = new Set([...previous.keys(), ...buckets.keys()]);
  const fields: FieldSource[] = [];
  for (const identity of allKeys) {
    const old = previous.get(identity);
    const bucket = buckets.get(identity);
    const field = bucket?.field ?? old?.canonicalField ?? canonicalFieldKey(identity);
    const entries = bucket?.entries ?? [];
    const values = entries.map(({ source, key }) => ({ source: sourceName(source.documentType), value: source.corrections?.[key]?.originalExtractedValue ?? source.data[key], correctedValue: source.corrections?.[key]?.correctedValue, documentId: source.documentId, logicalDocumentId: source.logicalDocumentId, sourceRevision: source.sourceRevision, entityId: source.entityId, originalKey: key, confidence: source.confidence, evidence: source.fieldEvidence[key] }));
    const effective = entries.map(({ source, key }) => source.corrections?.[key]?.correctedValue ?? source.data[key]);
    const unique = new Set(effective.map(comparison));
    const hasCorrection = entries.some(({ source, key }) => source.corrections?.[key]);
    const manual = old?.status === "resolved" || Boolean(old?.resolved_by_user);
    const changed = Boolean(old && !same(old.values, values));
    const resolved = manual ? old!.resolved_value : unique.size === 1 ? effective[0] : null;
    const item: FieldSource = {
      ...old, field: identity, canonicalField: field, subjectType: bucket?.scope.type ?? old?.subjectType, subjectId: bucket?.scope.id ?? old?.subjectId, lineOfBusiness: bucket?.scope.lob ?? old?.lineOfBusiness,
      values, resolved_value: resolved, status: manual || hasCorrection && unique.size === 1 ? "resolved" : unique.size > 1 ? "conflict" : values.length ? "matched" : "missing",
      associationReview: Boolean(bucket && (!bucket.scope.id || !bucket.scope.primary)),
      evidenceReview: Boolean(old?.evidenceReview || manual && changed || old && !old.canonicalField && (driverFields.has(field) || vehicleFields.has(field))),
      withdrawnValues: changed ? [...(old?.withdrawnValues ?? []), ...old!.values.filter(v => !values.some(n => same(n, v)))] : old?.withdrawnValues,
      appliedTargets: [],
    };
    if (hasCorrection && !manual) { const correction = entries.map(e => e.source.corrections?.[e.key]).find(Boolean)!; item.resolved_by_user = correction.correctedBy; item.resolved_at = correction.correctedAt; }

    // Roll back only our own last assignment; broker edits remain independent.
    const blocked = new Set<string>();
    let priorTargets = old?.appliedTargets ?? [];
    if (old && !old.canonicalField && !manual && !priorTargets.length) {
      const legacy = policyPaths[field] ?? (ownershipPaths[field] ? ["ownership", ownershipPaths[field]] : undefined);
      if (legacy) { const target = slot(next, legacy); if (target && same(target.target[target.key], old.resolved_value)) priorTargets = [{ path: legacy, value: old.resolved_value, previousValue: field === "year" ? null : "" }]; }
    }
    for (const target of priorTargets) {
      const at = slot(next, target.path); if (!at) continue;
      if (manual) { item.appliedTargets!.push(target); continue; }
      if (same(at.target[at.key], target.value)) at.target[at.key] = target.previousValue;
      else { blocked.add(JSON.stringify(target.path)); item.evidenceReview = true; }
    }
    const paths: string[][] = [];
    if (bucket?.scope.id && bucket.scope.primary && !item.associationReview) {
      if (bucket.scope.type === "CLAIM" && field.startsWith("claim.")) paths.push(["claims", bucket.scope.id, field.slice(6)]);
      if (bucket.scope.type === "POLICY" && policyPaths[field]) paths.push(policyPaths[field]);
      if (bucket.scope.type === "PROPERTY" && bucket.scope.lob === "HAB" && habPropertyPaths[field]) {
        if (["numberOfMortgages", "mortgagee", "mortgageeAddress", "natureOfInterest"].includes(field)) next.mortgage ??= { number_of_mortgages: null, mortgagees: [] };
        if (field === "mortgagee" || field === "mortgageeAddress") {
          next.mortgage ??= { number_of_mortgages: null, mortgagees: [] };
          next.mortgage.mortgagees[0] ??= { name: "", address: "" };
        }
        if (field === "lossPayee") {
          next.mortgage ??= { number_of_mortgages: null, mortgagees: [] };
          next.mortgage.loss_payees ??= [];
          next.mortgage.loss_payees[0] ??= { name: "", address: "" };
        }
        paths.push(habPropertyPaths[field]);
      }
      if (bucket.scope.type === "DRIVER" && driverPaths[field]) paths.push(["drivers", bucket.scope.id, driverPaths[field]]);
      if (bucket.scope.type === "VEHICLE") {
        const ownership = entries.some(e => e.source.documentType === "OWNERSHIP");
        if (ownership && ownershipPaths[field]) {
          const vehicle = next.vehicles.find(v => v.id === bucket.scope.id)!;
          vehicle.ownership ??= { received: true, registered_owner: "", address: "", year: null, make: "", model: "", vin: "", leased: null, lessor: null, lienholder: null };
          paths.push(["vehicles", bucket.scope.id, "ownership", ownershipPaths[field]]);
        } else if (vehiclePaths[field]) paths.push(["vehicles", bucket.scope.id, vehiclePaths[field]]);
      }
      if (field === "premium") {
        if (entries.some(e => /QUOTE$/.test(e.source.documentType))) paths.push(["premium", "quoted_annual"]);
        if (entries.some(e => e.source.documentType === "PORTAL_SCREENSHOT")) paths.push(["premium", "portal_annual"]);
      }
    }
    if (resolved !== null && item.status !== "conflict" && !item.associationReview) for (const path of paths) {
      const at = slot(next, path); if (!at || blocked.has(JSON.stringify(path))) continue;
      const numericFields=new Set(["year","annualKm","commuteKm","premium","demeritPoints",
        "numberOfMortgages","yearBuilt","families","units","livingArea","bedrooms","bathrooms"]);
      const boolFields=new Set(["smokeFree","swimmingPool","rental","airbnb","vacant"]);
      const val=typeof resolved==="string"?resolved.trim().toUpperCase():resolved;
      const boolValue=typeof resolved==="boolean"?resolved:typeof val==="string"?
        /^(YES|TRUE|Y|1)$/.test(val)?true:/^(NO|FALSE|N|0)$/.test(val)?false:undefined:undefined;
      const value=numericFields.has(field)?numeric(resolved):
        boolFields.has(field)?boolValue:field==="lessor"||field==="lienholder"?
          {name:String(resolved),address:""}:resolved;
      if(value===undefined||value===null)continue;
      if (manual || priorTargets.some(t => same(t.path, path)) || !nonempty(at.target[at.key]) || same(at.target[at.key], value)) {
        const baseline = old?.appliedTargets?.find(t => same(t.path, path))?.previousValue ?? at.target[at.key] ?? null;
        at.target[at.key] = value;
        item.appliedTargets = [...item.appliedTargets!.filter(t => !same(t.path, path)), { path, value, previousValue: baseline }];
      } else if (bucket?.scope.type === "DRIVER") item.evidenceReview = true;
    }
    fields.push(item);
  }
  next.field_sources = fields;
  next.claims = next.claims.filter(claim => {
    if (!claim.source || activeClaimIds.has(claim.id)) return true;
    const related = fields.filter(f => f.subjectType === "CLAIM" && f.subjectId === claim.id);
    if (related.some(f => f.status === "resolved" || f.evidenceReview)) { claim.source_active = false; claim.evidence_review = true; return true; }
    const old = current.claims.find(c => c.id === claim.id) ?? claim;
    next.withdrawn_claims = [...(next.withdrawn_claims ?? []).filter(c => c.id !== claim.id), old];
    return false;
  });
  flagPossibleDuplicateClaims(next.claims);
  for (const vehicle of next.vehicles) if (vehicle.ownership) vehicle.ownership.received = fields.some(f => f.subjectId === vehicle.id && f.values.some(v => v.source === "ownership"));
  const apps = sources.filter(source => source.documentType === "CTSAC_MEMBERSHIP_APPLICATION");
  const ctsac = apps.length === 1 ? apps[0] : undefined;
  const degrees = sources.filter(source => source.documentType === "DIPLOMA" || source.documentType === "DEGREE_CERTIFICATE");
  const diploma = degrees.length === 1 ? degrees[0] : undefined;
  const applicationSupport = ctsac ? JSON.stringify([supportId(ctsac), ctsac.data]) : "";
  let membershipDecision = next.group_discount?.membershipDecision;
  if (!membershipDecision && next.group_discount?.ctsac_application?.internal_status && next.broker_overrides?.some(o => o.alert_code === "CTSAC_STATUS_UNCONFIRMED")) {
    membershipDecision = { value: next.group_discount.ctsac_application.internal_status, support: applicationSupport, evidenceReview: !applicationSupport };
  }
  if (membershipDecision) membershipDecision = { ...membershipDecision, evidenceReview: membershipDecision.evidenceReview || membershipDecision.support !== applicationSupport };
  if (ctsac || diploma || next.group_discount) {
    const app = ctsac?.data;
    const degree = diploma?.data;
    next.group_discount = {
      ...next.group_discount,
      membershipDecision,
      activeEvidence: { application: ctsac ? [supportId(ctsac)] : [], diploma: diploma ? [supportId(diploma)] : [] },
      withdrawnEvidence: { ...next.group_discount?.withdrawnEvidence, ...(!ctsac && next.group_discount?.ctsac_application ? { ctsac_application: next.group_discount.ctsac_application } : {}), ...(!diploma && next.group_discount?.diploma ? { diploma: next.group_discount.diploma } : {}) },
      selected: next.group_discount?.selected ?? false,
      association: "CTSAC",
      status: "NEEDS_REVIEW",
      ctsac_application: app ? {
        chinese_name: String(app.chineseName ?? "") || undefined, english_name: String(app.englishName ?? "") || undefined, phone: String(app.phone ?? "") || undefined, email: String(app.email ?? "") || undefined, wechat: String(app.wechat ?? "") || undefined, city_province: String(app.cityProvince ?? "") || undefined, employer_institution: String(app.employerInstitution ?? "") || undefined, position_title: String(app.positionTitle ?? "") || undefined, field_specialty: String(app.fieldSpecialty ?? "") || undefined, highest_degree: String(app.highestDegree ?? "") || undefined, university: String(app.university ?? "") || undefined, applicant_signature: String(app.applicantSignature ?? "") || undefined, application_date: String(app.applicationDate ?? "") || undefined, internal_status: ["approved", "pending", "declined"].includes(String(app.internalStatus).toLowerCase()) ? String(app.internalStatus).toLowerCase() as "approved" | "pending" | "declined" : "not_confirmed", member_number: String(app.memberNumber ?? "") || undefined, review_date: String(app.reviewDate ?? "") || undefined,
      } : undefined,
      diploma: degree ? { holder_name: String(degree.holderName ?? "") || undefined, date_of_birth: String(degree.dateOfBirth ?? "") || undefined, university: String(degree.university ?? "") || undefined, degree: String(degree.degree ?? "") || undefined, major: String(degree.major ?? "") || undefined, issue_date: String(degree.issueDate ?? "") || undefined, certificate_number: String(degree.certificateNumber ?? "") || undefined, country_institution: String(degree.countryInstitution ?? "") || undefined, readable: diploma!.confidence >= .8 } : undefined,
    };
    if (membershipDecision && next.group_discount.ctsac_application && !membershipDecision.evidenceReview) next.group_discount.ctsac_application.internal_status = membershipDecision.value;
  }
  next.provenanceWarnings = [...new Set([
    ...(next.provenanceWarnings ?? []).filter(message => !message.startsWith("Lease status has uncertain") && !message.startsWith("Zero mortgages has uncertain") && !message.startsWith("Multiple active CTSAC") && !message.startsWith("Multiple active diploma")),
    ...(next.ownership?.leased === false && !next.factConfirmations?.["ownership.leased"]?.confirmed ? ["Lease status has uncertain provenance; confirm the retained value."] : []),
    ...(next.mortgage?.number_of_mortgages === 0 && !next.factConfirmations?.["mortgage.none"]?.confirmed ? ["Zero mortgages has uncertain provenance; confirm the retained value."] : []),
    ...(apps.length > 1 ? ["Multiple active CTSAC applications require broker review; no applicant was selected automatically."] : []),
    ...(degrees.length > 1 ? ["Multiple active diploma sources require broker review; no credential was selected automatically."] : []),
  ])];
  return next;
}

export function removeDocumentFromCase(current: InsuranceCase, documentId: string, remainingRecords: UploadedDocumentRecord[]): InsuranceCase {
  return reconcileDocumentsIntoCase(current, remainingRecords.filter(record => record.id !== documentId));
}


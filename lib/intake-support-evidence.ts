import type { InsuranceCase, Vehicle } from "./insurance-types.ts";
import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";
import { activeBoundEvidence, type IntakeEvidenceBinding } from "./intake-person-evidence.ts";

export type SupportPurpose = "OPCF43" | "SIGNED_OPCF" | "DISCOUNT" | "OLD_VEHICLE";
export type DiscountKind = "DRIVER_TRAINING" | "STUDENT" | "WINTER_TIRES" | "ANTI_THEFT" | "RETIREE";
export const DISCOUNT_TYPES: readonly DiscountKind[] = ["DRIVER_TRAINING","STUDENT","WINTER_TIRES","ANTI_THEFT","RETIREE"];
export const SIGNED_OPCFS = ["28A","49","19","13C"] as const;
export type SignedOpcf = typeof SIGNED_OPCFS[number];
export interface IntakeSupportProof extends IntakeEvidenceBinding {
  purpose: SupportPurpose;
  code: string;
  subject_key: string;
  signature_page?: number;
  signer_name?: string;
  verified_at: string;
  verified_by: string;
}
export interface SelectedDiscount {
  kind: DiscountKind;
  subject_key: string;
}
export interface DiscountSelectionReview {
  reviewed_at: string;
  reviewed_by: string;
  selections: SelectedDiscount[];
}
export interface IntakeWarningFacts {
  quote_issued_date?: string;
  quote_bound?: boolean;
  planned_bind_date?: string;
  vehicle_physical_damage?: Array<{ vehicle_key: string; selected: boolean }>;
}
export interface SupportIssue {
  code: string;
  message: string;
  field?: string;
  vehicle_id?: string;
  document_id?: string;
}
export const proofKey = (p: Pick<IntakeSupportProof,"purpose"|"code"|"subject_key">) =>
  [p.purpose, p.code.toUpperCase(), p.subject_key].join("|");

/** Never match arbitrary text or PDF filenames. These are explicitly selected structured policy fields. */
export function selectedOpcfCodes(item: InsuranceCase): {code:string; subject_key?:string}[] {
  const rows: Array<{code:string;subject_key?:string}> = [];
  const fromValue = (value: unknown, subject_key?:string) => {
    if (typeof value !== "string") return;
    const normalized = value.toUpperCase().replace(/[\u2010-\u2015]/g,"-");
    const pattern = /(?:^|[^A-Z0-9])(?:OPCF[\s\-]*)?(43|28A|49|19|13C)(?![A-Z0-9])/g;
    for (const match of normalized.matchAll(pattern)) rows.push({code:match[1],...(subject_key ? {subject_key}: {})});
  };
  for (const entry of item.coverage?.endorsements ?? []) fromValue(entry);
  for (const entry of item.policy_change?.endorsement_changes ?? []) {
    if (entry.action === "REMOVE" ||
      entry.new_status === "DECLINED" || entry.new_status === "NOT_ELIGIBLE" ||
      entry.new_status === "REMOVED") continue;
    fromValue(entry.endorsement,entry.vehicle);
  }
  // Explicit per-vehicle transactions take precedence over ambiguous policy-level listings.
  const specific=new Set(rows.filter(entry=>entry.subject_key).map(entry=>entry.code));
  return [...new Map(rows.filter(entry=>entry.subject_key || !specific.has(entry.code))
    .map(entry => [entry.code+"|"+(entry.subject_key??""),entry])).values()];
}
export function vehicleKey(vehicle: Vehicle): string {
  return String(vehicle.id || vehicle.vin || "").trim();
}
export function availableSubjectKeys(item: InsuranceCase, type: "VEHICLE"|"DRIVER"): string[] {
  if (type === "VEHICLE") {
    const keys=(item.vehicles??[]).map(vehicleKey);
    return keys.length === new Set(keys).size && keys.every(Boolean) ? keys : [];
  }
  const keys=(item.drivers??[]).map(driver => String(driver.id || driver.name || "").trim());
  return keys.length === new Set(keys.map(v=>v.toUpperCase())).size && keys.every(Boolean) ? keys : [];
}
export function expectedDiscountSubjectType(kind: DiscountKind): "VEHICLE"|"DRIVER" {
  return kind==="WINTER_TIRES"||kind==="ANTI_THEFT"?"VEHICLE":"DRIVER";
}
export function allowedSupportDocumentTypes(purpose: SupportPurpose, code: string): DocumentType[] {
  switch(purpose) {
    case "OPCF43": return code==="43" ? ["BILL_OF_SALE","LEASE_DOCUMENT"] : [];
    case "SIGNED_OPCF": return (SIGNED_OPCFS as readonly string[]).includes(code) ? ["OPCF_FORM","POLICY_CHANGE"] : [];
    case "OLD_VEHICLE": return code==="PHYSICAL_DAMAGE" ? ["VEHICLE_PHOTO","SAFETY_INSPECTION"] : [];
    case "DISCOUNT":
      switch(code) {
        case "DRIVER_TRAINING": return ["DRIVER_TRAINING_CERTIFICATE"];
        case "STUDENT": return ["STUDENT_PROOF"];
        case "WINTER_TIRES": return ["WINTER_TIRE_PROOF"];
        case "ANTI_THEFT": return ["ANTI_THEFT_PROOF"];
        case "RETIREE": return ["RETIREMENT_PROOF"];
        default: return [];
      }
  }
}
export function proofEvidenceValid(proof: IntakeSupportProof | undefined, records: UploadedDocumentRecord[]): boolean {
  if (!proof || !proof.verified_at || !proof.verified_by ||
    !allowedSupportDocumentTypes(proof.purpose,proof.code).length ||
    !activeBoundEvidence(proof,records,allowedSupportDocumentTypes(proof.purpose,proof.code))) return false;
  if (proof.purpose === "SIGNED_OPCF") return Boolean(
    proof.logical_document_id && proof.signer_name && Number.isInteger(proof.signature_page) &&
    Number.isInteger(proof.start_page) && Number.isInteger(proof.end_page) &&
    proof.signature_page! >= proof.start_page! && proof.signature_page! <= proof.end_page!);
  return true;
}
const anyValid = (proofs: IntakeSupportProof[], records: UploadedDocumentRecord[],
  purpose: SupportPurpose, code: string, subject_key?:string) =>
  proofs.some(p => p.purpose===purpose && p.code===code &&
    (subject_key===undefined || p.subject_key===subject_key) &&
    !proofs.some(other=>other!==p && other.purpose===purpose && other.code===code &&
      other.subject_key!==p.subject_key && other.document_id===p.document_id &&
      other.logical_document_id===p.logical_document_id) &&
    proofEvidenceValid(p,records));
export function checkOpcfSupport(item: InsuranceCase, records: UploadedDocumentRecord[]): SupportIssue[] {
  const findings: SupportIssue[]=[];
  const selections=selectedOpcfCodes(item);
  const proofs=item.intake_support_evidence??[];
  const vehicles=availableSubjectKeys(item,"VEHICLE");
  for (const selection of selections) {
    const {code}=selection;
    if (code==="43") {
      const explicit=selection.subject_key;
      const target=explicit ? (vehicles.find(v=>v.toUpperCase()===explicit.toUpperCase())??"") :
        (vehicles.length===1?vehicles[0]:undefined);
      if (explicit && !target) {
        findings.push({code:"INTAKE_OPCF43_VEHICLE",message:"OPCF 43 target vehicle is not a uniquely identified current vehicle.",field:"policy_change.endorsement_changes"});
      } else if (target && !anyValid(proofs,records,"OPCF43","43",target)) {
        findings.push({code:"INTAKE_OPCF43_PROOF",message:"Selected OPCF 43 requires an active Bill of Sale or Lease Agreement linked to its vehicle.",field:"intake_support_evidence",vehicle_id:target});
      } else if (!target && !proofs.some(p=>p.purpose==="OPCF43"&&p.code==="43"&&
        vehicles.includes(p.subject_key)&&proofEvidenceValid(p,records))) {
        findings.push({code:"INTAKE_OPCF43_VEHICLE_PROOF",message:"Identify the OPCF 43 vehicle and link its Bill of Sale / Lease Agreement; unrelated documents cannot satisfy this requirement.",field:"intake_support_evidence"});
      }
      continue;
    }
    const subject=selection.subject_key;
    const validSubject = !subject || vehicles.some(v=>v.toUpperCase()===subject.toUpperCase());
    if (!validSubject) {
      findings.push({code:"INTAKE_OPCF_SIGNED_VEHICLE",message:"Selected OPCF "+code+" has an unknown vehicle target.",field:"policy_change.endorsement_changes"});
    } else if (!anyValid(proofs,records,"SIGNED_OPCF",code,subject)) {
      findings.push({code:"INTAKE_OPCF_SIGNED_PROOF",message:"Selected OPCF "+code+" requires manually verified signed endorsement evidence with a linked signature page.",field:"intake_support_evidence",...(subject?{vehicle_id:subject}:{})});
    }
  }
  return findings;
}
export function checkDiscountSupport(item: InsuranceCase, records: UploadedDocumentRecord[]): SupportIssue[] {
  const issues: SupportIssue[]=[];
  const reviewed=item.intake_discount_review;
  if (!reviewed) return issues; // Only actually selected discounts create proof requirements.
  if (!reviewed.reviewed_at || !reviewed.reviewed_by || !Array.isArray(reviewed.selections)) {
    return [{code:"INTAKE_DISCOUNT_REVIEW_INVALID",message:"Discount selections need a valid broker review.",field:"intake_discount_review"}];
  }
  const proofs=item.intake_support_evidence??[];
  const seen=new Set<string>();
  for (const selection of reviewed.selections) {
    if (!(DISCOUNT_TYPES as readonly string[]).includes(selection.kind)) {
      issues.push({code:"INTAKE_DISCOUNT_KIND_INVALID",message:"Discount type is not supported.",field:"intake_discount_review"});continue;
    }
    const key=selection.kind+"|"+selection.subject_key;
    const subject=availableSubjectKeys(item,expectedDiscountSubjectType(selection.kind));
    if (seen.has(key) || !subject.includes(selection.subject_key)) {
      issues.push({code:"INTAKE_DISCOUNT_TARGET_INVALID",message:selection.kind+" must be assigned once to an active "+expectedDiscountSubjectType(selection.kind).toLowerCase()+".",field:"intake_discount_review"});continue;
    }
    seen.add(key);
    if (!anyValid(proofs,records,"DISCOUNT",selection.kind,selection.subject_key)) {
      issues.push({code:"INTAKE_DISCOUNT_PROOF",message:"Selected "+selection.kind.replaceAll("_"," ")+" discount requires an active supporting document linked to "+selection.subject_key+".",field:"intake_support_evidence",vehicle_id:expectedDiscountSubjectType(selection.kind)==="VEHICLE"?selection.subject_key:undefined});
    }
  }
  return issues;
}
function calendarUtc(text?:string):number|undefined {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const date=new Date(text+"T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10)===text ? date.getTime() : undefined;
}
export function validCalendarDate(text:string):boolean {
  try{return calendarUtc(text)!==undefined;}catch{return false;}
}
export function evaluateIntakeWarnings(item:InsuranceCase, records:UploadedDocumentRecord[],
  evaluatedOn=new Date().toISOString().slice(0,10)):SupportIssue[] {
  const warnings: SupportIssue[]=[];
  const facts=item.intake_warning_facts;
  if (!facts) return warnings;
  const referenceDate=calendarUtc(item.policy_change?.change_effective_date || item.policy?.effective_date);
  const referenceYear=referenceDate===undefined?undefined:new Date(referenceDate).getUTCFullYear();
  const proofs=item.intake_support_evidence??[];
  for (const [index,vehicle] of (item.vehicles??[]).entries()) {
    const key=vehicleKey(vehicle);
    const damage=facts.vehicle_physical_damage?.find(v=>v.vehicle_key===key)?.selected;
    if (damage!==true || referenceYear===undefined || !Number.isInteger(vehicle.year) ||
      vehicle.year<1900 || vehicle.year>referenceYear || referenceYear-vehicle.year<15) continue;
    if (!anyValid(proofs,records,"OLD_VEHICLE","PHYSICAL_DAMAGE",key))
      warnings.push({code:"INTAKE_OLD_VEHICLE_PHYSICAL_DAMAGE",message:"Vehicle "+(index+1)+" ("+vehicle.year+") is at least 15 years old with selected Physical Damage; obtain relevant vehicle photos or safety inspection.",field:"intake_warning_facts.vehicle_physical_damage",vehicle_id:key});
  }
  if (facts.quote_bound !== false || !validCalendarDate(facts.quote_issued_date??"") ||
    !validCalendarDate(evaluatedOn)) return warnings;
  const issued=calendarUtc(facts.quote_issued_date)!;
  const current=calendarUtc(evaluatedOn)!;
  const planned=validCalendarDate(facts.planned_bind_date??"")?calendarUtc(facts.planned_bind_date):undefined;
  const assessment=Math.max(current,planned??current);
  const age=Math.floor((assessment-issued)/86400000);
  const max=/\bmax\b/i.test(item.policy?.company??"");
  const threshold=max?60:30;
  if (age>threshold) warnings.push({code:"INTAKE_QUOTE_AGE",message:"Unbound "+(max?"Max ":"")+"quote is "+age+" days old (threshold "+threshold+" days); refresh or confirm current terms before binding.",field:"intake_warning_facts.quote_issued_date"});
  return warnings;
}

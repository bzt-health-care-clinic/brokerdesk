/**
 * Broker Review source adapter.  Deliberately narrow: bind parser observations only
 * when both the physical file and the business entity are unambiguous.
 * The actual PDF bytes, NOT cached browser flags, establish the source fingerprint.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const clean = value => String(value ?? "").trim();
const sectionWithdrawn=(record,section)=>(record.withdrawnSectionRanges??[]).some(r=>
  (section.startPage??1)<=r.endPage && (section.endPage??section.startPage??1)>=r.startPage);
const sameName=(a,b)=>{
  const tokens=value=>typeof value==="string" ? value.normalize("NFKC").toUpperCase()
    .replace(/[.,'’\x60\-_/\\()[\]{}:;!?"“”‘]/g," ").split(/\s+/).filter(Boolean).sort().join(" ") : "";
  const left=tokens(a),right=tokens(b);
  return !!left && left===right;
};
const normVin = value => clean(value).replace(/[\s-]/g, "").toUpperCase();
const normLicence = value => clean(value).replace(/[\s-]/g, "").toUpperCase();
const normalizedAddress = value => clean(value).replace(/[.,]/g, " ").replace(/\s+/g, " ").toUpperCase();
const dateString = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

export function verifiedReviewDocuments(repo, caseId) {
  const records = repo.listDocuments(caseId);
  const verified = [], warnings = [], sources = [];
  for (const record of records) {
    const path = repo.documentPath(record.id);
    if (!path) {
      warnings.push(`File ${record.id}: original bytes unavailable.`);
      continue;
    }
    const hash = sha256(readFileSync(path.path));
    if (!/^[a-f0-9]{64}$/i.test(record.sourceHash ?? "") ||
        record.sourceHash !== hash || record.staleExtraction === true) {
      warnings.push(`File ${record.id}: changed, stale or unverified source.`);
      continue;
    }
    const sections = record.logicalDocuments ?? [];
    const extracted = [...(record.parsedSources ?? []), ...(record.parsed ? [record.parsed] : [])];
    verified.push({id:record.id,sha256:hash});
    for (const observation of extracted) {
      if (observation.documentId !== record.id) continue;
      if (observation.logicalDocumentId) {
        const sec = sections.find(s => s.id === observation.logicalDocumentId &&
          s.documentType === observation.documentType && s.presenceStatus === "FOUND");
        if (!sec || sectionWithdrawn(record,sec)) continue;
        if (observation.sourceRevision && observation.sourceRevision !== JSON.stringify([
          sec.physicalFileId, sec.id, sec.documentType, sec.startPage ?? 1,
          sec.endPage ?? sec.startPage ?? 1, sec.subjectType ?? "",
          sec.subjectId ?? "", sec.subjectName ?? ""
        ])) continue;
      } else if (sections.length && (sections.length !== 1 ||
            sections[0].documentType !== observation.documentType ||
            sections[0].presenceStatus !== "FOUND" || sectionWithdrawn(record,sections[0]))) continue;
      const exposed = Array.isArray(observation.entities)
        ? observation.entities.filter(e => !e.excluded).map(e=>({
            ...observation, data:e.data, fieldEvidence:e.fieldEvidence ?? {},
            warnings:[...(observation.warnings??[]),...(e.warnings??[])],
            subjectType:e.kind, subjectId:e.id, entityKind:e.kind
          })) : [];
      sources.push({record,hash,observation});
      for (const entity of exposed) sources.push({record,hash,observation:entity});
    }
  }
  verified.sort((a,b)=>a.id.localeCompare(b.id));
  return {records,verified,warnings,sources};
}

const sourceKeys = Object.freeze({
  "policy.insured":["insuredName","namedInsured"],
  "policy.mailingAddress":["mailingAddress"],
  "policy.riskAddress":["riskAddress"],
  "home.riskAddress":["riskAddress"],
  "home.yearBuilt":["yearBuilt"],
  "home.occupancy":["occupancy"],
  "home.structure":["structure"],
  "home.construction":["construction"],
  "home.livingArea":["livingArea"],
});
const vehicleKeys = Object.freeze({
  vin:["vin"],year:["year"],make:["make"],model:["model"],use:["vehicleUse"],
  annualKm:["annualKm"],commuteOneWayKm:["commuteKm","commuteOneWayKm"],
  winterTires:["winterTires"],liability:["liability"],
  "allPerils.deductible":["allPerilsDeductible"],
  "collision.deductible":["collisionDeductible"],
  "comprehensive.deductible":["comprehensiveDeductible"],
});
const driverKeys = Object.freeze({
  name:["driverName","name"],dob:["dob"],licenceNumber:["licenceNumber"],
  licenceClass:["licenceClass"],licenceProvince:["licenceProvince"],
  g1Date:["g1Date"],g2Date:["g2Date"],gDate:["gDate"],
});
const fieldValue = (record, keys) => {
  for(const key of keys ?? []) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== "") return [key,value];
  }
  return null;
};
const acceptable = value => ["string","number","boolean"].includes(typeof value) || Array.isArray(value);
const valueConvert = (field, value) => {
  if(field.type==="number") {
    const n=typeof value==="number"?value:Number(clean(value).replace(/[,$ ]/g,""));
    return Number.isFinite(n)?n:null;
  }
  if(field.type==="boolean") {
    if(typeof value==="boolean") return value;
    const s=clean(value).toLowerCase();
    return ["yes","true","y"].includes(s)?true:["no","false","n"].includes(s)?false:null;
  }
  return value;
};
const evidencePage = (source, key, record) => {
  if (record.state === "NEEDS_REVIEW" || record.extractionStatus === "NEEDS_REVIEW") return null;
  // OCR or unverified parser warnings are candidates for human review, never
  // verified auto-fill. Native text remains eligible if its field is reliable.
  if ((source.warnings??[]).some(w=>w.field===key &&
      (/review|conflict|ambiguous|unverified/i.test(w.code??"") || w.severity==="high"))) return null;
  const refs=source.fieldEvidence?.[key];
  if (!Array.isArray(refs) || !refs.length) return null;
  const pages=new Set();
  for (const p of refs) {
    if (!Number.isSafeInteger(p.page) || p.page<1 ||
        (/ocr|paddle/i.test(String(p.provider??p.source??"")) &&
          !(p.verified === true && p.confidence >= 0.95))) return null;
    if (typeof p.confidence==="number" && p.confidence<0.85) return null;
    pages.add(p.page);
  }
  if (pages.size!==1) return null;
  const page=[...pages][0];
  const section=source.logicalDocumentId ?
    (record.logicalDocuments??[]).find(s=>s.id===source.logicalDocumentId) :
    record.logicalDocuments?.length===1 ? record.logicalDocuments[0] : undefined;
  if ((source.logicalDocumentId && !section) || (section &&
      (page<(section.startPage??1) || page>(section.endPage??section.startPage??1) || sectionWithdrawn(record,section)))) return null;
  if (Array.isArray(record.packagePages) && record.packagePages.length &&
      !record.packagePages.some(p=>p.page===page || p.pageNumber===page)) return null;
  return page;
};

/**
 * Only exact VIN / licence matches are bound to existing entities.
 * Do not match by number of existing entities or by driver names alone.
 */
export function buildExplicitReviewCandidates(caseData, catalogFields, verifiedSources) {
  const lookup=new Map(catalogFields.map(f=>[f.id,f]));
  const candidates=[], skipped=[];
  // Duplicated identity keys are ambiguous, even when the values match
  // exactly. Never silently assign evidence to the last duplicate.
  const uniqueKeys=(items,keyOf,idOf,isValid)=>{
    const counts=new Map();
    for (const item of items) {
      const key=keyOf(item);
      if(isValid(key))counts.set(key,(counts.get(key)??0)+1);
    }
    return new Map(items.filter(item=>{
      const key=keyOf(item);
      return isValid(key)&&counts.get(key)===1;
    }).map(item=>[keyOf(item),idOf(item)]));
  };
  const byVin=uniqueKeys(caseData.vehicles??[],v=>normVin(v.vin),
    v=>String(v.id||v.vin),v=>/^[A-HJ-NPR-Z0-9]{17}$/i.test(v));
  const byLicence=uniqueKeys(caseData.drivers??[],d=>normLicence(d.licence_number),
    d=>String(d.id||d.licence_number),v=>Boolean(v));
  const add=(context,id,keys)=>{
    const field=lookup.get(id), pair=fieldValue(context.observation.data,keys);
    if(!field||!pair||!acceptable(pair[1]))return;
    const [key,raw]=pair, value=valueConvert(field,raw), page=evidencePage(context.observation,key,context.record);
    if (value===null || page===null) {skipped.push(id);return;}
    candidates.push({fieldId:id,value,documentId:context.record.id,
      sourceHash:context.hash,page,active:true,
      logicalDocumentId:context.observation.logicalDocumentId ?? null,
      parserVersion:context.record.parserVersion ?? null});
  };
  for(const context of verifiedSources) {
    const s=context.observation, data=s.data??{};
    if (!data || typeof data!=="object" || Array.isArray(data)) continue;
    const isReport=["MVR","DASH"].includes(s.documentType);
    const vin=normVin(data.vin), licence=normLicence(data.licenceNumber);
    if(["AUTO_QUOTE","AUTO_APPLICATION","HAB_QUOTE","HAB_APPLICATION"].includes(s.documentType) &&
       !s.entityKind) {
      for(const [id,keys] of Object.entries(sourceKeys)) {
        if (!id.startsWith("policy.")) continue;
        if (id==="policy.insured" && !sameName(data.insuredName??data.namedInsured,caseData.insured?.name)) {
          skipped.push(id);continue;
        }
        add(context,id,keys);
      }
    }
    if (["HAB_QUOTE","HAB_APPLICATION"].includes(s.documentType) &&
        data.riskAddress && normalizedAddress(data.riskAddress) ===
        normalizedAddress(caseData.habitational_risk?.risk_address)) {
      for(const [id,keys] of Object.entries(sourceKeys))
        if(id.startsWith("home."))add(context,id,keys);
    }
    if(vin && byVin.has(vin)) {
      const prefix=`vehicle:${byVin.get(vin)}.`;
      for(const [key,sourceFields] of Object.entries(vehicleKeys))
        add(context,prefix+key,sourceFields);
    }
    if (licence && byLicence.has(licence)) {
      const prefix=`driver:${byLicence.get(licence)}.`;
      for(const [key,sourceFields] of Object.entries(driverKeys))
        add(context,prefix+key,sourceFields);
    }
    // Report pull date is deliberately NOT guessed from generic PDF metadata.
    void isReport;
  }
  return {candidates,skipped:[...new Set(skipped)]};
}

export function reviewCaseSignature(item) {
  const keys=["case_type","policy","insured","drivers","vehicles","habitational_risk",
    "coverage","claims","prior_insurance","payment","documents","policy_change"];
  const selected=Object.fromEntries(keys.map(key=>[key,item?.[key]??null]));
  return sha256(Buffer.from(JSON.stringify(selected)));
}


// Checklist documents are not physical uploads. Bind each required category to an
// active, byte-verified original section before confirming the Documents page.
const CHECKLIST_DOCUMENT_TYPES={
  signed_application:["AUTO_APPLICATION","HAB_APPLICATION"],quote:["AUTO_QUOTE","HAB_QUOTE"],
  ownership:["OWNERSHIP"],bill_of_sale:["BILL_OF_SALE"],vehicle_photo:["VEHICLE_PHOTO"],
  payment_authorization:["PAYMENT_AUTHORIZATION"],cancellation_request:["CANCELLATION_REQUEST"],
  mvr:["MVR"],dash:["DASH"],previous_policy:["PRIOR_AUTO_POLICY","PRIOR_PROPERTY_POLICY"],
  lease_agreement:["LEASE_DOCUMENT"],finance_document:["FINANCE_DOCUMENT"],
  winter_tire_proof:["WINTER_TIRE_PROOF"],mortgage_document:["MORTGAGE_DOCUMENT"],
  void_cheque:["VOID_CHEQUE"],signed_change_form:["POLICY_CHANGE","OPCF_FORM"],
  diploma:["DRIVER_TRAINING_CERTIFICATE"]
};
export function missingPhysicalChecklistDocuments(caseData,liveDocuments) {
  const verified=new Set(liveDocuments.verified.map(d=>d.id));
  const actualTypes=new Set();
  for(const record of liveDocuments.records) {
    if(!verified.has(record.id))continue;
    const sections=record.logicalDocuments===undefined?
      [{documentType:record.documentType,presenceStatus:"FOUND"}]:record.logicalDocuments;
    for(const section of sections) {
      if(section.presenceStatus!=="FOUND")continue;
      const withdrawn=(record.withdrawnSectionRanges??[]).some(r=>
        (section.startPage??1)<=r.endPage&&
        (section.endPage??section.startPage??1)>=r.startPage);
      if(!withdrawn)actualTypes.add(section.documentType);
    }
  }
  return (caseData.documents??[]).filter(doc=>doc.required===true).flatMap(doc=>{
    const allowed=CHECKLIST_DOCUMENT_TYPES[doc.category];
    return allowed?.some(type=>actualTypes.has(type))?[]:
      [`Required ${doc.name||doc.category}: no corresponding verified physical document.`];
  });
}

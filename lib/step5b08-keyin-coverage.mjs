/**
 * Step 5B-08 — repo-aligned Key-in catalog parity and evidence coverage audit.
 *
 * Audits existing BrokerDesk Step 4B Review fields; does not invent carrier
 * underwriting fields, OCR precision, or a second Key-in contract.
 * Code anchored to BrokerDesk PR #3 eac983c plus Step5B-01..07.
 *
 * Case/record based checks run both at Broker review and on reviewed-keyin
 * package validation. The stronger live-catalog check runs inside the Broker
 * service with deriveStep3eOptions(), which is not available to the Auditor.
 */
import {buildKeyinCatalog} from "./keyin-field-catalog.mjs";

const array = v => Array.isArray(v) ? v : [];
const object = v => v!==null && typeof v==="object" && !Array.isArray(v);
const string = v => typeof v==="string" ? v.trim() : "";
const unique = list => new Set(list).size===list.length;
const validSha = v => /^[a-f0-9]{64}$/i.test(string(v));
const hasValue = (v,id) => v!==null && v!==undefined &&
  !(typeof v==="string" && v.trim()==="") &&
  !(Array.isArray(v) && !v.length && !id.endsWith(".opcf"));
const same = (a,b) => JSON.stringify(a)===JSON.stringify(b);
const verifyPage = p => Number.isSafeInteger(p)&&p>=1;
function absentOrBadType(field) {
  const v=field?.value, type=field?.type;
  if(v===null||v===undefined)return false;
  // Optional Case date defaults are absent data, not malformed supplied dates.
  // Keep required dates and every non-date field on their existing strict path.
  if(type==="date" && field.required===false && typeof v==="string" && v.trim()==="")
    return false;
  if(type==="boolean")return typeof v!=="boolean";
  if(type==="number")return typeof v!=="number"||!Number.isFinite(v);
  if(type==="date") {
    if(typeof v!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(v))return true;
    const day=new Date(v+"T00:00:00Z");
    return !Number.isFinite(day.getTime())||day.toISOString().slice(0,10)!==v;
  }
  if(type==="list")return !Array.isArray(v)||v.some(x=>typeof x!=="string");
  if(type==="assignments")return !Array.isArray(v)||
    v.some(x=>!object(x)||!string(x.driverId)||!string(x.role));
  if(type==="record")return !object(v)&&!Array.isArray(v);
  if(type==="text"||type==="multiline")return typeof v!=="string";
  return true; // unreviewed future field kind may never pass by accident
}
const isWithdrawn = (record,section) => array(record.withdrawnSectionRanges).some(r=>
  (section.startPage??1)<=r.endPage &&
  (section.endPage??section.startPage??1)>=r.startPage);
/** Only active, physical report sections. An empty logicalDocuments[] is not an attested report. */
export function physicalKeyinReports(records=[]) {
  const found=new Map();
  for(const record of array(records)) {
    if(!string(record?.id))continue;
    const logical = record.logicalDocuments===undefined
      ? [{documentType:record.documentType,presenceStatus:"FOUND"}]
      : array(record.logicalDocuments);
    for(const s of logical) {
      if(s?.presenceStatus!=="FOUND"||isWithdrawn(record,s))continue;
      const type=s.documentType==="MVR"?"mvr":s.documentType==="DASH"?"dash":null;
      if(!type)continue;
      const logicalDocumentId=string(s.id)||null;
      const id=logicalDocumentId ? `${record.id}::${logicalDocumentId}` : record.id;
      found.set(`${type}:${id}`,{id,type,documentId:record.id,logicalDocumentId,
        sourceHash:string(record.sourceHash)});
    }
  }
  return [...found.values()].sort((a,b)=>
    `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}
function keyedFields(fields, problems,scope) {
  const map=new Map();
  for(const field of array(fields)){
    if(!object(field)||!string(field.id)){
      problems.push(`${scope}: Field row has no ID.`);continue;
    }
    if(map.has(field.id))problems.push(`${scope}: Duplicate field ID ${field.id}.`);
    map.set(field.id,field);
  }
  return map;
}
const dynamicField = id => id==="payment.plan" || /^quoteDiscount:.+\.(selected|evidencePresent)$/.test(id);
const actualReport = id => /^report:(mvr|dash):.+\.(pulledDate|summary)$/.test(id);
const safeSourceIds = review => new Map(array(review?.source_files).map(x=>
  [x.id,x.sha256]));

/**
 * Structural issues mean the draft must be rebuilt/rebased, not just edited.
 * Reconciliation issues can be addressed by editing a report summary, but the
 * source ledger itself is immutable. No manual "clear everything" switch.
 */
export function assessKeyinCoverage(review, {
  expectedFields=[], expectedSections=[], records=[], expectedExact=false,
  verifyRequired=false, caseDriverIds=[]
}={}) {
  const structuralIssues=[],reconciliationIssues=[],fieldIssues=[],warnings=[];
  if(!object(review)||!Array.isArray(review.fields)||
      !Array.isArray(review.sections)||!Array.isArray(review.expected_field_ids))
    return {schemaVersion:"5B-08-v1",structuralIssues:["Malformed Key-in review."],
      reconciliationIssues,fieldIssues,warnings,fields:[],sections:[],totals:{}};
  const fields=keyedFields(review.fields,structuralIssues,"Review");
  const expected=keyedFields(expectedFields,structuralIssues,"Catalog");
  const actualSections=array(review.sections).map(s=>s?.id);
  const wantedSections=array(expectedSections).map(s=>s?.id);
  if(!unique(actualSections)||actualSections.some(x=>!string(x)))
    structuralIssues.push("Duplicate or invalid Review section ID.");
  if(wantedSections.length&&!same(actualSections,wantedSections))
    structuralIssues.push("Review section catalog differs from canonical Case.");
  if(!unique(review.expected_field_ids)||
    !same(review.expected_field_ids,review.fields.map(f=>f?.id)))
    structuralIssues.push("Stored expected_field_ids disagree with actual field order.");
  for(const [id,shape] of expected){
    const field=fields.get(id);
    if(!field){structuralIssues.push(`Canonical Key-in field missing: ${id}.`);continue;}
    if(field.section!==shape.section||field.type!==shape.type||
       field.entityId!==shape.entityId||
       (verifyRequired && field.required!==shape.required))
      structuralIssues.push(`Canonical field schema mismatch: ${id}.`);
  }
  for(const [id,field] of fields){
    if(!actualSections.includes(field.section))
      structuralIssues.push(`Field references unknown section: ${id}.`);
    if(expectedExact&&!expected.has(id))
      structuralIssues.push(`Unexpected field outside live catalog: ${id}.`);
    else if(!expected.has(id)&&!dynamicField(id)&&!actualReport(id))
      structuralIssues.push(`Unexpected field outside static catalog: ${id}.`);
    else if(!expected.has(id)&&dynamicField(id)) {
      const isPayment=id==="payment.plan";
      if(field.section!==(isPayment?"documents":"coverage")||
         field.type!==(isPayment?"text":"boolean")||
         field.required!==true||field.entityId!==null)
        structuralIssues.push(`Dynamic field schema mismatch: ${id}.`);
    }
    if(absentOrBadType(field))fieldIssues.push(`Field value has wrong type: ${id}.`);
    if(field.origin==="EXTRACTED"||field.origin==="MANUAL_FROM_SOURCE") {
      if(!array(field.evidence).length)
        reconciliationIssues.push(`Source-bound field without evidence: ${id}.`);
    }
    if(field.conflict===true)
      fieldIssues.push(`Unresolved field conflict: ${id}.`);
  }
  const hashes=safeSourceIds(review);
  if(hashes.size!==array(review.source_files).length||
    [...hashes.entries()].some(([id,hash])=>!string(id)||!validSha(hash)))
    structuralIssues.push("Duplicate/invalid source-file inventory.");
  const recordsById=new Map(array(records).map(r=>[r.id,r]));
  for(const [id,field] of fields) {
    for(const p of array(field?.evidence)){
      if(!object(p)||!string(p.documentId)||hashes.get(p.documentId)!==p.sourceHash ||
          !verifyPage(p.page))
        reconciliationIssues.push(`Invalid field source reference: ${id}.`);
      if(records.length){
        const rec=recordsById.get(p.documentId);
        if(!rec||rec.sourceHash!==p.sourceHash)
          reconciliationIssues.push(`Field source not in physical archive: ${id}.`);
        const logical=array(rec?.logicalDocuments);
        const section=p.logicalDocumentId ?
          logical.find(s=>s.id===p.logicalDocumentId&&
            s.presenceStatus==="FOUND"&&!isWithdrawn(rec,s)):null;
        if(p.logicalDocumentId&&!section)
          reconciliationIssues.push(`Field logical source is inactive: ${id}.`);
        else if(section && ((Number.isSafeInteger(section.startPage)&&p.page<section.startPage)||
           (Number.isSafeInteger(section.endPage)&&p.page>section.endPage)))
          reconciliationIssues.push(`Field evidence page outside its logical report: ${id}.`);
        else if(!p.logicalDocumentId&&logical.length>1)
          reconciliationIssues.push(`Field evidence has no logical section in mixed PDF: ${id}.`);
      }
    }
  }
  // A duplicate logical-document identifier must not collapse two physical
  // MVR/DASH sections into one Map entry and falsely report complete coverage.
  for(const r of array(records)){
    const seenLogical=new Set(),logical=array(r?.logicalDocuments);
    for(const section of logical){
      if(section?.presenceStatus!=="FOUND"||isWithdrawn(r,section)||
         !["MVR","DASH"].includes(section?.documentType))continue;
      const id=string(section.id);
      if(logical.length>1&&!id)
        structuralIssues.push(`Mixed report missing distinct logical-section ID: ${r.id}.`);
      if(id && seenLogical.has(id))
        structuralIssues.push(`Duplicate physical report logical-section ID: ${r.id}.`);
      if(id)seenLogical.add(id);
    }
  }
  const reports=physicalKeyinReports(records);
  const physicalIds=new Set(reports.map(r=>`${r.type}:${r.id}`));
  for(const r of reports){
    for(const suffix of ["pulledDate","summary"]){
      const id=`report:${r.type}:${r.id}.${suffix}`;
      if(!fields.has(id))
        structuralIssues.push(`Physical ${r.type.toUpperCase()} has no Key-in ${suffix} field: ${r.id}.`);
    }
  }
  {
    for(const field of fields.values()){
      if(!actualReport(field.id))continue;
      const match=field.id.match(/^report:(mvr|dash):(.+)\.(pulledDate|summary)$/);
      if(match && !physicalIds.has(`${match[1]}:${match[2]}`))
        structuralIssues.push(`Report field has no active physical section: ${field.id}.`);
    }
  }
  const integrity=review.driver_history_integrity;
  if(reports.length) {
    if(!object(integrity)||integrity.schemaVersion!=="5B-07-v1" ||
       !Array.isArray(integrity.drivers)||!Array.isArray(integrity.reports)||
       !Array.isArray(integrity.blockingIssues)||!Array.isArray(integrity.unassigned)){
      reconciliationIssues.push("MVR/DASH reports require a 5B-07 integrity ledger.");
    }else {
      if(integrity.blockingIssues.length)
        reconciliationIssues.push(`MVR/DASH ledger has ${integrity.blockingIssues.length} blocking issues.`);
      if(integrity.unassigned.length)
        reconciliationIssues.push(`MVR/DASH ledger has ${integrity.unassigned.length} unassigned events.`);
      const ledgerReports=new Set();
      for(const r of integrity.reports) {
        const type=string(r.documentType).toLowerCase();
        const reportId=r.logicalDocumentId ?
          `${r.documentId}::${r.logicalDocumentId}` : r.documentId;
        const key=`${type}:${reportId}`;
        if(!physicalIds.has(key)||hashes.get(r.documentId)!==r.sourceHash)
          reconciliationIssues.push(`Ledger report not backed by current physical archive: ${reportId}.`);
        if(ledgerReports.has(key))reconciliationIssues.push(`Duplicate ledger report: ${reportId}.`);
        ledgerReports.add(key);
      }
      const rowsByKey=new Map();
      const allowedDriverIds=new Set(array(caseDriverIds).filter(x=>string(x)));
      for(const driver of integrity.drivers){
        if(!string(driver?.caseDriverId))
          reconciliationIssues.push("History event has no Case driver identifier.");
        else if(allowedDriverIds.size&&!allowedDriverIds.has(driver.caseDriverId))
          reconciliationIssues.push("History ledger references driver outside current Case.");
        for(const [kind,list] of [["mvr",driver?.convictions],["dash",driver?.claims]]){
          for(const event of array(list)){
            const source=event?.source, documentId=string(source?.documentId);
            const reportId=source?.logicalDocumentId ?
              `${documentId}::${source.logicalDocumentId}` : documentId;
            const key=`${kind}:${reportId}`;
            if(!physicalIds.has(key)||hashes.get(documentId)!==source?.sourceHash||
               !verifyPage(source?.page))
              reconciliationIssues.push(`Orphaned ${kind.toUpperCase()} ledger observation.`);
            rowsByKey.set(key,(rowsByKey.get(key)??0)+1);
          }
        }
      }
      // Prevent an earlier review summary from silently dropping verified
      // multi-row source events. Manual additions are allowed but not certified.
      for(const [key,count] of rowsByKey) {
        const [type,...rest]=key.split(":");
        const reportId=rest.join(":");
        const f=fields.get(`report:${type}:${reportId}.summary`);
        const rows=type==="mvr"?f?.value?.convictions:f?.value?.claims;
        const flag=type==="mvr"?"hasConvictions":"hasClaims";
        if(!Array.isArray(rows)||rows.length<count||f?.value?.[flag]!==true)
          reconciliationIssues.push(`Reviewed ${type.toUpperCase()} summary omits source event rows: ${reportId}.`);
      }
      for(const r of reports){
        const key=`${r.type}:${r.id}`;
        if(!ledgerReports.has(key))
          reconciliationIssues.push(`${r.type.toUpperCase()} ${r.id}: physical report absent from source history ledger.`);
        else if(!rowsByKey.has(key))
          warnings.push(`${r.type.toUpperCase()} ${r.id}: source event rows unrecorded or attested zero; verify report count evidence.`);
      }
    }
  }
  // Absence of physical report is a blocking discrepancy only when the Case
  // explicitly claims the relevant MVR/DASH checklist document was received.
  // The source Review's stored `required` flag is a catalog creation-time
  // default; BrokerDesk sectionIssues() makes conditional fields mandatory
  // based on current Broker selections. Match that policy in the coverage UI.
  const requiredNow=field=>{
    const id=field.id;
    for(const [suffix,controller,answer] of [
      [".commuteOneWayKm",".commute",true],
      [".garagingAddress",".parkingSameAsMailing",false],
      [".allPerils.deductible",".allPerils.present",true],
      [".collision.deductible",".collision.present",true],
      [".comprehensive.deductible",".comprehensive.present",true]
    ]) {
      if(id.endsWith(suffix))
        return fields.get(id.slice(0,-suffix.length)+controller)?.value===answer;
    }
    return field.required===true;
  };
  const fieldRows=[...fields.values()].map(field=>{
    const filled=hasValue(field.value,field.id);
    const status=field.conflict ? "CONFLICT" : !filled ? "MISSING" :
      field.origin==="EXTRACTED" && array(field.evidence).length ? "SOURCE_BOUND" :
      ["BROKER_CORRECTED","MANUAL_FROM_SOURCE"].includes(field.origin) ? "BROKER_EDITED" :
      "CASE_UNVERIFIED";
    return {id:field.id,section:field.section,required:requiredNow(field),
      state:status,origin:field.origin??null,evidenceCount:array(field.evidence).length};
  });
  const totals={
    catalogFields:fieldRows.length,
    required:fieldRows.filter(f=>f.required).length,
    missing:fieldRows.filter(f=>f.state==="MISSING").length,
    requiredMissing:fieldRows.filter(f=>f.required&&f.state==="MISSING").length,
    sourceBound:fieldRows.filter(f=>f.state==="SOURCE_BOUND").length,
    brokerEdited:fieldRows.filter(f=>f.state==="BROKER_EDITED").length,
    caseUnverified:fieldRows.filter(f=>f.state==="CASE_UNVERIFIED").length,
    conflicts:fieldRows.filter(f=>f.state==="CONFLICT").length,
    physicalReports:reports.length
  };
  const sections=actualSections.map(id=>({id,
    total:fieldRows.filter(f=>f.section===id).length,
    missing:fieldRows.filter(f=>f.section===id&&f.state==="MISSING").length,
    requiredMissing:fieldRows.filter(f=>f.section===id&&f.required&&f.state==="MISSING").length}));
  return {schemaVersion:"5B-08-v1",
    structuralIssues:[...new Set(structuralIssues)],
    reconciliationIssues:[...new Set(reconciliationIssues)],
    fieldIssues:[...new Set(fieldIssues)],warnings,totals,sections,fields:fieldRows};
}
/** Package-validation limited comparison; not an Auditor import integration. */
export function keyinPackageIntegrityIssues(review,item,records=[]) {
  const reports=physicalKeyinReports(records);
  const categories=[...new Set(reports.map(r=>r.type))];
  const catalog=buildKeyinCatalog(item,{
    reports:reports.map(({type,id})=>({type,id,pulledDate:null,summary:null})),
    reportCategoriesPresent:categories
  });
  const result=assessKeyinCoverage(review,{
    expectedFields:catalog.fields,expectedSections:catalog.sections,records,expectedExact:false,
    caseDriverIds:array(item?.drivers).map(d=>d.id).filter(Boolean)
  });
  // Required CASE checklist report without any physical file is not a clean report.
  for(const doc of array(item?.documents)){
    if(["mvr","dash"].includes(doc.category)&&doc.required===true&&doc.received===true &&
       !categories.includes(doc.category))
      result.structuralIssues.push(`Required ${doc.category.toUpperCase()} has no physical report.`);
  }
  return [...new Set([...result.structuralIssues,
    ...result.reconciliationIssues,...result.fieldIssues])];
}

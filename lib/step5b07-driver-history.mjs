/**
 * BrokerDesk Step 5B-07 — MVR/DASH driver history evidence ledger.
 *
 * A document row is evidence, never an instruction to mutate a Case driver.
 * No positional driver assignment, name-only linking, inference from empty
 * parser arrays, or last-write-wins reconciliation is permitted.
 *
 * Input: the contexts from verifiedReviewDocuments(repo,caseId), not unverified
 * raw PDF/OCR text. This module cannot attest that a parser found every row.
 */
import {createHash} from "node:crypto";

const HISTORY_TYPES = new Set(["MVR","DASH"]);
const FAILED_PAGE = new Set(["NEEDS_OCR","OCR_FAILED","PDF_RENDER_FAILED","FAILED"]);
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const arr = x => Array.isArray(x) ? x : [];
const str = x => typeof x === "string" ? x.trim() : "";
const upper = x => str(x).toUpperCase();
const validHash = h => /^[a-f0-9]{64}$/i.test(str(h));
const license = x => upper(x).replace(/[^A-Z0-9]/g, "");
const name = x => upper(x).normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu," ").replace(/\s+/g," ").trim();
const date = x => /^\d{4}-\d{2}-\d{2}$/.test(str(x)) ? str(x) : "";
const first = (x,keys) => keys.map(k=>x?.[k]).find(v=>v!==null && v!==undefined && (typeof v!=="string"||v.trim()!==""));
const stable = x => JSON.stringify(x,(k,v)=>obj(v)
  ? Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))) : v);
const digest = s => createHash("sha256").update(s).digest("hex").slice(0,24);
const integer = v => (typeof v==="number" && Number.isInteger(v) && v>=0)
  ? v : (typeof v==="string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
const physicalPage = v => {const n=integer(v);return n!==null&&n>=1&&n<=100000?n:null;};
const eventKind = kind => /^(CONVICTION|VIOLATION|TICKET)$/i.test(str(kind)) ? "conviction"
  : /^(CLAIM|LOSS|ACCIDENT)$/i.test(str(kind)) ? "claim" : null;
const identity = o => {
  const x=obj(o)?o:{};
  const nested=obj(x.driverIdentity)?x.driverIdentity:obj(x.driver)?x.driver:{};
  const v={...nested,...x};
  return {
    licence:license(first(v,["licenceNumber","licenseNumber","driverLicenceNumber","driverLicenseNumber","licence_number","license_number","licence","driverLicence","driverLicense"])),
    name:name(first(v,["driverName","fullName","name"])),
    birth:date(first(v,["dateOfBirth","birthDate","dob","driverDob"])),
    localId:str(first(v,["sourceDriverId","driverId","driverRef","driver_id"])),
    caseId:str(first(v,["caseDriverId","case_driver_id"]))
  };
};
const withPage = (row,scope,obs,kind,index) => {
  const ev=obs?.fieldEvidence??{};
  const proof=arr(ev[kind==="conviction"?"convictions":"claims"])[index];
  return physicalPage(first(row,["page","pageNumber","physicalPage"]))
    ??physicalPage(first(proof,["page","pageNumber"]))
    ??physicalPage(first(scope,["page","pageNumber"]))
    ??physicalPage(first(obs,["page","pageNumber"]));
};
const facts = (kind,row) => {
  // Do not copy parser-private fields, licence numbers or DOB into the audit.
  const names=kind==="conviction"
    ? ["convictionId","ticketNumber","offenceDate","convictionDate","offence","description","demeritPoints","jurisdiction","status","disposition"]
    : ["claimNumber","claimId","lossDate","accidentDate","description","claimType","amount","atFault","faultPercentage","status","vehicleVin"];
  return Object.fromEntries(names.filter(k=>row[k]!==undefined && row[k]!==null)
    .map(k=>[k,typeof row[k]==="string"?row[k].trim():row[k]]));
};
const numberFor = (kind,row) => str(first(row,kind==="conviction"
  ? ["convictionId","ticketNumber"] : ["claimNumber","claimId"])).toUpperCase();
const countFor = (data,kind) => {
  const keys=kind==="conviction"
    ? ["reportedConvictionCount","convictionCount","convictionsCount"]
    : ["reportedClaimCount","claimCount","claimsCount"];
  const n=first(data,keys);
  if(n!==undefined) return integer(n);
  const zero=kind==="conviction"
    ? first(data,["reportedNoConvictions"]) : first(data,["reportedNoClaims"]);
  return zero===true?0:null;
};
const pageFailed = p => FAILED_PAGE.has(upper(p?.pageOcrStatus))
  || (FAILED_PAGE.has(upper(p?.extractionStatus)) && !str(p?.text));

/**
 * A count is a claim about a report, not a claim about the page on which the
 * parser happened to record the driver/pull date. Only evidence for the EXACT
 * declared count key may locate it. This deliberately has no observation.page,
 * data.page, pulledDate or event-page fallback.
 */
const countFieldKeys = kind => kind==="conviction"
  ? ["reportedConvictionCount","convictionCount","convictionsCount"]
  : ["reportedClaimCount","claimCount","claimsCount"];
const sectionId = x => str(x?.id||x?.logicalDocumentId);
const withdrawnAt = (record,page) => arr(record?.withdrawnSectionRanges).some(r=>{
  const a=physicalPage(r?.startPage),b=physicalPage(r?.endPage);
  return a!==null&&b!==null&&a<=page&&page<=b;
});
const reportSection = (record,logicalDocumentId) => {
  const matches=arr(record?.logicalDocuments)
    .filter(s=>sectionId(s)===logicalDocumentId);
  return matches.length===1?matches[0]:null; // Never trust duplicate section IDs.
};
const sectionWithdrawn = (record,section) =>
  Boolean(section?.withdrawn||section?.revoked)
  || (section?.presenceStatus!==undefined && upper(section.presenceStatus)!=="FOUND")
  || arr(record?.withdrawnSectionRanges).some(r=>{
    const a=physicalPage(r?.startPage),b=physicalPage(r?.endPage);
    const start=physicalPage(section?.startPage),end=physicalPage(section?.endPage);
    return a!==null&&b!==null&&start!==null&&end!==null
      && a<=end&&b>=start;
  });
const sixYearLookback = evidence => {
  const text=[evidence?.text,evidence?.rawText,evidence?.sourceText,
    evidence?.snippet,evidence?.label,evidence?.context,
    evidence?.coverageScope,evidence?.period].map(str).join(" ");
  return /\b(?:last|past|previous|prior|within)\s+(?:six|6)\s+years?\b|\b(?:six|6)[- ]year\s+(?:claim|histor|period)|\bLAST[_ -]?6[_ -]?YEARS\b/i.test(text)
    || evidence?.lookbackYears===6;
};
const countPageEvidence = (data,obs,kind,record,report,reportIssue) => {
  const keys=countFieldKeys(kind);
  const declared=keys.filter(k=>data[k]!==undefined);
  if(!declared.length && data[kind==="conviction"?"reportedNoConvictions":"reportedNoClaims"]===true)
    declared.push(kind==="conviction"?"reportedNoConvictions":"reportedNoClaims");
  if(declared.length===0)return null;
  const field=obj(obs?.fieldEvidence)?obs.fieldEvidence:{};
  const local=obj(data?.fieldEvidence)?data.fieldEvidence:{};
  let absent=false,invalid=false,conflicting=false;
  const pages=new Set();
  for(const key of declared) {
    const localValue=local[key],rootValue=field[key];
    if(localValue!==undefined && rootValue!==undefined && stable(localValue)!==stable(rootValue)){
      conflicting=true;continue;
    }
    const value=localValue??rootValue;
    const evidence=Array.isArray(value)?value:obj(value)?[value]:[];
    if(!evidence.length){absent=true;continue;}
    for(const proof of evidence){
      if(!obj(proof)){invalid=true;continue;}
      const page=physicalPage(proof.page);
      const secondary=proof.pageNumber!==undefined?physicalPage(proof.pageNumber):page;
      if(page===null||secondary===null){absent=true;continue;}
      if(page!==secondary){conflicting=true;continue;}
      if((proof.documentId!==undefined && str(proof.documentId)!==report.documentId)
        || (proof.logicalDocumentId!==undefined
          && str(proof.logicalDocumentId)!==(report.logicalDocumentId??""))
        || (proof.sourceHash!==undefined
          && str(proof.sourceHash).toLowerCase()!==report.sourceHash)
        || (proof.hash!==undefined && str(proof.hash).toLowerCase()!==report.sourceHash)
        || (proof.documentType!==undefined && upper(proof.documentType)!==report.documentType)
        || proof.withdrawn===true||proof.revoked===true
        || (proof.presenceStatus!==undefined && upper(proof.presenceStatus)!=="FOUND")) {
        invalid=true;continue;
      }
      const sections=arr(record?.logicalDocuments);
      if(record?.logicalDocuments!==undefined && !sections.length){
        invalid=true;continue;
      }
      if(sections.length){
        const section=reportSection(record,report.logicalDocumentId);
        const start=physicalPage(section?.startPage),end=physicalPage(section?.endPage);
        if(!section||start===null||end===null||end<start
          ||(section.documentType&&upper(section.documentType)!==report.documentType)
          ||sectionWithdrawn(record,section)||page<start||page>end){
          invalid=true;continue;
        }
      }
      if(withdrawnAt(record,page)){invalid=true;continue;}
      // packagePages is a physical-page inventory when present.
      const inventory=arr(record?.packagePages);
      if(inventory.length && inventory.some(p=>physicalPage(p?.page??p?.pageNumber)!==null)
        && !inventory.some(p=>physicalPage(p?.page??p?.pageNumber)===page)){
        invalid=true;continue;
      }
      if(kind==="claim"&&report.documentType==="DASH"&&sixYearLookback(proof)){
        reportIssue("LIMITED_LOOKBACK_CLAIM_COUNT",{kind});
        invalid=true;continue;
      }
      pages.add(page);
    }
  }
  if(conflicting||pages.size>1)
    reportIssue("CONFLICTING_REPORTED_COUNT_PAGE",{kind});
  if(invalid)
    reportIssue("UNVERIFIED_REPORTED_COUNT_EVIDENCE",{kind});
  if(absent||!pages.size)
    reportIssue("MISSING_REPORTED_COUNT_PAGE",{kind});
  return !conflicting&&!invalid&&!absent&&pages.size===1 ? [...pages][0] : null;
};


/** A pure, JSON-serializable, evidence-bound ledger; contains no raw licence/DOB. */
export function analyzeDriverHistory(caseData,verifiedSources=[]) {
  const issueMap=new Map(),reports=new Map(),caseDrivers=arr(caseData?.drivers);
  const driverRows=new Map();
  const addIssue=(code,reportId,extra={})=>{
    const issue={code,reportId,...extra};
    issueMap.set(stable(issue),issue);
  };
  for(const d of caseDrivers) {
    const id=str(d?.id),idn=identity(d);
    if(!id){addIssue("CASE_DRIVER_WITHOUT_ID","CASE");continue;}
    if(driverRows.has(id)) {addIssue("DUPLICATE_CASE_DRIVER_ID","CASE",{caseDriverId:id});continue;}
    driverRows.set(id,{id,identity:idn,convictions:[],claims:[],reportedCounts:[]});
  }
  let relevant=0;
  for(const ctx of arr(verifiedSources)){
    const s=ctx?.observation??{},record=ctx?.record??{};
    const type=upper(s.documentType||record.documentType);
    if(!HISTORY_TYPES.has(type))continue;
    relevant++;
    const documentId=str(s.documentId||record.id);
    const logicalDocumentId=str(s.logicalDocumentId);
    const hash=str(ctx.hash||record.sourceHash);
    const reportId=digest([documentId,logicalDocumentId,hash,type].join("|"));
    const good=validHash(hash)&&validHash(record.sourceHash)
      &&str(record.sourceHash).toLowerCase()===hash.toLowerCase()
      &&(!s.sourceHash||str(s.sourceHash).toLowerCase()===hash.toLowerCase());
    if(!good||!documentId||(s.documentId&&str(s.documentId)!==str(record.id))) {
      addIssue("UNVERIFIED_REPORT_SOURCE",reportId);
      continue; // Never assign events from a broken source reference.
    }
    if(!logicalDocumentId && (arr(record.logicalDocuments).length>1
      ||upper(record.documentType)==="MIXED")){
      addIssue("MISSING_LOGICAL_DOCUMENT_BOUNDARY",reportId);
      continue; // Cannot associate a mixed file's rows with an MVR/DASH section.
    }
    if(record.logicalDocuments!==undefined){
      const section=reportSection(record,logicalDocumentId);
      if(!section || (section.documentType&&upper(section.documentType)!==type)){
        addIssue("UNVERIFIED_REPORT_SECTION",reportId);
        continue;
      }
      if(sectionWithdrawn(record,section)){
        addIssue("WITHDRAWN_REPORT_SECTION",reportId);
        continue; // No event or count from a withdrawn logical document.
      }
    }
    if(!reports.has(reportId))reports.set(reportId,{
      reportId,documentId,logicalDocumentId:logicalDocumentId||null,
      sourceHash:hash.toLowerCase(),documentType:type,
      contexts:[],dedup:new Set()
    });
    const r=reports.get(reportId);
    const data=obj(s.data)?s.data:{};
    const kind=upper(s.entityKind||s.subjectType);
    const subjectId=str(s.subjectId||s.entityId);
    const key=stable([subjectId,kind,data,s.fieldEvidence??{}]);
    if(r.dedup.has(key))continue;
    r.dedup.add(key);
    r.contexts.push({s,record,data,kind,subjectId});
  }
  const resultReports=[],allEntries=[],unassigned=[];
  for(const rep of reports.values()){
    const {reportId}=rep,people=new Map(),scopes=[],eventInputs=[],checks=[];
    const reportIssue=(code,extra={})=>addIssue(code,reportId,extra);
    const register=(person,sourceId)=>{
      if(!sourceId)return;
      const normalized=identity(person);
      if(people.has(sourceId) && stable(people.get(sourceId))!==stable(normalized)){
        reportIssue("SOURCE_DRIVER_ID_COLLISION");
        people.set(sourceId,null);return;
      }
      if(!people.has(sourceId))people.set(sourceId,normalized);
    };
    const pushScope=(data,obs,record,scopeId,root=false)=>{
      const ident=identity(data);
      scopes.push({data,obs,record,scopeId,ident,root});
      const explicitId=str(first(data,["sourceDriverId","id"]))
        ||(upper(obs?.entityKind)==="DRIVER"?str(obs.subjectId):"");
      register(data,explicitId); // Never register a fabricated positional label.
    };
    // First build the *document-local* identity table; never interpret a
    // parser's "driverId" as an application Case driver ID.
    for(const ctx of rep.contexts){
      const {data,s,record,kind,subjectId}=ctx;
      if(kind==="DRIVER"){
        pushScope(data,s,record,subjectId||str(first(data,["sourceDriverId","id"])));
      } else if(kind==="CONVICTION"||kind==="CLAIM"||kind==="LOSS"){
        // Entity records can coexist with report-level arrays.
      } else {
        const nested=arr(data.drivers);
        nested.forEach((person,i)=>{
          if(!obj(person)){reportIssue("UNSUPPORTED_DRIVER_SHAPE");return;}
          pushScope(person,s,record,str(first(person,["sourceDriverId","id"]))
            ||`anonymous-${digest(stable(identity(person))+"|"+i)}`);
        });
        if(obj(data.driver)){
          const combined={...data,...data.driver};
          for(const collection of ["convictions","claims"]){
            const reportRows=data[collection],personRows=data.driver[collection];
            if(reportRows!==undefined && personRows!==undefined
              && stable(reportRows)!==stable(personRows)){
              reportIssue("CONFLICTING_REPORT_COLLECTIONS",{kind:collection});
              // Retain every observation for reconciliation; do not choose
              // whichever array appears last in the source.
              combined[collection]=[...arr(reportRows),...arr(personRows)];
            }else if(reportRows!==undefined)combined[collection]=reportRows;
          }
          for(const key of [
            "reportedConvictionCount","convictionCount","convictionsCount",
            "reportedClaimCount","claimCount","claimsCount",
            "reportedNoConvictions","reportedNoClaims"
          ]){
            if(data[key]!==undefined && data.driver[key]!==undefined
              && stable(data[key])!==stable(data.driver[key]))
              reportIssue("CONFLICTING_REPORT_COUNTS",{kind:key});
            if(data[key]!==undefined)combined[key]=data[key];
          }
          pushScope(combined,s,record,
            str(first(data.driver,["sourceDriverId","id"]))||"report-person");
        } else {
          pushScope(data,s,record,"root",true);
        }
      }
    }
    const addInput=(kind,row,scope,obs,position,scopeKey)=>{
      if(!obj(row)){reportIssue("UNSUPPORTED_EVENT_SHAPE");return;}
      const page=withPage(row,scope,obs,kind,position);
      const localKey=str(first(row,["sourceRowId","rowId","sourceEventId","id"]));
      const sourceRow=localKey||`${scopeKey}:${kind}:${position}`;
      eventInputs.push({kind,row,scope,obs,page,sourceRow,scopeKey});
    };
    for(const ctx of rep.contexts){
      const {kind,data,s,subjectId}=ctx;
      const ek=eventKind(kind);
      if(ek){
        // Avoid duplicating a structured entity under a driver-level array
        // when the parser provides the same explicit source item ID.
        const entityRowId=str(first(data,["sourceRowId","rowId","sourceEventId","id"]));
        const entityKey=entityRowId||`entity-${digest(stable(data)+"|"+subjectId)}`;
        addInput(ek,data,{},s,0,entityKey);continue;
      }
    }
    for(const sc of scopes){
      // Unknown parser keys must not be treated as a clean empty report.
      // Extend this allow-list only after inspecting the real parser schema.
      const knownHistory=new Set([
        "convictions","claims","reportedConvictionCount","convictionCount",
        "convictionsCount","reportedClaimCount","claimCount","claimsCount",
        "reportedNoConvictions","reportedNoClaims"
      ]);
      for(const key of Object.keys(sc.data)){
        if(/convict|claim|violation|citation|accident|lossHistory/i.test(key)
          && !knownHistory.has(key))
          reportIssue("UNSUPPORTED_HISTORY_FIELD",{key});
      }
      for(const kind of ["conviction","claim"]){
        const attr=kind==="conviction"?"convictions":"claims";
        const value=sc.data[attr];
        if(value!==undefined && !Array.isArray(value))
          reportIssue("UNSUPPORTED_EVENT_SHAPE",{kind});
        arr(value).forEach((row,i)=>addInput(kind,row,sc.data,sc.obs,i,sc.scopeId));
        const expected=countFor(sc.data,kind);
        const countKeys=countFieldKeys(kind);
        if(countKeys.some(k=>sc.data[k]!==undefined) && expected===null)
          reportIssue("INVALID_REPORTED_COUNT",{kind});
        const explicit=kind==="conviction"?"reportedNoConvictions":"reportedNoClaims";
        if(expected!==null){
          if(countKeys.filter(k=>sc.data[k]!==undefined)
            .some(k=>integer(sc.data[k])!==expected))
            reportIssue("CONFLICTING_REPORT_COUNTS",{kind});
          const page=countPageEvidence(sc.data,sc.obs,kind,sc.record,
            rep,reportIssue);
          checks.push({kind,scopeKey:sc.scopeId,expected,page,
            scopeIdent:sc.ident,source:"reported"});
        } else if (sc.data[explicit]===true) {
          const page=countPageEvidence(sc.data,sc.obs,kind,sc.record,
            rep,reportIssue);
          checks.push({kind,scopeKey:sc.scopeId,expected:0,page,
            scopeIdent:sc.ident,source:"reported"});
        }
        else if(sc.data[explicit]!==undefined && sc.data[explicit]!==false)
          reportIssue("INVALID_REPORTED_COUNT",{kind});
      }
    }
    const seenItem=new Map(),seenContent=new Map();
    let assignedInReport=0;
    for(const input of eventInputs){
      const {kind,row,scope,obs,page,sourceRow,scopeKey}=input;
      const eident=identity(row),sident=identity(scope);
      let matchIdent={...sident,...Object.fromEntries(Object.entries(eident)
        .filter(([,v])=>Boolean(v)))};
      let identityConflict=false;
      if(eident.localId){
        const local=people.get(eident.localId);
        if(local===undefined){
          reportIssue("UNKNOWN_SOURCE_DRIVER_REF",{kind});
          matchIdent=eident;
        }else if(local===null){
          matchIdent=eident;reportIssue("AMBIGUOUS_SOURCE_DRIVER_REF",{kind});
        }else{
          if(local.licence&&sident.licence&&local.licence!==sident.licence){
            reportIssue("CONFLICTING_SOURCE_DRIVER_IDENTITY",{kind});
            identityConflict=true;
          }
          if(eident.licence&&local.licence&&eident.licence!==local.licence){
            reportIssue("CONFLICTING_SOURCE_DRIVER_IDENTITY",{kind});
            identityConflict=true;
          }
          matchIdent={
            ...local,
            ...Object.fromEntries(Object.entries(eident)
              .filter(([,v])=>Boolean(v)))
          };
        }
      }
      if(eident.licence && sident.licence && eident.licence!==sident.licence){
        reportIssue("CONFLICTING_SOURCE_DRIVER_IDENTITY",{kind});
        identityConflict=true;
      }
      const candidates=[];
      for(const d of driverRows.values()){
        const cid=d.identity;
        const licenceOK=matchIdent.licence && cid.licence
          && matchIdent.licence===cid.licence;
        const birthNameOK=matchIdent.name && matchIdent.birth && cid.name && cid.birth
          && matchIdent.name===cid.name && matchIdent.birth===cid.birth;
        if(!licenceOK&&!birthNameOK)continue;
        if(matchIdent.caseId&&matchIdent.caseId!==d.id)continue;
        // Known contradictory corroborators must not be ignored.
        if((matchIdent.licence&&cid.licence&&matchIdent.licence!==cid.licence)
          ||(matchIdent.birth&&cid.birth&&matchIdent.birth!==cid.birth)
          ||(matchIdent.name&&cid.name&&matchIdent.name!==cid.name))continue;
        candidates.push(d);
      }
      if(identityConflict)candidates.length=0;
      const itemFacts=facts(kind,row),number=numberFor(kind,row);
      const itemId=digest([reportId,scopeKey,kind,sourceRow].join("|"));
      const rowMeta={id:itemId,kind,source:{
        documentId:rep.documentId,logicalDocumentId:rep.logicalDocumentId,
        sourceHash:rep.sourceHash,documentType:rep.documentType,
        page,sourceRow,sourceScope:scopeKey,
        sourceDriverRef:eident.localId||null
      },facts:itemFacts};
      if(seenItem.has(itemId)){
        if(stable(seenItem.get(itemId))!==stable(rowMeta))
          reportIssue("DUPLICATE_EVENT_ID_CONFLICT",{eventId:itemId});
        continue;
      }
      seenItem.set(itemId,rowMeta);
      const duplicateKey=stable([scopeKey,kind,page,number,itemFacts]);
      if(seenContent.has(duplicateKey)&&seenContent.get(duplicateKey)!==itemId)
        reportIssue("POSSIBLE_DUPLICATE_EVENT",{kind});
      else seenContent.set(duplicateKey,itemId);
      if(page===null)reportIssue("MISSING_EVENT_PAGE",{eventId:itemId,kind});
      if(candidates.length!==1){
        const reason=candidates.length>1?"AMBIGUOUS_CASE_DRIVER":"UNMATCHED_CASE_DRIVER";
        reportIssue(reason,{eventId:itemId,kind});
        unassigned.push({...rowMeta,reason});continue;
      }
      const driver=candidates[0],assigned={...rowMeta,caseDriverId:driver.id};
      driver[kind==="conviction"?"convictions":"claims"].push(assigned);
      allEntries.push(assigned);assignedInReport++;
    }
    // A report-level count and a driver-scoped count may both exist; compare
    // independently. A missing count is NOT evidence for "zero".
    for(const chk of checks){
      const entries=[...allEntries,...unassigned].filter(e=>
        e.source.documentId===rep.documentId
        && e.source.logicalDocumentId===rep.logicalDocumentId
        && e.kind===chk.kind);
      const counted=chk.scopeKey==="root"||chk.scopeKey==="report-person"
        ? entries.length
        : entries.filter(e=>e.source.sourceScope===chk.scopeKey
          ||e.source.sourceDriverRef===chk.scopeKey).length;
      // Entity rows with explicit item ID are included at report level only.
      const actual=(chk.scopeKey==="root"||chk.scopeKey==="report-person")
        ? entries.length : counted;
      if(actual!==chk.expected)
        reportIssue("REPORTED_COUNT_MISMATCH",
          {kind:chk.kind,expected:chk.expected,observed:actual});
      if(chk.page===null)
        reportIssue("MISSING_REPORTED_COUNT_PAGE",{kind:chk.kind});
      if(chk.expected===0 && actual>0)
        reportIssue("CONTRADICTORY_REPORTED_ZERO",{kind:chk.kind});
      // Reporting counts without a uniquely known driver is not a confirmed
      // driver's clean MVR/DASH even if no rows were extracted.
      const matches=[...driverRows.values()].filter(d=>{
        const i=chk.scopeIdent,ci=d.identity;
        if(i.licence&&ci.licence&&i.licence!==ci.licence)return false;
        if(i.birth&&ci.birth&&i.birth!==ci.birth)return false;
        if(i.name&&ci.name&&i.name!==ci.name)return false;
        return (i.licence&&ci.licence===i.licence)
          ||(i.name&&i.birth&&ci.name===i.name&&ci.birth===i.birth);
      });
      if(matches.length!==1&&chk.scopeKey!=="root")
        reportIssue("UNATTRIBUTED_REPORT_COUNT",{kind:chk.kind});
      else if(matches.length===1)
        matches[0].reportedCounts.push({reportId,kind:chk.kind,count:chk.expected,
          sourceHash:rep.sourceHash,page:chk.page,coverageScope:"REPORT_ONLY"});
    }
    if(!checks.length)
      reportIssue("REPORT_COMPLETENESS_UNRECORDED");
    if(rep.contexts.some(c=>{
      const sections=arr(c.record?.logicalDocuments);
      const section=sections.find(x=>x?.id===rep.logicalDocumentId
        ||x?.logicalDocumentId===rep.logicalDocumentId);
      return arr(c.record?.packagePages).some(p=>{
        if(section){
          const n=physicalPage(p?.page??p?.pageNumber);
          if(n!==null&&(n<Number(section.startPage)||n>Number(section.endPage)))
            return false;
        }else if(sections.length>0 && upper(c.record?.documentType)!==rep.documentType)
          return false; // Unknown mixed-file interval: cannot assign failed page.
        return pageFailed(p);
      });
    }))reportIssue("UNREADABLE_REPORT_PAGE");
    resultReports.push({
      reportId,documentId:rep.documentId,
      logicalDocumentId:rep.logicalDocumentId,sourceHash:rep.sourceHash,
      documentType:rep.documentType,sourceRows:eventInputs.length,
      assignedRows:assignedInReport,declaredCounts:checks.length
    });
  }
  // Same external event number in separate reports is not deduplicated.
  // Disagreeing facts must be reconciled by a Broker.
  const byExternal=new Map();
  for(const e of allEntries){
    const n=numberFor(e.kind,e.facts);
    if(!n)continue;
    const key=`${e.caseDriverId}|${e.kind}|${n}`;
    const prev=byExternal.get(key);
    if(prev&&Object.keys(prev.facts).some(k=>
      Object.hasOwn(e.facts,k) && stable(prev.facts[k])!==stable(e.facts[k])))
      addIssue("CROSS_REPORT_EVENT_CONFLICT",e.source.documentId,
        {caseDriverId:e.caseDriverId,kind:e.kind});
    else if(!prev)byExternal.set(key,e);
  }
  const drivers=[...driverRows.values()].map(d=>({
    caseDriverId:d.id,convictions:d.convictions,claims:d.claims,
    reportedCounts:d.reportedCounts
  })).sort((a,b)=>a.caseDriverId.localeCompare(b.caseDriverId));
  const blockingIssues=[...issueMap.values()].sort((a,b)=>
    stable(a).localeCompare(stable(b)));
  return {
    schemaVersion:"5B-07-v1",drivers,reports:resultReports
      .sort((a,b)=>a.reportId.localeCompare(b.reportId)),
    unassigned,blockingIssues,totals:{
      reports:resultReports.length,convictionObservations:drivers.reduce((n,d)=>n+d.convictions.length,0),
      claimObservations:drivers.reduce((n,d)=>n+d.claims.length,0),
      unassigned:unassigned.length,blockingIssues:blockingIssues.length
    },evaluatedSources:relevant
  };
}

/**
 * Human-readable *codes*, not personal names, licences, event text, amounts or
 * source hashes, for a fail-closed Broker review section integrity gate.
 */
export function driverHistorySectionIssues(review, sectionId) {
  const state=review?.driver_history_integrity;
  if(!state || !Array.isArray(state.blockingIssues)||!state.blockingIssues.length)return [];
  // Cross-section guard: old review catalogues do not expose a dedicated
  // driver-history section, so no section can be confirmed while evidence is
  // unresolved. An explicit UX/mapping resolution workflow is an integration
  // acceptance task; this is deliberately not a silent "looks complete".
  return [`MVR/DASH driver history needs source reconciliation: ${state.blockingIssues.length} blocking issue(s).`];
}

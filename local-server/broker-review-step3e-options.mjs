/**
 * Step 3E — conservative bridge from verified source documents / existing Case
 * into Broker review field options. Never match by array position or "only one
 * driver" for an unidentified parsed entity.
 */
const own = (obj,key) => Object.prototype.hasOwnProperty.call(obj??{},key);
const nonblank=v=>v!==undefined&&v!==null&&v!=="";
const norm=v=>String(v??"").toUpperCase().replace(/[\s-]/g,"");
const address=v=>String(v??"").toUpperCase().replace(/[.,]/g," ").replace(/\s+/g," ").trim();
const enumTruthy=(v)=>typeof v==="boolean"?v:null;
const idFor=v=>String(v?.id||v?.vin||"");
const roleByToken=t=>/\(\s*PRN\s*\)/i.test(t)?"PRINCIPAL":/\(\s*OCC\s*\)/i.test(t)?"OCCASIONAL":null;
const str=v=>typeof v==="string"?v.trim():"";
const fieldPage=(src,key)=>src?.fieldEvidence?.[key]?.find(e=>Number.isSafeInteger(e?.page)&&e.page>0)?.page??null;
const isVerifiedSource=(entry,kind)=>entry.observation?.documentType===kind &&
    Boolean(entry.hash&&entry.record?.id===entry.observation?.documentId);
const uniq=(items,k)=>{
 const counts=new Map();
 for(const item of items){const key=k(item);if(key)counts.set(key,(counts.get(key)||0)+1);}
 return new Map(items.filter(item=>k(item)&&counts.get(k(item))===1).map(item=>[k(item),item]));
};
const normalizeOpcf=v=>str(v).toUpperCase().replace(/^OPCF[\s-]*/,"").replace(/^#/,"").trim();
function coverageFromRows(data) {
 const coverage={};
 const selected=[];
 for(const entry of Array.isArray(data.coverages)?data.coverages:[]){
   if(!entry||typeof entry!=="object")continue;
   const label=str(entry.name).toLowerCase(), raw=str(entry.value).replace(/[$, ]/g,"");
   const amount=/^\d+(?:\.\d+)?$/.test(raw)?Number(raw):null;
   if(/^all perils\b/.test(label)) {
      coverage.allPerils={present:true,...(amount!==null?{deductible:amount}:{})};
   } else if(/^collision\b/.test(label)) {
      coverage.collision={present:true,...(amount!==null?{deductible:amount}:{})};
   } else if(/^comprehensive\b/.test(label)) {
      coverage.comprehensive={present:true,...(amount!==null?{deductible:amount}:{})};
   } else if(/^bodily injury\b/.test(label) && amount!==null)coverage.liability=amount;
   const opcf=label.match(/^#\s*(\d+[a-z]?)(?:\b|$)/i);
   if(opcf) selected.push(opcf[1].toUpperCase());
 }
 if(Number.isFinite(Number(data.liability))&&nonblank(data.liability))
    coverage.liability=Number(data.liability);
 if(Number.isFinite(Number(data.allPerilsDeductible))&&nonblank(data.allPerilsDeductible))
    coverage.allPerils={present:true,deductible:Number(data.allPerilsDeductible)};
 if(selected.length){
   coverage.opcf=[...new Set(selected)];
   coverage.opcf44=coverage.opcf.some(v=>v==="44"||v==="44R");
 }
 return coverage;
}
const filled=rec=>rec&&typeof rec==="object"&&!Array.isArray(rec);
function mergeCoverage(to,from) {
 for (const [k,v] of Object.entries(from)) {
   if(filled(v))to[k]={...(to[k]??{}),...v};
   else to[k]=v;
 }
}
const validDay=s=>typeof s==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&
 Number.isFinite(Date.parse(s+"T00:00:00Z"))&&
 new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;

/** Nonempty summary only when parsed evidence explicitly proves a zero or usable detail. */
function mvrSummary(data) {
 if(Array.isArray(data.convictions)&&data.convictions.length) {
   const convictions=data.convictions.map(v=>({
     offenceDate:v.offenceDate??v.offence_date,
     description:v.description,
     classification:v.classification??v.severity
   }));
   return convictions.every(v=>validDay(v.offenceDate)&&str(v.description)&&str(v.classification)) ?
      {hasConvictions:true,convictions}:null;
 }
 if(data.reportedConvictionCount===0 && Array.isArray(data.convictions) &&
      data.convictions.length===0)return {hasConvictions:false,convictions:[]};
 return null;
}
function dashSummary(data) {
 if(!Array.isArray(data.claims))return null;
 if(data.claims.length) {
   const claims=data.claims.map(v=>({
      claimNumber:v.claimNumber??v.claim_number,
      lossDate:v.lossDate??v.loss_date,
      driver:v.driver??v.driverName,
      vehicle:v.vehicle??v.vehicleVin,
      atFaultPercent:v.atFaultPercent??v.at_fault_percent
   }));
   return claims.every(v=>str(v.claimNumber)&&validDay(v.lossDate)&&str(v.driver)&&
      typeof v.atFaultPercent==="number"&&v.atFaultPercent>=0&&v.atFaultPercent<=100)?
      {hasClaims:true,claims}:null;
 }
 return (data.reportedClaimCount===0||data.claimCount===0) ?
   {hasClaims:false,claims:[]}:null;
}

/**
 * docs.sources are physical-byte-verified observations from
 * verifiedReviewDocuments(), not arbitrarily uploaded JSON.
 * options are CASE_UNVERIFIED defaults; explicit candidate provenance
 * remains the job of buildExplicitReviewCandidates().
 */
export function deriveStep3eOptions(item,docs) {
 const coverageByVehicle={},commuteByVehicle={},driverAssignmentsByVehicle={},
   garagingSameMailByVehicle={},quoteDiscounts=[],reports=[],homeExtras={};
 const cars=item.vehicles??[],drivers=item.drivers??[];
 const byVin=uniq(cars,v=>norm(v.vin)),byLicence=uniq(drivers,d=>norm(d.licence_number));
 const names=uniq(drivers,d=>str(d.name).toUpperCase().replace(/[,.]/g," ").replace(/\s+/g," "));
 for(const v of cars){
   const id=idFor(v);if(!id)continue;
   const mailing=item.policy?.mailing_address;
   if(str(v.garaging_address)&&str(mailing))
     garagingSameMailByVehicle[id]=address(v.garaging_address)===address(mailing);
   const asgn=[];
   for(const d of drivers){
     const ref=String(d.assigned_vehicle??"");
     if(ref && (ref===id || norm(ref)===norm(v.vin)) && d.id){
       if(d.principal===true)asgn.push({driverId:d.id,role:"PRINCIPAL"});
       // false is not proof of Secondary/Occasional/Excluded
     }
   }
   if(asgn.length)driverAssignmentsByVehicle[id]=asgn;
 }
 // Only a single original vehicle may inherit legacy policy-level coverage.
 if(cars.length===1) {
   const v=cars[0],id=idFor(v),global=item.coverage??{},cov={};
   if(nonblank(global.liability))cov.liability=global.liability;
   if(nonblank(global.all_perils_deductible))
      cov.allPerils={present:true,deductible:global.all_perils_deductible};
   if(Array.isArray(global.endorsements)){
      cov.opcf=global.endorsements.map(normalizeOpcf).filter(Boolean);
      cov.opcf44=cov.opcf.some(x=>x==="44"||x==="44R");
   }
   if(id)coverageByVehicle[id]=cov;
 }
 const discountSeen=new Set();
 const addDiscount=(d)=>{
   if(!d||typeof d!=="object")return;
   const name=str(d.name??d.kind),id=str(d.id??d.kind??name);
   if(!name||!id||discountSeen.has(id))return;
   discountSeen.add(id);
   quoteDiscounts.push({id,name,selected:d.selected===true,
     ...(d.evidenceRequired===true?{evidenceRequired:true,
       evidencePresent:d.evidencePresent===true}:{})});
 };
 // This is a list of selected discounts known to the Case, not a fabricated
 // catalogue of all available discounts.
 for(const row of item.intake_discount_review?.selections??[])
   addDiscount({...row,name:row.kind,selected:true,id:\`\${row.kind}:\${row.subject_key}\`});
 const byReportId=new Map();
 for(const context of docs.sources??[]){
   const s=context.observation,data=s?.data;
   if(!filled(data))continue;
   if(["AUTO_QUOTE","AUTO_APPLICATION"].includes(s.documentType)) {
      const match=byVin.get(norm(data.vin));
      if(match && !s.excluded) {
        const id=idFor(match);
        const extracted=coverageFromRows(data);
        if(Object.keys(extracted).length)
          mergeCoverage(coverageByVehicle[id]??(coverageByVehicle[id]={}),extracted);
        if(typeof data.commute==="boolean")commuteByVehicle[id]=data.commute;
        if(Array.isArray(data.declaredOperators)) {
          const assignments=[];
          for(const operator of data.declaredOperators){
            const role=roleByToken(operator);
            const label=str(operator).replace(/\(\s*(?:Prn|Occ)\s*\)/ig,"").toUpperCase()
              .replace(/[,.]/g," ").replace(/\s+/g," ").trim();
            const d=names.get(label);
            if(!d?.id||!role){assignments.length=0;break;}
            assignments.push({driverId:d.id,role});
          }
          if(assignments.length&&new Set(assignments.map(a=>a.driverId)).size===assignments.length)
            driverAssignmentsByVehicle[id]=assignments;
        }
      }
      // Only quote-observed discounts: no unrecognized price/word scanning.
      if(s.documentType==="AUTO_QUOTE"&&Array.isArray(data.quoteDiscounts))
         for(const entry of data.quoteDiscounts)addDiscount(entry);
    }
    if(s.documentType==="HAB_QUOTE"||s.documentType==="HAB_APPLICATION"){
      for(const key of ["roofYear","plumbingYear","electricalYear","electricalPanel","heatingYear"]){
        if(nonblank(data[key]) && fieldPage(s,key)!==null)homeExtras[key]=data[key];
      }
      if(s.documentType==="HAB_QUOTE"&&Array.isArray(data.quoteDiscounts))
        for(const entry of data.quoteDiscounts)addDiscount(entry);
    }
    if(["MVR","DASH"].includes(s.documentType)){
       const type=s.documentType.toLowerCase();
       const id=s.logicalDocumentId?\`\${context.record.id}::\${s.logicalDocumentId}\`:context.record.id;
       if(byReportId.has(\`\${type}:\${id}\`))continue;
       const pulled=data.pulledDate??data.requestDate??data.reportDate??null;
       const pulledKey=own(data,"pulledDate")?"pulledDate":
         own(data,"requestDate")?"requestDate":own(data,"reportDate")?"reportDate":null;
       const unresolved=Array.isArray(s.warnings)&&s.warnings.some(w=>
         ["medium","high"].includes(w?.severity));
       const summary=unresolved?null:(type==="mvr"?mvrSummary(data):dashSummary(data));
       // A report with unresolved parser warnings must not become clean history.
       // Parsed records without dated evidence are not treated as fresh.
       byReportId.set(\`\${type}:\${id}\`,{
         type,id,pulledDate:validDay(pulled)&&pulledKey&&fieldPage(s,pulledKey)!==null?pulled:null,
         summary
       });
    }
  }
  // Every VERIFIED physical report is represented, including unparsable ones.
  for(const record of docs.records??[]){
    if(!docs.verified?.some(v=>v.id===record.id))continue;
    for(const section of record.logicalDocuments??[{documentType:record.documentType,presenceStatus:"FOUND"}]){
      if(section.presenceStatus!=="FOUND")continue;
      const type=section.documentType==="MVR"?"mvr":section.documentType==="DASH"?"dash":null;
      if(!type)continue;
      const id=section.id?\`\${record.id}::\${section.id}\`:record.id;
      const key=\`\${type}:\${id}\`;
      if(!byReportId.has(key))byReportId.set(key,{type,id,pulledDate:null,summary:null});
    }
  }
  reports.push(...byReportId.values());
  return {
    coverageByVehicle,commuteByVehicle,driverAssignmentsByVehicle,
    garagingSameMailByVehicle,quoteDiscounts,reports,
    reportCategoriesPresent:[...new Set(reports.map(r=>r.type))],homeExtras
  };
}

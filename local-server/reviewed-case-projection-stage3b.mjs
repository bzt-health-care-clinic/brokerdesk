/**
 * BrokerDesk Step 3B — projection of explicitly Broker-reviewed fields into an
 * OUTBOUND COPY of case.json. The source Case and evidence are never mutated.
 *
 * Deliberately narrow:
 *  - Only whitelisted scalar values and stable-ID entities are projected.
 *  - No fuzzy name, VIN, driver or claim reassignment.
 *  - Underwriting/authorization decisions are not synthesized.
 *  - Caller must re-run authoritativeIntake(projected, originalRecords), then
 *    prepareReviewedExport(review, projected, ...), before producing any ZIP.
 *  - Step 3A's source fingerprint, section confirmation and hash checks remain
 *    mandatory. This module does NOT replace those checks.
 */
import {projectStep3eCompatibility} from "./broker-review-step3e-compat.mjs";
const clone = x => JSON.parse(JSON.stringify(x));
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const compactId = x => String(x??"").trim().toUpperCase().replace(/[\s-]/g,"");
const normalText = x => String(x??"").trim().replace(/\s+/g," ").toUpperCase();
const requiredString = (value,field,max=500) => {
  if (typeof value !== "string" || !value.trim() || value.length>max)
    throw new Error(`${field}: expected non-empty text of at most ${max} characters.`);
  return value.trim();
};
const optionalText=(value,field,max=500) => {
  if (value===null || value===undefined) return null;
  if (typeof value!=="string" || value.length>max)
    throw new Error(`${field}: expected text or null (max ${max} characters).`);
  return value.trim() || null;
};
const finite=(value,field,{integer=false,lower=0,upper=1e12}={}) => {
  if (typeof value!=="number" || !Number.isFinite(value) ||
      (integer && !Number.isInteger(value)) || value<lower || value>upper)
    throw new Error(`${field}: invalid numeric value.`);
  return value;
};
const optionalFinite=(value,field,options={}) =>
  value===null||value===undefined?null:finite(value,field,options);
const optionalBoolean=(value,field)=>{
  if(value===null || value===undefined)return null;
  if(typeof value!=="boolean")throw new Error(`${field}: expected Yes/No.`);
  return value;
};
const isoDate=(value,field)=>{
  if(value===null || value===undefined)return null;
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`${field}: expected ISO date.`);
  const [y,m,d]=value.split("-").map(Number);
  const t=Date.UTC(y,m-1,d);
  if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==value)
    throw new Error(`${field}: invalid date.`);
  return value;
};
const anyJson=(value,field) => {
  const encoded=JSON.stringify(value);
  if (encoded===undefined || encoded.length>15000)throw new Error(`${field}: invalid or oversized value.`);
  return clone(value);
};

const DRIVER_PATHS = {
  name: ["name", requiredString],
  dob: ["dob", isoDate],
  licenceNumber: ["licence_number", requiredString],
  licenceClass: ["licence_class", optionalText],
  licenceProvince: ["licence_province", optionalText],
  relationship: ["relationship", optionalText],
  maritalStatus: ["marital_status", optionalText],
  g1Date: ["g1_date", isoDate],
  g2Date: ["g2_date", isoDate],
  gDate: ["g_date", isoDate],
  licenceStatus: ["licence_status", optionalText]
};
const VEHICLE_PATHS = {
  year: ["year", (v,k)=>finite(v,k,{integer:true,lower:1886,upper:2200})],
  make: ["make", requiredString],
  model: ["model", requiredString],
  vin: ["vin", v => {
    const s=requiredString(v,"VIN",30).replace(/[\s-]/g,"").toUpperCase();
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(s))throw new Error("VIN must be 17 valid characters.");
    return s;
  }],
  use: ["primary_use", requiredString],
  annualKm: ["annual_km", (v,k)=>finite(v,k,{lower:0,upper:1000000})],
  commuteOneWayKm: ["commute_km", (v,k)=>v===null?null:finite(v,k,{lower:0,upper:10000})],
  winterTires: ["winter_tires", optionalBoolean],
  garagingAddress: ["garaging_address", optionalText]
};
const HOME_PATHS={
  riskAddress:["risk_address",requiredString],
  occupancy:["occupancy",optionalText],
  yearBuilt:["year_built",(v,k)=>finite(v,k,{integer:true,lower:1600,upper:2200})],
  structure:["structure",optionalText],
  construction:["construction",optionalText],
  units:["units",(v,k)=>optionalFinite(v,k,{integer:true,lower:0,upper:10000})],
  families:["families",(v,k)=>optionalFinite(v,k,{integer:true,lower:0,upper:10000})],
  livingArea:["living_area",(v,k)=>finite(v,k,{lower:0})],
  roof:["roof",optionalText],
  plumbing:["plumbing",optionalText],
  electrical:["electrical",optionalText],
  heating:["heating",optionalText]
};
const POLICY_PATHS={
  "policy.insured":["insured","name",requiredString],
  "policy.number":["policy","policy_number",optionalText],
  "policy.effectiveDate":["policy","effective_date",isoDate],
  "policy.mailingAddress":["policy","mailing_address",optionalText],
  "policy.riskAddress":["policy","risk_address",optionalText]
};

/**
 * @returns {{item:object,changes:Array<{fieldId:string,from:unknown,to:unknown}>,issues:string[]}}
 */
export function projectBrokerReviewedCase(item,review){
  const issues=[],changes=[], projected=clone(item??{});
  if (!item?.case_id || !review || review.source_case_id!==item.case_id)
    return {item:projected,changes,issues:["Broker Review does not belong to this Case."]};
  if(review.case_type!==item.case_type ||
      normalText(review.company)!==normalText(item.policy?.company))
    return {item:projected,changes,issues:["Review Case type or insurer differs from the source Case."]};
  if(!["DRAFT","BROKER_CONFIRMED"].includes(review.review_status) ||
      !Array.isArray(review.sections) || !review.sections.length ||
      review.sections.some(s=>s.status!=="CONFIRMED"||!s.confirmation))
    return {item:projected,changes,issues:["All Broker Review sections must be confirmed before projection."]};
  const fields=new Map();
  for (const field of review.fields??[]){
    if(typeof field?.id!=="string"||fields.has(field.id))
      issues.push("Reviewed field IDs are invalid or duplicated.");
    else fields.set(field.id,field.value);
  }
  const apply=(obj,key,fieldId,convert)=>{
    if(!fields.has(fieldId))return;
    let value;
    try {value=convert(fields.get(fieldId),fieldId);}
    catch(e){issues.push(String(e.message));return;}
    if(!same(obj[key],value)){
      changes.push({fieldId,from:clone(obj[key]??null),to:clone(value)});
      obj[key]=value;
    }
  };
  for(const [fieldId,[parent,key,convert]] of Object.entries(POLICY_PATHS)){
    const dest=projected[parent]??(projected[parent]={});
    apply(dest,key,fieldId,convert);
  }
  // Step 5B-01: the reviewed Quote # must agree with the outbound Case.
  // Only project a real reviewed value; optional Policy Change blanks stay blank.
  if(fields.get("policy.quoteNumber") !== null &&
     fields.get("policy.quoteNumber") !== undefined) {
    const policy=projected.policy??(projected.policy={});
    apply(policy,"quote_number","policy.quoteNumber",requiredString);
    if(Object.prototype.hasOwnProperty.call(policy,"auto_quote_number"))
      apply(policy,"auto_quote_number","policy.quoteNumber",requiredString);
  }
  // Never silently switch insurers: doing so changes required document rules.
  if(fields.has("policy.insurer") &&
     normalText(fields.get("policy.insurer"))!==normalText(item.policy?.company))
    issues.push("Insurer changes must be made in the source Case before confirming.");
  // Map only to stable, unambiguous original entities.
  for(const [name,prefix,collection,identityField,paths] of [
    ["driver","driver:",projected.drivers??[],"licence_number",DRIVER_PATHS],
    ["vehicle","vehicle:",projected.vehicles??[],"vin",VEHICLE_PATHS]
  ]){
    const byIdentity=new Map();
    for(const entry of collection){
      const key=String(entry.id||entry[identityField]||"");
      if(!key || byIdentity.has(key)) issues.push(`Ambiguous or missing ${name} source identity: ${key||"(empty)"}.`);
      else byIdentity.set(key,entry);
    }
    const seenPrefix=new Set();
    for(const [key,entry] of byIdentity){
      const fp=`${prefix}${key}.`;
      seenPrefix.add(fp);
      for(const [suffix,[property,convert]] of Object.entries(paths)){
        const fieldId=fp+suffix;
        if(!fields.has(fieldId)) continue;
        if(!entry.id && (suffix==="vin"||suffix==="licenceNumber") &&
           compactId(fields.get(fieldId))!==compactId(entry[identityField]))
          issues.push(`${fieldId}: cannot replace an identity used as the entity key; assign a stable entity ID in the Case first.`);
        else apply(entry,property,fieldId,convert);
      }
    }
    for(const f of fields.keys()){
      if(f.startsWith(prefix) && ![...seenPrefix].some(p=>f.startsWith(p)))
        issues.push(`${f}: no unique original ${name} identity. Rebuild the review.`);
    }
  }
  // Homes have a single explicitly addressed property in the current MVP.
  for(const [suffix,[prop,convert]] of Object.entries(HOME_PATHS)){
    const id=`home.${suffix}`;
    if(fields.has(id)){
      const h=projected.habitational_risk??(projected.habitational_risk={});
      apply(h,prop,id,convert);
    }
  }
  if(fields.has("remarks.text")||fields.has("change.effectiveDate") ||
     [...fields.keys()].some(k=>k.startsWith("change:"))){
    const change=projected.policy_change??(projected.policy_change={});
    apply(change,"notes","remarks.text",(v,k)=>requiredString(v,k,5000));
    apply(change,"change_effective_date","change.effectiveDate",isoDate);
    const entries=change.requested_changes??[];
    const byId=new Map();
    for(const [idx,entry] of entries.entries()){
      const id=entry.id || `item-${idx+1}`;
      if(byId.has(id))issues.push(`Duplicate change item ID: ${id}.`);
      else byId.set(id,{entry,stable:!!entry.id});
    }
    for(const [id,{entry,stable}] of byId){
      const prefix=`change:${id}.`;
      for(const [suffix,fieldKey,convert] of [
        ["before","previous_value",anyJson],
        ["after","new_value",anyJson],
        ["date","effective_date",isoDate]
      ]){
        const fieldId=prefix+suffix;
        if(!fields.has(fieldId))continue;
        if(!stable && !same(fields.get(fieldId),entry[fieldKey]))
          issues.push(`${fieldId}: changes without stable IDs cannot be projected safely.`);
        else apply(entry,fieldKey,fieldId,convert);
      }
      const reviewedType=fields.get(prefix+"type");
      if(reviewedType!==undefined && reviewedType!==entry.type)
        issues.push(prefix+"type: change type must be updated in the Case and re-reviewed.");
      const reviewedSubject=fields.get(prefix+"subject");
      if(reviewedSubject!==undefined &&
         reviewedSubject!==(entry.subject_name||entry.subject_id))
        issues.push(prefix+"subject: affected entity must be reassigned in the source Case.");
    }
    for(const id of fields.keys()){
      if(!id.startsWith("change:"))continue;
      if(![...byId.keys()].some(key=>id.startsWith(`change:${key}.`)))
        issues.push(`${id}: change item is missing from the original Case.`);
    }
  }
  // A projection must never create two active entities with the same canonical ID.
  for(const [kind,items,key] of [
    ["Vehicle",projected.vehicles??[],"vin"],
    ["Driver",projected.drivers??[],"licence_number"]
  ]){
    const used=new Set();
    for(const entry of items){
      const id=compactId(entry[key]);
      if(!id)continue;
      if(used.has(id))issues.push(`${kind} identity becomes duplicated after Broker correction.`);
      used.add(id);
    }
  }
  issues.push(...projectStep3eCompatibility(projected,review,changes));
  return {item:projected,changes,issues:[...new Set(issues)]};
}

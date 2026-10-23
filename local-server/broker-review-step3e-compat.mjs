/**
 * Step 3E compatibility rules for fields that have a SAFE representation
 * in legacy InsuranceCase. Other reviewed fields remain authoritative in the
 * hashed reviewed-keyin.json; no duplicate/stale pseudo-Case values are made.
 */
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const finite=v=>typeof v==="number"&&Number.isFinite(v);
const eqValue=(fields,id)=>fields.get(id);
const standardVehicle=(item,fields)=>{
  const vehicles=item.vehicles??[];
  if(!vehicles.length)return null;
  const values=vehicles.map(v=>{
    const prefix=`vehicle:${v.id||v.vin}.`;
    return {liability:fields.get(prefix+"liability"),
      allPerilsDeductible:fields.get(prefix+"allPerils.deductible"),
      opcf:fields.get(prefix+"opcf")};
  });
  const first=values[0];
  // Global Case coverage is only safe when all active vehicles agree.
  return values.every(other=>same(other,first))?first:null;
};
/**
 * Apply only unambiguous, typed fields to the outbound Case copy.
 * For multi-car different Coverage the legacy global model is insufficient:
 * the per-car values stay solely in Broker's immutable reviewed-keyin.json.
 */
export function projectStep3eCompatibility(item,review,changes=[]) {
 const issues=[],fields=new Map();
 for(const field of review.fields??[]) {
   if(typeof field?.id!=="string"||fields.has(field.id)) {
     issues.push("Duplicate or invalid reviewed field ID.");continue;
   }
   fields.set(field.id,field.value);
 }
 const shared=standardVehicle(item,fields);
 if(!shared || (
   shared.liability===undefined && shared.allPerilsDeductible===undefined &&
   !Array.isArray(shared.opcf)))return issues;
 const coverage=item.coverage??(item.coverage={});
 for(const [field,property] of [["liability","liability"],
     ["allPerilsDeductible","all_perils_deductible"]]) {
   const value=shared[field];
   if(value===undefined||value===null)continue;
   if(!finite(value)||value<0||(field==="liability"&&value===0)){
      issues.push(`Reviewed ${field} must be a valid coverage amount.`);continue;
   }
   if(!same(coverage[property],value)){
     changes.push({fieldId:`coverage.${property}`,from:coverage[property]??null,to:value});
     coverage[property]=value;
   }
 }
 if(Array.isArray(shared.opcf)) {
   const codes=shared.opcf.map(v=>typeof v==="string"?v.trim():"");
   if(codes.some(x=>!x)||new Set(codes).size!==codes.length){
     issues.push("Reviewed OPCF list is invalid or duplicated.");
   } else if(!same(coverage.endorsements,codes)) {
     changes.push({fieldId:"coverage.endorsements",from:coverage.endorsements??[],to:codes});
     coverage.endorsements=codes;
   }
 }
 return issues;
}
export function step3eConsistencyIssues(snapshot,item) {
 const issues=[],fields=new Map();
 for(const f of snapshot?.fields??[]) {
   if(typeof f?.id!=="string"||fields.has(f.id)){
     issues.push("Duplicate or invalid Broker field IDs.");continue;
   }
   fields.set(f.id,f.value);
 }
 const shared=standardVehicle(item,fields);
 if(shared) {
   const c=item.coverage??{};
   if(finite(shared.liability) && c.liability!==shared.liability)
     issues.push("Reviewed Liability differs from Case.");
   if(finite(shared.allPerilsDeductible) &&
       c.all_perils_deductible!==shared.allPerilsDeductible)
     issues.push("Reviewed All Perils deductible differs from Case.");
   if(Array.isArray(shared.opcf) && !same(c.endorsements,shared.opcf))
     issues.push("Reviewed OPCF differs from Case.");
 }
 // Only compare existing structured discount selections. We do not invent
 // unseen quote discounts or overwrite server-verified support evidence.
 for(const d of item.intake_discount_review?.selections??[]) {
   const id=`quoteDiscount:${d.kind}:${d.subject_key}.selected`;
   if(fields.has(id)&&fields.get(id)!==true)
     issues.push(`${id}: Case's selected discount is contradicted by Review.`);
 }
 return issues;
}

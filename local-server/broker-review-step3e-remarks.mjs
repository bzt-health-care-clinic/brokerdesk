/**
 * Build generator input from the Broker-edited field values, not stale Case
 * values. Never choose a car/driver just because a Case has only one.
 */
const nonempty=x=>x!==null&&x!==undefined&&x!=="";
const obj=x=>x!==null&&typeof x==="object"&&!Array.isArray(x);
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
const norm=x=>String(x??"").toUpperCase().replace(/[\s-]/g,"");
const isVin=x=>/^[A-HJ-NPR-Z0-9]{17}$/.test(norm(x));
const findValue=(fields,id)=>fields.has(id)?fields.get(id):undefined;
function reviewVehicle(fields,caseData,ref,detail){
 const cars=caseData.vehicles??[];
 const match=cars.filter(v=>ref
   ? (v.id===ref || norm(v.vin)===norm(ref))
   : (detail?.vin && isVin(detail.vin)&&norm(v.vin)===norm(detail.vin)));
 if(match.length!==1 ||
     (detail?.vin && isVin(detail.vin)&&norm(match[0].vin)!==norm(detail.vin)))
   return null;
 const vehicle=match[0],id=String(vehicle.id||vehicle.vin||"");
 if(!id)return null;
 const get=k=>findValue(fields,`vehicle:${id}.${k}`);
 const selected=(key,fallback)=>get(key)===undefined?fallback:get(key);
 const original=obj(detail)?detail:{};
 const coverage={
   liability:get("liability"),
   allPerils:{present:get("allPerils.present"),deductible:get("allPerils.deductible")},
   collision:{present:get("collision.present"),deductible:get("collision.deductible")},
   comprehensive:{present:get("comprehensive.present"),deductible:get("comprehensive.deductible")},
   opcf:get("opcf")
 };
 return {
   year:selected("year",original.year??vehicle.year),
   make:selected("make",original.make??vehicle.make),
   model:selected("model",original.model??vehicle.model),
   vin:selected("vin",original.vin??vehicle.vin),
   condition:selected("condition",original.condition??vehicle.purchase_condition),
   use:selected("use",original.use??vehicle.primary_use),
   commute:get("commute"),
   commuteOneWayKm:get("commuteOneWayKm"),
   annualKm:selected("annualKm",original.annualKm??vehicle.annual_km),
   winterTires:selected("winterTires",original.winterTires??vehicle.winter_tires),
   winterTireReceiptToFollow:original.winterTireReceiptToFollow===true,
   lienholder:nonempty(selected("lienholder",original.lienholder?.name??vehicle.lienholder?.name))?
      {name:selected("lienholder",original.lienholder?.name??vehicle.lienholder?.name)}:null,
   lessor:nonempty(selected("lessor",original.lessor?.name??vehicle.lessor?.name))?
      {name:selected("lessor",original.lessor?.name??vehicle.lessor?.name)}:null,
   coverage
 };
}
function detachedVehicle(value){
 const v=obj(value)?(obj(value.vehicle)?value.vehicle:value):null;
 if(!v)return null;
 return {
   year:v.year,make:v.make,model:v.model,vin:v.vin,reason:v.reason
 };
}
function reviewDriver(fields,caseData,ref,detail) {
 const drivers=caseData.drivers??[];
 const found=drivers.filter(d=>(ref&&d.id===ref)||
   (detail?.licenceNumber&&norm(d.licence_number)===norm(detail.licenceNumber)));
 if(found.length!==1)return null;
 const d=found[0],id=String(d.id||d.licence_number||"");
 const get=k=>findValue(fields,`driver:${id}.${k}`);
 return {
   name:get("name")??d.name,
   licenceNumber:get("licenceNumber")??d.licence_number,
   relationship:get("relationship")??d.relationship,
   convictions:Array.isArray(detail?.convictions)?clone(detail.convictions):undefined,
   claims:Array.isArray(detail?.claims)?clone(detail.claims):undefined
 };
}
/**
 * Existing deriveRemarksRequest() provides simple fallback inputs.
 * We only enrich if there is an explicit, unambiguous requested_change entry.
 */
export function enrichStep3eRemarks(review,caseData,request){
 const fields=new Map((review.fields??[]).map(f=>[f.id,f.value]));
 const changes=caseData.policy_change?.requested_changes??[];
 const types=Array.isArray(caseData.policy_change?.transaction_types)?
  caseData.policy_change.transaction_types:[];
 // Multiple unrelated actions need an editable manual Remarks, not arbitrary
 // selection of whichever type happens to be first.
 if(new Set(types).size>1 && !(
     types.length===2 && types.includes("ADD_VEHICLE")&&types.includes("DELETE_VEHICLE")))
   return {...request,type:"OTHER_POLICY_CHANGE"};
 if(types.includes("ADD_VEHICLE")&&types.includes("DELETE_VEHICLE")&&
    new Set(types).size===2)request.type="VEHICLE_SUBSTITUTION";
 const type=request.type;
 const byType=changes.filter(c=>c.type===type||
   (type==="VEHICLE_SUBSTITUTION"&&["ADD_VEHICLE","DELETE_VEHICLE"].includes(c.type)));
 const changeAfter=c=>{
   const id=c.id;
   const value=id?fields.get(`change:${id}.after`):undefined;
   return value===undefined?c.new_value:value;
 };
 const changeBefore=c=>{
   const id=c.id;
   const value=id?fields.get(`change:${id}.before`):undefined;
   return value===undefined?c.previous_value:value;
 };
 if(["ADD_VEHICLE","VEHICLE_SUBSTITUTION"].includes(type)){
   const add=byType.find(c=>c.type==="ADD_VEHICLE")??byType[0];
   const detail=add && changeAfter(add);
   const payload=obj(detail) ? (detail.addedVehicle??detail.vehicle??detail):null;
   const ref=add?.subject_id??payload?.id??payload?.vin;
   const added=reviewVehicle(fields,caseData,ref,payload);
   if(added)request.addedVehicle=added;
   // Never fetch a removed vehicle out of the new-car list by position.
   if(type==="VEHICLE_SUBSTITUTION"){
     const remove=byType.find(c=>c.type==="DELETE_VEHICLE")??byType[0];
     const before=remove&&changeBefore(remove);
     request.removedVehicle=detachedVehicle(before?.removedVehicle??before)??null;
   }
 } else if(type==="DELETE_VEHICLE"){
   const removal=byType[0];
   const before=removal&&changeBefore(removal);
   request.removedVehicle=detachedVehicle(before?.removedVehicle??before)??null;
 } else if(type==="ADD_DRIVER"){
   const c=byType[0],detail=c&&changeAfter(c);
   const payload=obj(detail)?(detail.driver??detail):null;
   const d=reviewDriver(fields,caseData,c?.subject_id??payload?.id,payload);
   if(d)request.driver=d;
 }
 return request;
}

/**
 * Step 5B-06 — prevent silent Active Vehicle value overwrites.
 *
 * Applied source entities remain independent evidence observations. This
 * module only identifies conflicts; it never invents vehicles, assigns a
 * driver based on array order, or turns missing Coverage into "No".
 */
const text=v=>typeof v==="string"?v.trim():"";
const vin=v=>text(v).replace(/[\s-]/g,"").toUpperCase();
const validVin=v=>/^[A-HJ-NPR-Z0-9]{17}$/i.test(v);
const amount=v=>{
  if(typeof v==="number")return Number.isFinite(v)?v:null;
  const s=text(v).replace(/[$,\s]/g,"");
  return /^\d+(?:\.\d+)?$/.test(s)?Number(s):null;
};
const stable=v=>JSON.stringify(v,(key,val)=>{
  if(val&&typeof val==="object"&&!Array.isArray(val))
    return Object.fromEntries(Object.keys(val).sort().map(k=>[k,val[k]]));
  return val;
});
function coverageFacts(data) {
  const facts={};
  const contradictions=new Set();
  const add=(key,val)=>{
    if(val===null||val===undefined||val==="")return;
    if(Object.hasOwn(facts,key)&&stable(facts[key])!==stable(val))
      contradictions.add(key);
    facts[key]=val;
  };
  add("liability",amount(data.liability));
  add("allPerils.deductible",amount(data.allPerilsDeductible));
  add("collision.deductible",amount(data.collisionDeductible));
  add("comprehensive.deductible",amount(data.comprehensiveDeductible));
  add("dcpdDeductible",amount(data.dcpdDeductible));
  add("annualKm",amount(data.annualKm));
  add("use",text(data.vehicleUse).toUpperCase()||null);
  const opcfs=[];
  for(const row of Array.isArray(data.coverages)?data.coverages:[]){
    if(!row||typeof row!=="object")continue;
    const name=text(row.name),label=name.toLowerCase(),value=amount(row.value);
    const which=/^all perils\b/.test(label)?"allPerils":
      /^collision\b/.test(label)?"collision":
      /^comprehensive\b/.test(label)?"comprehensive":null;
    if(which){
      add(`${which}.present`,true);
      if(value!==null)add(`${which}.deductible`,value);
    }
    if(/^bodily injury\b/i.test(label)&&value!==null)add("liability",value);
    const end=name.match(/^#\s*(\d+[A-Z]?)(?:\b|$)/i);
    if(end)opcfs.push(end[1].toUpperCase());
  }
  // Missing OPCF rows do not mean "no endorsements".
  if(opcfs.length) {
    add("opcf",[...new Set(opcfs)].sort());
    add("opcf44",opcfs.includes("44")||opcfs.includes("44R"));
  }
  if(Array.isArray(data.declaredOperators)&&data.declaredOperators.length) {
    const parsed=data.declaredOperators.map(op=>{
      const raw=text(op);
      const match=raw.match(/\((Prn|Occ)\)/i);
      if(!match)return null;
      return `${raw.replace(/\((?:Prn|Occ)\)/ig,"").replace(/[\s,.]+/g," ").trim().toUpperCase()}::${match[1].toUpperCase()}`;
    });
    if(parsed.every(Boolean))add("driverAssignments",parsed.sort());
  }
  for(const key of contradictions)facts[`__sourceConflict__${key}`]=true;
  return facts;
}
/** @returns {{conflictingFieldIds:string[], conflicts:object[], observedActive:number, ignoredExcluded:number}} */
export function analyzeVehicleSourceConflicts(caseData,verifiedSources=[]) {
  const cars=Array.isArray(caseData?.vehicles)?caseData.vehicles:[];
  const byVin=new Map(),duplicates=new Set();
  for(const car of cars) {
    const id=String(car.id||car.vin||"");
    const key=vin(car.vin);
    if(!id||!validVin(key))continue;
    if(byVin.has(key))duplicates.add(key);
    else byVin.set(key,id);
  }
  const bySource=new Set(),seenValues=new Map();
  const conflicts=new Map();
  let observedActive=0,ignoredExcluded=0;
  const mark=(id,field,reason)=>{
    const key=`vehicle:${id}.${field}`;
    if(!conflicts.has(key))conflicts.set(key,{
      fieldId:key, reason
    });
  };
  for(const key of duplicates) {
    for(const car of cars.filter(v=>vin(v.vin)===key))
      mark(String(car.id||car.vin),"vin","Duplicate VIN in active Case vehicles.");
  }
  for(const source of verifiedSources??[]) {
    const s=source?.observation??{},data=s.data??{};
    if (s.documentType!=="AUTO_QUOTE"&&s.documentType!=="AUTO_APPLICATION")continue;
    if (s.entityKind!=="VEHICLE"&&s.subjectType!=="VEHICLE")continue;
    if (s.excluded===true||data.excluded===true){ignoredExcluded++;continue;}
    const key=vin(data.vin);
    if(!validVin(key)||duplicates.has(key)||!byVin.has(key))continue;
    const identity=[source.record?.id||"",s.logicalDocumentId||"",
      s.subjectId||"",source.hash||"",stable(data)].join("|");
    if(bySource.has(identity))continue;
    bySource.add(identity);
    observedActive++;
    const id=byVin.get(key);
    const facts=coverageFacts(data);
    for(const [field,value] of Object.entries(facts)){
      if(field.startsWith("__sourceConflict__")){
        mark(id,field.slice("__sourceConflict__".length),
          "Contradictory values in the same active source record.");
        continue;
      }
      const fieldId=`vehicle:${id}.${field}`;
      if(!seenValues.has(fieldId)){seenValues.set(fieldId,stable(value));continue;}
      if(seenValues.get(fieldId)!==stable(value))
        mark(id,field,`Conflicting active source values for ${field}.`);
    }
  }
  return {conflictingFieldIds:[...conflicts.keys()].sort(),
    conflicts:[...conflicts.values()].sort((a,b)=>a.fieldId.localeCompare(b.fieldId)),
    observedActive,ignoredExcluded};
}

/**
 * For simulation/acceptance reports: never treat a source observation as a
 * rated Case vehicle. Explicitly excluded observations remain audit evidence.
 */
export function classifySourceVehicleObservations(parsedSources=[]) {
  const active=[],excluded=[];
  for(const source of parsedSources){
    for(const entity of source?.entities??[]){
      if(entity?.kind!=="VEHICLE")continue;
      const obs={documentId:source.documentId??null,
        logicalDocumentId:source.logicalDocumentId??null,entityId:entity.id,
        excluded:entity.excluded===true, data:entity.data??{}};
      (obs.excluded?excluded:active).push(obs);
    }
  }
  return {active,excluded};
}

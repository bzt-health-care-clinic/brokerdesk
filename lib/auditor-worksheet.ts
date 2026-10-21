import type { InsuranceCase } from "./insurance-types.ts";
import { sameNamedPersons } from "./intake-person-evidence.ts";
import type { UploadedDocumentRecord, ParsedSource } from "./extraction-types.ts";
import { activeParsedSources } from "./active-evidence.ts";
import { normalizePolicyChangeTransactions } from "./policy-change.ts";

export type WorksheetStatus="extracted"|"case-only"|"missing"|"conflict"|"confirmed";
export interface WorksheetEvidence {
  documentId:string;logicalDocumentId?:string;fileName:string;documentType:string;
  page?:number;confidence?:number;sourceValue:string;field:string;
}
export interface WorksheetRow {
  id:string;label:string;value:string;status:WorksheetStatus;
  evidence:WorksheetEvidence[];required:boolean;note?:string;
}
export interface WorksheetSection { id:string;title:string;rows:WorksheetRow[] }
export interface AuditorWorksheet {
  kind:"new-auto"|"new-home"|"auto-change"|"home-change";
  sections:WorksheetSection[];missing:number;conflicts:number;extracted:number;
  documentCount:number;unparsedDocuments:string[];
}
const available=(v:unknown):boolean=>v!==null&&v!==undefined&&
  (typeof v!=="string"||Boolean(v.trim()))&&(!Array.isArray(v)||v.length>0);
const stringify=(v:unknown):string=>{
  if(v===null||v===undefined)return "";
  if(typeof v==="boolean")return v?"Yes":"No";
  if(typeof v==="string")return v.trim();
  if(typeof v==="number")return Number.isFinite(v)?String(v):"";
  if(Array.isArray(v))return v.map(stringify).filter(Boolean).join("; ");
  if(typeof v==="object")return JSON.stringify(v);
  return String(v);
};
const compare=(v:string)=>v.trim().replace(/\s+/g," ").toUpperCase();
const display=(v:unknown)=>available(v)?stringify(v):"NOT FOUND / CONFIRM";
type Pair={record:UploadedDocumentRecord;source:ParsedSource};
type FieldBuilder=(id:string,label:string,value:unknown,keys?:string[],opts?:{
 required?:boolean;subjectType?:"DRIVER"|"VEHICLE"|"PROPERTY";subjectId?:string;
 note?:string;})=>void;
/** Use only current file hashes/active logical sections. Never present withdrawn OCR as live evidence. */
export function buildAuditorWorksheet(item:InsuranceCase,records:UploadedDocumentRecord[]):AuditorWorksheet {
  const active:Pair[]=records.flatMap(record=>activeParsedSources(record).map(source=>({record,source})));
  const isChange=item.case_type==="auto_policy_change"||item.case_type==="home_policy_change";
  const auto=item.case_type==="new_auto"||item.case_type==="auto_policy_change";
  const sections:WorksheetSection[]=[];
  const seenSources=new Set<string>();
  function sourceMatchesSubject(source:ParsedSource,subjectType?:string,subjectId?:string):boolean{
    if(!subjectType||!subjectId)return true;
    if(source.subjectType && source.subjectType!==subjectType)return false;
    if(source.subjectId)return source.subjectId===subjectId;
    // Unassigned multi-vehicle and multi-driver reports must never be repeated
    // under each person/car. Match unique identifiers or leave unassigned.
    if(subjectType==="VEHICLE"){
      const target=item.vehicles.find(v=>v.id===subjectId);
      if(!target)return false;
      const vin=String(source.data?.vin??"").toUpperCase().replace(/[\s-]/g,"");
      const targetVin=String(target.vin??"").toUpperCase().replace(/[\s-]/g,"");
      if(vin)return Boolean(targetVin&&vin===targetVin);
      return item.vehicles.length===1;
    }
    if(subjectType==="DRIVER"){
      const target=item.drivers.find(d=>d.id===subjectId);
      if(!target)return false;
      const licence=String(source.data?.licenceNumber??"").toUpperCase().replace(/[\s-]/g,"");
      const targetLicence=String(target.licence_number??"").toUpperCase().replace(/[\s-]/g,"");
      if(licence)return Boolean(targetLicence&&licence===targetLicence);
      const named=String(source.data?.driverName??"");
      if(named)return sameNamedPersons([named],[target.name]);
      return item.drivers.length===1;
    }
    return true;
  }
  function fieldEvidence(keys:string[],subjectType?:string,subjectId?:string):WorksheetEvidence[]{
    const wanted=new Set(keys);
    const data:WorksheetEvidence[]=[];
    const emit=(entry:WorksheetEvidence)=>{
      const key=[entry.documentId,entry.logicalDocumentId,entry.field,entry.sourceValue].join("|");
      if(!seenSources.has(key)){seenSources.add(key);data.push(entry);}
    };
    // Reuse broker or auditor source resolutions when the original source section remains active.
    for(const candidate of (item.field_sources??[])){
      if(!wanted.has(candidate.canonicalField??candidate.field))continue;
      if(subjectType&&candidate.subjectType&&candidate.subjectType!==subjectType)continue;
      if(subjectId&&candidate.subjectId&&candidate.subjectId!==subjectId)continue;
      for(const value of candidate.values??[]){
        const match=active.find(x=>x.record.id===value.documentId &&
          (!value.logicalDocumentId||x.source.logicalDocumentId===value.logicalDocumentId));
        if(!match)continue;
        if(!sourceMatchesSubject(match.source,subjectType,subjectId))continue;
        const original=value.correctedValue??value.value;
        if(!available(original))continue;
        emit({documentId:match.record.id,logicalDocumentId:match.source.logicalDocumentId,
          fileName:match.record.fileName,documentType:match.source.documentType,
          page:value.evidence?.[0]?.page,confidence:value.confidence,
          sourceValue:stringify(original),field:candidate.canonicalField??candidate.field});
      }
    }
    for(const {record,source} of active){
      if(!sourceMatchesSubject(source,subjectType,subjectId))continue;
      for(const key of keys){
        const corrected=source.corrections?.[key]?.correctedValue;
        const raw=corrected??source.data?.[key];
        if(!available(raw))continue;
        emit({documentId:record.id,logicalDocumentId:source.logicalDocumentId,
          fileName:record.fileName,documentType:source.documentType,
          page:source.fieldEvidence?.[key]?.[0]?.page,
          confidence:source.fieldEvidence?.[key]?.[0]?.confidence??source.confidence,
          sourceValue:stringify(raw),field:key});
      }
    }
    return data;
  }
  function section(id:string,title:string,write:(add:FieldBuilder)=>void){
    const rows:WorksheetRow[]=[];
    const add:FieldBuilder=(rowId,label,value,keys=[],opts={})=>{
      seenSources.clear();
      const evidence=fieldEvidence(keys,opts.subjectType,opts.subjectId);
      // Default 0/false values in untouched Case factories are NOT answers.
      // Keep an explicitly Broker-verified Ownership lease status as a Case
      // entry, but flag all other unsourced numeric/boolean defaults as missing.
      const verifiedLease=rowId.endsWith("-tenure")&&
        item.vehicles.some(vehicle=>vehicle.id===opts.subjectId&&vehicle.ownership?.received);
      const unresolvedDefault=(value===false||value===0)&&!evidence.length&&
        !verifiedLease&&!item.factConfirmations?.[rowId]?.confirmed;
      const declared=!unresolvedDefault&&available(value)?stringify(value):"";
      const extractedValues=[...new Set(evidence.map(x=>compare(x.sourceValue)))];
      const sourceFields=(item.field_sources??[]).filter(x=>
        keys.includes(x.canonicalField??x.field) &&
        (!opts.subjectType||!x.subjectType||x.subjectType===opts.subjectType) &&
        (!opts.subjectId||!x.subjectId||x.subjectId===opts.subjectId));
      const resolved=sourceFields.some(x=>x.status==="resolved");
      const caseDisagrees=Boolean(declared&&evidence.length&&
        !evidence.some(entry=>
          ["namedInsured","coInsured","registeredOwner"].some(key=>keys.includes(key))?
            sameNamedPersons([declared],[entry.sourceValue]):
            compare(declared)===compare(entry.sourceValue)));
      const conflicting=!resolved&&(extractedValues.length>1||caseDisagrees)||
        sourceFields.some(x=>x.status==="conflict"&&!x.resolved_by_user);
      let status:WorksheetStatus=conflicting?"conflict":declared?
        evidence.length?(resolved?"confirmed":"extracted"):"case-only":
        evidence.length?"extracted":"missing";
      const sourced=evidence.length&&!conflicting&&extractedValues.length===1?evidence[0].sourceValue:"";
      const note=conflicting?"Sources or Case value disagree — confirm against originals.":
        status==="case-only"?"Case value has no linked active source — verify manually.":
        status==="extracted"&&!declared?"Parsed from source; not yet confirmed in Case.":
        opts.note;
      rows.push({id:rowId,label,value:conflicting?(declared||"CONFLICT — inspect sources"):
        (declared||sourced||"NOT FOUND / CONFIRM"),status,evidence,required:opts.required??true,note});
    };
    write(add);
    sections.push({id,title,rows});
  }
  const policy=item.policy;
  const insured=item.insured;
  const co=(insured?.co_insured??[]).map(x=>x.name).filter(Boolean);
  section("policy","1 · Policy / quote / insured",add=>{
    add("carrier","Insurance company",policy?.company,["insurer"]);
    add("client","Client code",policy?.client_code,["clientCode"],{required:false});
    add("insured","Named insured",insured?.name,["namedInsured"]);
    add("co","Co-insured",co,["coInsured"],{required:false});
    add("quote","Quote / submission #",auto?policy?.auto_quote_number||policy?.quote_number:policy?.hab_quote_number||policy?.quote_number,["quoteNumber"]);
    add("policy","Policy #",policy?.policy_number,["policyNumber"],{required:isChange});
    add("effective","Effective date",policy?.effective_date,["effectiveDate"]);
    add("expiry","Expiry date",policy?.expiry_date,["expiryDate"],{required:false});
    add("mail","Mailing address",policy?.mailing_address,["mailingAddress","address"],{required:false});
    add("risk","Risk / garaging address",policy?.risk_address??item.habitational_risk?.risk_address,["riskAddress","garagingAddress"],{required:false});
    add("binder","Binder #",policy?.binder_number,["binderNumber"],{required:false});
  });
  if(isChange){
    const change=item.policy_change;
    const types=normalizePolicyChangeTransactions(change?.requested_action??"",change?.transaction_types??[]);
    section("change","2 · Requested Policy Change — key-in instructions",add=>{
      add("types","Change types",types.filter(t=>t!=="OTHER_POLICY_CHANGE"||!change?.requested_action),["requestedAction"]);
      add("instruction","Client's requested action",change?.requested_action,["requestedAction","freeTextInstruction"]);
      add("change-date","Requested effective date",change?.change_effective_date||change?.requested_effective_date||policy?.effective_date,["requestedEffectiveDate","effectiveDate"]);
      add("target","Vehicle / property affected",change?.vehicle_or_property,["vehicleOrProperty","vehicle"],{required:false});
      add("vin","Affected VIN",change?.vin,["vin"],{required:false});
      add("backdated","Backdated?",change?.is_backdated,["isBackdated"],{required:false});
      add("backdate-reason","Backdate reason",change?.backdate_reason,["backdateReason"],{required:false});
      add("prior-state","Current policy state",change?.current_policy_state&&Object.keys(change.current_policy_state).length?change.current_policy_state:undefined,["currentPolicyState"],{required:false});
      add("result-state","Resulting policy state",change?.resulting_policy_state&&Object.keys(change.resulting_policy_state).length?change.resulting_policy_state:undefined,["resultingPolicyState"],{required:false});
      add("uw","UW status",change?.uw_status,["uwStatus"],{required:false});
      add("instructions","Broker/client notes",change?.notes,["reason","notes"],{required:false});
    });
    section("requested-changes","3 · Before → After (each requested transaction)",add=>{
      for(const [index,entry] of (change?.requested_changes??[]).entries()){
        const prefix="transaction-"+index;
        add(prefix+"-type","Transaction "+(index+1)+" · Type",entry.type,["requestedAction"]);
        add(prefix+"-subject","Affected driver / vehicle",entry.subject_name||entry.subject_id,["driverName","vin","vehicle"],{required:false});
        add(prefix+"-field","Field",entry.field,[],{required:false});
        add(prefix+"-old","Previous value",entry.previous_value,[],{required:false});
        add(prefix+"-new","Requested value",entry.new_value,[],{required:false});
        add(prefix+"-date","Effective date",entry.effective_date||change?.change_effective_date,["requestedEffectiveDate"],{required:false});
        add(prefix+"-note","Transaction note",entry.notes,[],{required:false});
      }
      // Extract the actual old/new values directly from the client change form even if
      // the Broker deliberately did not pre-key the transaction details.
      const substitution=types.includes("VEHICLE_SUBSTITUTION");
      add("oldvin-from-form","Previous / removed VIN",undefined,["oldVin"],{required:substitution});
      add("newvin-from-form","New / replacement VIN",undefined,["newVin"],{required:substitution});
      add("old-car-from-form","Old vehicle",undefined,["oldVehicle"],{required:false});
      add("new-car-from-form","New vehicle",undefined,["newVehicle"],{required:false});
      add("prev-address-from-form","Previous address",undefined,["oldAddress"],{required:false});
      add("new-address-from-form","New address",undefined,["newAddress"],{required:false});
      add("prev-annual-from-form","Previous annual km",undefined,["previousAnnualKm"],{required:false});
      add("new-annual-from-form","Requested annual km",undefined,["requestedAnnualKm"],{required:false});
      add("prev-commute-from-form","Previous one-way commute",undefined,["previousCommuteKm"],{required:false});
      add("new-commute-from-form","Requested one-way commute",undefined,["requestedCommuteKm"],{required:false});
      add("prev-field-from-form","Previous value on request",undefined,["previousValue"],{required:false});
      add("new-field-from-form","Requested value on request",undefined,["requestedValue"],{required:false});
      add("coverage-form","Requested coverage changes",undefined,["coverageChanges"],{required:false});
      if(!(change?.requested_changes??[]).length)
        add("no-structured-change","Auditor's itemized before / after confirmation",undefined,[],{
          note:"Broker did not pre-key individual transactions. Use these extracted old/new values to assemble the final portal change request."});
    });
    if(types.some(t=>["VEHICLE_SUBSTITUTION","ADD_VEHICLE","DELETE_VEHICLE","VEHICLE_USE_CHANGE","COMMUTE_CHANGE","ANNUAL_KM_CHANGE","DRIVER_REASSIGNMENT"].includes(t)))
      section("vehicle-change","4 · Vehicle / driver impact",add=>{
        add("old-vehicle","Old / removed vehicle",change?.remove,[],{required:types.includes("VEHICLE_SUBSTITUTION")||types.includes("DELETE_VEHICLE")});
        add("new-vehicle","Added / replacement vehicle",change?.add,["vin"],{required:types.includes("VEHICLE_SUBSTITUTION")||types.includes("ADD_VEHICLE")});
        add("unchanged","Kept vehicles",change?.keep,[],{required:false});
        for(const [i,vehicle] of (item.vehicles??[]).entries()){
          const subjectId=vehicle.id;
          add("affected-vin-"+i,"Vehicle "+(i+1)+" VIN",vehicle.vin,["vin"],{subjectType:"VEHICLE",subjectId});
          add("affected-owner-"+i,"Vehicle "+(i+1)+" Ownership name",vehicle.ownership?.registered_owner,["registeredOwner"],{subjectType:"VEHICLE",subjectId});
          add("affected-use-"+i,"Vehicle "+(i+1)+" Use",vehicle.primary_use,["vehicleUse"],{subjectType:"VEHICLE",subjectId});
          add("affected-km-"+i,"Vehicle "+(i+1)+" Annual km",vehicle.annual_km,["annualKm"],{subjectType:"VEHICLE",subjectId});
          add("affected-commute-"+i,"Vehicle "+(i+1)+" One-way commute km",vehicle.commute_km,["commuteKm"],{subjectType:"VEHICLE",subjectId});
        }
        for(const [i,driver] of (item.drivers??[]).entries()){
          add("driver-assignment-"+i,"Driver "+(i+1)+" assignment",driver.assigned_vehicle,["assignedVehicle"],{subjectType:"DRIVER",subjectId:driver.id,required:false});
        }
      });
  } else {
    section("prior","2 · Prior insurance",add=>{
      const prior=item.prior_insurance;
      add("prior-carrier","Previous insurer",prior?.insurer,["priorInsurer"]);
      add("prior-policy","Previous policy #",prior?.policy_number,["priorPolicyNumber"]);
      add("prior-effective","Prior effective",prior?.effective_date,["priorEffective"],{required:false});
      add("prior-expiry","Prior expiry",prior?.expiry_date,["priorExpiry"],{required:false});
      add("insured-since",auto?"Auto insured since":"Property insured since",prior?.insured_since,["propertyInsuredSince","insuredSince"]);
      add("continuous","Continuous insurance",prior?.continuous_insurance,["continuouslyInsuredSince"],{required:false});
      add("company-since","Date with previous company",prior?.date_with_company,["dateWithCompany"],{required:false});
      add("prior-years","Years prior insured",prior?.years_prior_insurance,["yearsPriorInsurance"],{required:false});
      if(auto) {
        add("prev-vehicle","Previously insured vehicle",prior?.previous_vehicle,["previousVehicle"],{required:false});
        add("prev-use","Previous vehicle use",prior?.previous_use,["previousUse"],{required:false});
      }
    });
  }
  if(auto){
    section(isChange?"auto-drivers":"auto-driver-vehicle",isChange?"5 · Current drivers / affected vehicles":"3 · Driver + vehicle / MVR",add=>{
      for(const [i,driver] of (item.drivers??[]).entries()){
        const sid=driver.id;
        const more={subjectType:"DRIVER" as const,subjectId:sid};
        const pre="driver-"+i+"-";
        add(pre+"mvr-request","Driver "+(i+1)+" MVR requested",driver.mvr_requested,["requestDate"],{...more,required:false});
        add(pre+"mvr-received","Driver "+(i+1)+" MVR received",driver.mvr_received,["receivedDate"],{...more,required:false});
        add(pre+"name","Driver "+(i+1)+" name",driver.name,["driverName"],more);
        add(pre+"dob","Date of birth",driver.dob,["dob"],more);
        add(pre+"licence","Licence #",driver.licence_number,["licenceNumber"],more);
        add(pre+"province","Licence province",driver.licence_province,["licenceProvince"],more);
        add(pre+"class","Licence class",driver.licence_class,["licenceClass"],more);
        add(pre+"expiry","Licence expiry",driver.licence_expiry,["expiryDate"],more);
        add(pre+"G1","G1 date",driver.g1_date,["g1Date"],{...more,required:false});
        add(pre+"G2","G2 date",driver.g2_date,["g2Date"],{...more,required:false});
        add(pre+"G","G date",driver.g_date,["gDate"],{...more,required:false});
        add(pre+"mvr-issue","MVR issue date",driver.mvr_issue_date,["issueDate"],{...more,required:false});
        add(pre+"lic-status","Licence status",driver.licence_status,["licenceStatus"],{...more,required:false});
        add(pre+"conditions","Licence restrictions",driver.licence_conditions,["conditions"],{...more,required:false});
        add(pre+"principal","Principal driver?",driver.principal,["principal"],more);
        add(pre+"assigned","Assigned vehicle",driver.assigned_vehicle,["assignedVehicle"],{...more,required:false});
        add(pre+"relationship","Relationship",driver.relationship,["relationship"],{...more,required:false});
        add(pre+"convictions","Convictions on MVR",driver.mvr_convictions?.length?driver.mvr_convictions:undefined,["convictions"],{...more,required:false});
        add(pre+"telematics","Telematics",driver.telematics?.enabled,["telematicsDiscount"],{...more,required:false});
      }
      if(!item.drivers?.length)add("drivers-missing","Drivers",undefined,[],{note:"No driver record; review MVR and Application."});
      for(const [i,vehicle] of (item.vehicles??[]).entries()){
        const sid=vehicle.id;
        const more={subjectType:"VEHICLE" as const,subjectId:sid};
        const pre="vehicle-"+i+"-";
        add(pre+"year","Vehicle "+(i+1)+" year",vehicle.year,["year"],more);
        add(pre+"make","Make",vehicle.make,["make"],more);
        add(pre+"model","Model",vehicle.model,["model"],more);
        add(pre+"vin","VIN",vehicle.vin,["vin"],more);
        add(pre+"owner","Registered owner",vehicle.ownership?.registered_owner,["registeredOwner"],more);
        add(pre+"ownership-address","Ownership address",vehicle.ownership?.address,["ownerAddress"],{...more,required:false});
        add(pre+"plate","Plate",vehicle.ownership?.plate,["plate"],{...more,required:false});
        add(pre+"tenure","Leased?",vehicle.ownership?.leased??vehicle.leased,["leased"],more);
        add(pre+"lessor","Lessor",vehicle.ownership?.lessor?.name||vehicle.lessor?.name,["lessor"],{...more,required:false});
        add(pre+"lienholder","Lienholder",vehicle.ownership?.lienholder?.name||vehicle.lienholder?.name,["lienholder"],{...more,required:false});
        add(pre+"purchase-date","Purchase date",vehicle.purchase_date,["purchaseDate"],{...more,required:false});
        add(pre+"purchase-price","Purchase price",vehicle.purchase_price,["purchasePrice"],{...more,required:false});
        add(pre+"use","Primary use",vehicle.primary_use,["vehicleUse"],more);
        add(pre+"annual","Annual km",vehicle.annual_km,["annualKm"],more);
        add(pre+"commute","One-way commute km",vehicle.commute_km,["commuteKm"],more);
        add(pre+"business","Business use %",vehicle.business_use_percent,["businessUsePercent"],{...more,required:false});
        add(pre+"garaging","Garaging",vehicle.garaging_address,["garagingAddress"],{...more,required:false});
        add(pre+"winter","Winter tires",vehicle.winter_tires,["winterTires"],{...more,required:false});
      }
      if(!item.vehicles?.length)add("vehicles-missing","Vehicles",undefined,[],{note:"No rated vehicle records found."});
    });
    section("claims","Claims / licence history",add=>{
      const claims=item.claims??[];
      add("claim-count","Recorded claims",claims.length?claims:undefined,["claims"],{required:false,
        note:!claims.length?"No recorded claims is not a verified clean history. Check DASH/AutoPlus.":undefined});
      for(const [i,c] of claims.entries()){
        add("claim-"+i,"Claim "+(i+1)+" · date / driver / fault / status",
          [c.loss_date,c.driver,c.at_fault_percent===null?"Fault unknown":c.at_fault_percent+"% AF",c.status].filter(Boolean).join(" · "),
          ["claims"],{required:false});
      }
    });
  } else {
    section("home","Property / occupancy / construction",add=>{
      const risk=item.habitational_risk;
      const rows:[string,string,unknown,string[]][]=[
        ["type","Policy type",risk?.policy_type,["policyType"]],
        ["address","Risk address",risk?.risk_address,["riskAddress"]],
        ["occupancy","Occupancy",risk?.occupancy,["occupancy"]],
        ["occupied-since","Occupied since",risk?.occupied_since,["occupiedSince"]],
        ["structure","Structure",risk?.structure,["structure"]],
        ["construction","Construction",risk?.construction,["construction"]],
        ["exterior","Exterior finish",risk?.exterior_finish,["exteriorFinish"]],
        ["year","Year built",risk?.year_built,["yearBuilt"]],
        ["area","Living area (sq ft)",risk?.living_area,["livingArea"]],
        ["families","Families",risk?.families,["families"]],
        ["units","Units",risk?.units,["units"]],
        ["bedrooms","Bedrooms",risk?.bedrooms,["bedrooms"]],
        ["bathrooms","Bathrooms",risk?.bathrooms,["bathrooms"]],
        ["garage","Garage",risk?.garage,["garage"]],
        ["roof","Roof",risk?.roof,["roof"]],
        ["plumbing","Plumbing",risk?.plumbing,["plumbing"]],
        ["electrical","Electrical",risk?.electrical,["electrical"]],
        ["heating","Heating",risk?.heating,["heating"]],
        ["smoke-free","Smoke-free",risk?.smoke_free,["smokeFree"]],
        ["pool","Pool",risk?.swimming_pool,["swimmingPool"]],
        ["dog","Dogs / animals",risk?.dog_animal_exposure,["dogExposure"]],
        ["rental","Rental",risk?.rental,["rental"]],
        ["airbnb","Airbnb",risk?.airbnb,["airbnb"]],
        ["vacancy","Vacant",risk?.vacant,["vacant"]],
        ["business","Business use",risk?.business_use,["businessUse"]]
      ];
      for(const [id,label,value,keys] of rows)add("property-"+id,label,value,keys,
        {subjectType:"PROPERTY",subjectId:risk?.id,required:["type","address","occupancy","structure","construction","exterior"].includes(id)});
    });
    section("mortgage","Mortgage / interested parties",add=>{
      add("mortgage-count","Mortgages",item.mortgage?.number_of_mortgages,["numberOfMortgages"],{required:false});
      add("mortgagees","Mortgagee(s)",item.mortgage?.mortgagees?.map(m=>m.name+"; "+m.address),["mortgagee","mortgageeAddress"],{required:false});
      add("interest","Nature of interest",item.mortgage?.nature_of_interest,["natureOfInterest"],{required:false});
      add("loss-payee","Loss payees",item.mortgage?.loss_payees?.map(p=>p.name+"; "+p.address),["lossPayee"],{required:false});
    });
  }
  section("coverage","Coverage / endorsements / discounts",add=>{
    add("liability","Liability",item.coverage?.liability,["liability"],{required:false});
    add("dcpd","DCPD deductible",item.coverage?.dcpd_deductible,["dcpdDeductible"],{required:false});
    add("all-perils","All Perils deductible",item.coverage?.all_perils_deductible,["allPerilsDeductible"],{required:false});
    add("endorsements","OPCF / endorsements",item.coverage?.endorsements,["endorsement"],{required:false});
    for(const [i,row] of (item.coverage?.comparison??[]).entries()){
      add("coverage-"+i,row.name,row.quote??row.application??row.portal,
        [row.name],{required:row.required??false,note:
          row.quote&&row.application&&row.quote!==row.application?"Application/Quote difference — review.":undefined});
    }
    add("discounts","Selected discounts",item.intake_discount_review?.selections.map(x=>x.kind+" → "+x.subject_key),[],
      {required:false});
    add("group","Group discount",item.group_discount?.selectionConfirmed?
      item.group_discount.selected?"Selected":"Not selected":undefined,[],{required:false});
  });
  section("payment","Payment (last)",add=>{
    add("plan","Payment plan",item.payment?.plan,["paymentPlan"],{required:false});
    add("annual","Annual premium",item.payment?.annual_premium??item.premium?.quoted_annual,["premium"],{required:false});
    add("tax","Tax",item.payment?.tax,["tax"],{required:false});
    add("fee","Fees",item.payment?.fees,["fees"],{required:false});
    add("monthly","Monthly amount",item.payment?.monthly_amount,["monthlyAmount"],{required:false});
    add("installments","Installments",item.payment?.number_of_installments,["numberOfInstallments"],{required:false});
    add("down","Down payment",item.payment?.down_payment,["downPayment"],{required:false});
    add("total","Total estimated",item.payment?.total_cost,["totalCost"],{required:false});
  });
  // All additional parsed fields remain visible even if no insured/carrier mapping yet exists.
  section("source-index","Additional extracted document fields (including unassigned)",add=>{
    const included=new Set(sections.flatMap(group=>group.rows.flatMap(row=>row.evidence.map(source=>
      [source.documentId,source.logicalDocumentId,source.field].join("|")))));
    for(const {record,source} of active){
      for(const [key,value] of Object.entries(source.data??{})){
        if(!available(value)||included.has([record.id,source.logicalDocumentId,key].join("|")))continue;
        add("raw-"+record.id+"-"+(source.logicalDocumentId??"file")+"-"+key,
          source.documentType+" · "+key,value,[key],{required:false,
            subjectType:source.subjectType as "DRIVER"|"VEHICLE"|"PROPERTY"|undefined,
            subjectId:source.subjectId,note:"Additional parsed value: check source/association before key-in."});
      }
    }
  });
  const rows=sections.flatMap(group=>group.rows);
  const unparsedDocuments=records.filter(record=>!active.some(p=>p.record.id===record.id)).map(record=>record.fileName);
  return {kind:isChange?(auto?"auto-change":"home-change"):(auto?"new-auto":"new-home"),
    sections,missing:rows.filter(row=>row.required&&row.status==="missing").length,
    conflicts:rows.filter(row=>row.status==="conflict").length,
    extracted:rows.filter(row=>row.status==="extracted"||row.status==="confirmed").length,
    documentCount:records.length,unparsedDocuments};
}
export function auditorWorksheetText(sheet:AuditorWorksheet):string{
  return sheet.sections.map(group=>group.title+"\n"+group.rows.map(row=>
    row.label+": "+row.value+" ["+row.status.toUpperCase()+"]"+
    (row.evidence.length?" (Source: "+row.evidence.map(source=>source.fileName+
      (source.page?" p."+source.page:"")).join("; ")+")":"")).join("\n")).join("\n\n");
}

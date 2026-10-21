// Local-only synthetic acceptance for the Broker file handoff and Auditor data worksheet.
import assert from "node:assert/strict";
import { createBlankAutoCase,createBlankHabCase,createBlankPolicyChangeCase } from "../lib/case-factories.ts";
import { createBlankCaseForType } from "../lib/new-case.ts";
import { parserFor } from "../lib/document-ingestion.ts";
import { buildAuditorWorksheet,auditorWorksheetText } from "../lib/auditor-worksheet.ts";
import { reconcileDocumentsIntoCase } from "../lib/reconciliation.ts";
import { evaluateIntakeProfile } from "../lib/intake-profile.ts";
import { runPhase3Rules } from "../lib/phase3-rules.ts";

function sourceRecord(id,type,parsed){
  const section=id+"-section";
  return {id,fileName:id+".pdf",mimeType:"application/pdf",sourceHash:id+"HASH",
    currentSourceHash:id+"HASH",documentType:type,
    logicalDocuments:[{id:section,physicalFileId:id,documentType:type,
      title:type,presenceStatus:"FOUND",startPage:1,endPage:1}],
    parsedSources:[{...parsed,documentId:id,logicalDocumentId:section}]};
}
const raw=text=>({text,rawText:text,confidence:.99,
  pages:[{page:1,pageNumber:1,text,confidence:.99}]});
const row=(sheet,id)=>sheet.sections.flatMap(section=>section.rows).find(r=>r.id===id);
function group(sheet,id){return sheet.sections.find(section=>section.id===id);}

// Broker may hand off a valid document set without completing the full insurer portal key-in.
const auto=createBlankAutoCase();
auto.insured.name="DOE, JOHN";auto.policy.company="Intact";auto.policy.client_code="SYN-AUTO";
auto.policy.quote_number="SYN-Q-001";auto.policy.effective_date="2026-10-21";
assert.equal(auto.drivers.length,0);
const q=await parserFor("AUTO_QUOTE").parse(raw(
  "Insurance Company: Intact\nNamed Insured: JOHN DOE\nQuote Number: SYN-Q-001\nVIN: 1HGCM82633A004352\nAnnual Premium: 2300\nAnnual KM: 7000\nCommute KM: 8\nLiability Limit: 2000000"));
const quote=sourceRecord("QUOTE","AUTO_QUOTE",q);
const sheet=buildAuditorWorksheet(auto,[quote]);
assert.equal(sheet.kind,"new-auto");
assert.equal(row(sheet,"carrier").value,"Intact");
assert.equal(row(sheet,"quote").value,"SYN-Q-001");
assert.equal(row(sheet,"insured").status,"extracted"); // same tokens despite punctuation/order
assert.equal(row(sheet,"drivers-missing").status,"missing");
assert(row(sheet,"insured").evidence.some(x=>x.documentId==="QUOTE"&&x.page===1));
assert(auditorWorksheetText(sheet).includes("QUOTE.pdf p.1"));
assert(sheet.sections.some(s=>s.id==="auto-driver-vehicle"));
assert(sheet.sections.some(s=>s.id==="payment"));
assert(!evaluateIntakeProfile(auto,[quote]).blockers.some(x=>
  x.code==="REQUIRED_DRIVER_MISSING"||x.code==="MVR_RECEIVED_DATE_MISSING"));
assert(runPhase3Rules(auto).some(x=>x.code==="REQUIRED_DRIVER_MISSING")); // Auditor QA retains it
const mismatch=buildAuditorWorksheet({...auto,insured:{name:"JANE DOE",co_insured:[]}},[quote]);
assert.equal(row(mismatch,"insured").status,"conflict");

// Multi-vehicle / multi-driver associations must not copy one report to every subject.
const splitAuto={...auto,
  vehicles:[
    {id:"CAR-A",vin:"1HGCM82633A004352",year:2026,make:"Honda",model:"Civic",
      primary_use:"",annual_km:0,commute_km:0,leased:false,owned:true,
      business_use_percent:0,winter_tires:false,parking:"",garaging_address:""},
    {id:"CAR-B",vin:"2T3B1RFV7RC472381",year:2026,make:"Toyota",model:"RAV4",
      primary_use:"",annual_km:0,commute_km:0,leased:false,owned:true,
      business_use_percent:0,winter_tires:false,parking:"",garaging_address:""}],
  drivers:[
    {id:"DRV-A",name:"JOHN DOE",licence_number:"X111",licence_class:"",
      mvr_received:"",principal:false},
    {id:"DRV-B",name:"ANN LEE",licence_number:"Y222",licence_class:"",
      mvr_received:"",principal:false}]
};
const syntheticMvr=sourceRecord("MVR-ONLY-A","MVR",{
  documentType:"MVR",confidence:1,parsedAt:new Date().toISOString(),
  data:{licenceNumber:"X111",driverName:"JOHN DOE",licenceClass:"G"},
  fieldEvidence:{licenceClass:[{page:1,text:"G"}]},warnings:[]});
const splitSheet=buildAuditorWorksheet(splitAuto,[quote,syntheticMvr]);
assert(row(splitSheet,"vehicle-0-vin").evidence.some(source=>source.documentId==="QUOTE"));
assert.equal(row(splitSheet,"vehicle-1-vin").evidence.length,0,
  "First car Quote must not source second car VIN.");
assert.equal(row(splitSheet,"vehicle-1-annual").status,"missing",
  "Default 0 km must not be presented as a confirmed value.");
assert(row(splitSheet,"driver-0-class").evidence.some(source=>source.documentId==="MVR-ONLY-A"));
assert.equal(row(splitSheet,"driver-1-class").evidence.length,0,
  "First driver's MVR cannot certify the second driver's licence.");
assert.equal(row(splitSheet,"driver-1-principal").status,"missing",
  "Default false must not be presented as a verified No.");

// Home document extraction becomes an Auditor worksheet, not another Broker questionnaire.
const home=createBlankHabCase();
home.policy.company="Intact";home.insured.name="LEE, ANN";
const hab=await parserFor("HAB_APPLICATION").parse(raw(
  "Insurance Company: Intact\nNamed Insured: ANN LEE\nOccupancy: Owner Occupied\n"+
  "Structure Type: Detached\nConstruction Type: Frame\nExterior Finish: Brick\n"+
  "Number of Families: 1\nSwimming Pool: No\nSmoke Free: Yes\nProperty Insured Since: 2018-05-01"));
const habDoc=sourceRecord("HOMEAPP","HAB_APPLICATION",hab);
const homeSheet=buildAuditorWorksheet(home,[habDoc]);
assert.equal(homeSheet.kind,"new-home");
assert.equal(row(homeSheet,"property-occupancy").value,"Owner Occupied");
assert.equal(row(homeSheet,"property-structure").value,"Detached");
assert.equal(row(homeSheet,"property-exterior").evidence[0].fileName,"HOMEAPP.pdf");
assert.equal(row(homeSheet,"insured-since").value,"2018-05-01");
const hydrated=reconcileDocumentsIntoCase(home,[habDoc]);
assert.equal(hydrated.habitational_risk.occupancy,"Owner Occupied");
assert.equal(hydrated.habitational_risk.structure,"Detached");
assert.equal(hydrated.habitational_risk.smoke_free,true);
assert.equal(hydrated.habitational_risk.swimming_pool,false);
assert.equal(hydrated.habitational_risk.families,1);

// A Policy Change is organized as previous -> new values, not a generic Case tab.
const change=createBlankPolicyChangeCase();
change.insured.name="SYNTHETIC CLIENT";change.policy.company="Intact";
change.policy.policy_number="SYN-PACT-100";
change.policy_change.transaction_types=["VEHICLE_SUBSTITUTION"];
change.policy_change.requested_action="Replace old vehicle with the new car";
change.policy_change.change_effective_date="2026-11-01";
const changeRaw=await parserFor("POLICY_CHANGE").parse(raw(
  "Policy Number: SYN-PACT-100\nOld VIN: 1HGCM82633A004352\nNew VIN: 2T3B1RFV7RC472381\n"+
  "Previous Annual KM: 5000\nRequested Annual KM: 12000\n"+
  "Requested Effective Date: 2026-11-01\nInstruction: Vehicle substitution"));
const changeDoc=sourceRecord("CHANGE_FORM","POLICY_CHANGE",changeRaw);
const changeSheet=buildAuditorWorksheet(change,[changeDoc]);
assert.equal(changeSheet.kind,"auto-change");
assert.equal(row(changeSheet,"oldvin-from-form").value,"1HGCM82633A004352");
assert.equal(row(changeSheet,"newvin-from-form").value,"2T3B1RFV7RC472381");
assert.equal(row(changeSheet,"newvin-from-form").status,"extracted");
assert(group(changeSheet,"requested-changes"));
assert(group(changeSheet,"vehicle-change"));
assert(!group(changeSheet,"prior")); // Change should not imply new-business prior insurance

const homeChange=createBlankCaseForType("HOME_POLICY_CHANGE");
assert.equal(homeChange.case_type,"home_policy_change");
assert.equal(buildAuditorWorksheet(homeChange,[]).kind,"home-change");
const legacy=createBlankHabCase();legacy.insured={name:"DOE, JOHN"};
assert.doesNotThrow(()=>buildAuditorWorksheet(legacy,[]));
assert.equal(row(buildAuditorWorksheet(legacy,[]),"co").status,"missing");
console.log("Broker file-only / Auditor structured key-in worksheet: PASS");

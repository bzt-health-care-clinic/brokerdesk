import test from "node:test";
import assert from "node:assert/strict";
import {projectBrokerReviewedCase} from "../local-server/reviewed-case-projection-stage3b.mjs";

const caseData=()=>({
  case_id:"case-one",case_type:"new_auto",
  insured:{name:"JOHN DOE"},
  policy:{company:"Pembridge",policy_number:"P001",effective_date:"2026-10-22",
    client_code:"C1",mailing_address:"1 Main St",risk_address:"1 Main St"},
  drivers:[
    {id:"driver-stable-1",name:"JOHN DOE",licence_number:"D12345",licence_class:"G"},
    {id:"driver-stable-2",name:"JANE DOE",licence_number:"D67890",licence_class:"G"}
  ],
  vehicles:[
    {id:"vehicle-stable-1",vin:"AAA00000000000001",year:2020,make:"Honda",model:"Accord",
      primary_use:"pleasure",annual_km:15000},
    {id:"vehicle-stable-2",vin:"BBB00000000000002",year:2019,make:"Nissan",model:"Rogue",
      primary_use:"commute",annual_km:16000}
  ],
  documents:[{id:"app1",required:true,received:true}]
});
const fields = object=>Object.entries(object).map(([id,value])=>({id,value}));
const review=(data=caseData(),custom={})=>({
  source_case_id:data.case_id,case_type:data.case_type,company:data.policy.company,
  review_status:"DRAFT",
  sections:[{id:"policy",status:"CONFIRMED",confirmation:{brokerId:"BROKER1"}}],
  fields:fields(custom)
});
const result=(data,r)=>projectBrokerReviewedCase(data,r);

test("empty projection preserves Case and has no changes",()=>{
  const data=caseData(), r=review(data);
  const out=result(data,r);
  assert.deepEqual(out.issues,[]);
  assert.equal(out.changes.length,0);
  assert.deepEqual(out.item,data);
  assert.notEqual(out.item,data);
});
test("Broker correction of stable vehicle VIN updates outbound copy only",()=>{
  const data=caseData(), old=structuredClone(data);
  const r=review(data,{"vehicle:vehicle-stable-1.vin":"CCC00000000000003"});
  const out=result(data,r);
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.vehicles[0].vin,"CCC00000000000003");
  assert.equal(out.changes.length,1);
  assert.deepEqual(data,old);
});
test("Broker correction of stable driver licence updates outbound copy",()=>{
  const data=caseData(),r=review(data,{"driver:driver-stable-1.licenceNumber":"D99881"});
  const out=result(data,r);
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.drivers[0].licence_number,"D99881");
  assert.equal(data.drivers[0].licence_number,"D12345");
});
test("cannot change VIN when used as vehicle's sole identity",()=>{
  const data=caseData(); delete data.vehicles[0].id;
  const r=review(data,{"vehicle:AAA00000000000001.vin":"CCC00000000000003"});
  const out=result(data,r);
  assert.match(out.issues.join(" "),/stable entity ID/);
  assert.equal(out.item.vehicles[0].vin,"AAA00000000000001");
});
test("cannot change licence when it is sole driver identity",()=>{
  const data=caseData(); delete data.drivers[0].id;
  const r=review(data,{"driver:D12345.licenceNumber":"D222222"});
  assert.match(result(data,r).issues.join(" "),/stable entity ID/);
});
test("duplicate VIN created by edit is rejected",()=>{
  const data=caseData(),r=review(data,{"vehicle:vehicle-stable-1.vin":data.vehicles[1].vin});
  assert.match(result(data,r).issues.join(" "),/duplicated/);
});
test("duplicate licence created by edit is rejected",()=>{
  const data=caseData(),r=review(data,{"driver:driver-stable-1.licenceNumber":"D67890"});
  assert.match(result(data,r).issues.join(" "),/duplicated/);
});
test("orphan entity evidence never attaches to the only real driver",()=>{
  const data=caseData();
  const r=review(data,{"driver:someone-else.licenceNumber":"D9999"});
  assert.match(result(data,r).issues.join(" "),/no unique original driver/);
});
test("invalid VIN length is not projected",()=>{
  const data=caseData();
  const out=result(data,review(data,{"vehicle:vehicle-stable-1.vin":"BAD"}));
  assert.match(out.issues.join(" "),/VIN must be/);
  assert.equal(out.item.vehicles[0].vin,data.vehicles[0].vin);
});
test("corrected policy number and insured can be used in outbound Case",()=>{
  const data=caseData();
  const out=result(data,review(data,{"policy.insured":"DOE, JOHN","policy.number":"P002"}));
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.insured.name,"DOE, JOHN");
  assert.equal(out.item.policy.policy_number,"P002");
});
test("insurer change is refused",()=>{
  const data=caseData();
  const out=result(data,review(data,{"policy.insurer":"Aviva"}));
  assert.match(out.issues.join(" "),/Insurer changes must/);
});
test("different source Case is refused",()=>{
  const data=caseData(),r=review(data);r.source_case_id="case-two";
  assert.match(result(data,r).issues.join(" "),/does not belong/);
});
test("unconfirmed section is refused",()=>{
  const data=caseData(),r=review(data);
  r.sections[0].status="PENDING";
  assert.match(result(data,r).issues.join(" "),/All Broker Review sections must be confirmed/);
});
test("invalid annual KM is rejected, exact number projected otherwise",()=>{
  const data=caseData();
  let out=result(data,review(data,{"vehicle:vehicle-stable-1.annualKm":-2}));
  assert.match(out.issues.join(" "),/numeric value/);
  out=result(data,review(data,{"vehicle:vehicle-stable-1.annualKm":9500}));
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.vehicles[0].annual_km,9500);
});
test("policy change Remarks, change after/date and effective date project only with stable ID",()=>{
  const data=caseData();
  data.case_type="auto_policy_change";
  data.policy_change={change_effective_date:"2026-10-22",notes:"original",
    requested_changes:[{id:"change-1",type:"VEHICLE_SUBSTITUTION",subject_id:"vehicle-stable-1",
      previous_value:"A",new_value:"B",effective_date:"2026-10-22"}]};
  const out=result(data,review(data,{
    "remarks.text":"Hi U/W,\nAs insured's request, please replace a vehicle.\nEffective date: October 23, 2026.",
    "change.effectiveDate":"2026-10-23",
    "change:change-1.after":"C",
    "change:change-1.date":"2026-10-23"
  }));
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.policy_change.requested_changes[0].new_value,"C");
  assert.equal(out.item.policy_change.change_effective_date,"2026-10-23");
  assert.ok(out.item.policy_change.notes.startsWith("Hi U/W"));
});
test("policy change transaction type cannot be altered through review alone",()=>{
  const data=caseData();data.case_type="auto_policy_change";
  data.policy_change={requested_changes:[{id:"C1",type:"CANCELLATION",subject_id:"vehicle-stable-1",new_value:"X"}]};
  const out=result(data,review(data,{"change:C1.type":"ADD_DRIVER"}));
  assert.match(out.issues.join(" "),/change type must/);
});
test("unstable Policy Change item cannot be rewritten by its array position",()=>{
  const data=caseData();data.case_type="auto_policy_change";
  data.policy_change={requested_changes:[{type:"CANCELLATION",new_value:"X"}]};
  const out=result(data,review(data,{"change:item-1.after":"Y"}));
  assert.match(out.issues.join(" "),/without stable IDs/);
});
test("date parsing rejects invalid calendar dates",()=>{
  const data=caseData();
  const out=result(data,review(data,{"policy.effectiveDate":"2026-02-30"}));
  assert.match(out.issues.join(" "),/invalid date/);
});
test("review's duplicate field ID cannot be trusted",()=>{
  const data=caseData(),r=review(data,{"policy.number":"P002"});
  r.fields.push({id:"policy.number",value:"P003"});
  assert.match(result(data,r).issues.join(" "),/duplicated/);
});
test("unmodeled coverage and discounts stay in reviewed snapshot, not guessed into Case",()=>{
  const data=caseData();
  const out=result(data,review(data,{
    "vehicle:vehicle-stable-1.opcf44":false,
    "vehicle:vehicle-stable-1.allPerils.present":true,
    "quoteDiscount:test.selected":true
  }));
  assert.deepEqual(out.issues,[]);
  assert.deepEqual(out.item,data);
});

test("non-Pembridge Remarks longer than 500 chars are preserved in the projected Case",()=>{
  const data=caseData();data.case_type="auto_policy_change";data.policy.company="Aviva";
  data.policy_change={requested_changes:[]};
  const value="Hi U/W, As insured's request, please "+ "add details ".repeat(70)+
    " Effective date: October 22, 2026.";
  const out=result(data,review(data,{"remarks.text":value}));
  assert.deepEqual(out.issues,[]);
  assert.equal(out.item.policy_change.notes,value);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  generateRemarks, validateRemarks, remarksCharacterCount, remarksDate
} from "../lib/remarks-generator.mjs";

const vehicle = {
  year: 2026, make: "HONDA", model: "CIVIC LX 4DR",
  vin: "1HGBH41JXMN109186", use: "pleasure", condition: "New",
  commute: true, commuteOneWayKm: 12, annualKm: 15000,
  lienholder: {name:"EXAMPLE FINANCE CANADA"},
  coverage: {
    liability: 1000000,
    allPerils: {present:true,deductible:1000},
    collision: {present:false}, comprehensive: {present:false},
    opcf: ["20","27","43A","44"]
  },
  winterTires: true, winterTireReceiptToFollow: true
};
const old = {
  year:2020, make:"TOYOTA",model:"RAV4 LE 4DR",vin:"2HGFC2F59LH000001",
  reason:"trade-in"
};
test("Add Vehicle includes use, one-way commute, annual KM, Coverage/OPCF and no Markdown",()=>{
  const result=generateRemarks({company:"Aviva",type:"ADD_VEHICLE",addedVehicle:vehicle,
    effectiveDate:"2026-10-22"});
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.match(result.text,/pleasure use/i);
  assert.match(result.text,/one-way commute 12 km/i);
  assert.match(result.text,/annual 15,000 km/i);
  assert.match(result.text,/All Perils \$1,000 deductible/i);
  assert.match(result.text,/liability \$1M/i);
  assert.match(result.text,/OPCF 20, 27, 43A, 44/);
  assert.doesNotMatch(result.text,/\*\*|^\s*[-*] /m);
});
test("No commute does not display empty/zero commute distance",()=>{
  const v={...vehicle,commute:false,commuteOneWayKm:null};
  const result=generateRemarks({company:"Intact",type:"ADD_VEHICLE",addedVehicle:v,
    effectiveDate:"2026-10-22"});
  assert.equal(result.valid,true);
  assert.match(result.text,/no commute/i);
  assert.doesNotMatch(result.text,/one-way commute/i);
});
test("Missing annual KM never silently generates an invented value",()=>{
  const v={...vehicle,annualKm:null};
  const result=generateRemarks({company:"Aviva",type:"ADD_VEHICLE",addedVehicle:v,
    effectiveDate:"2026-10-22"});
  assert.equal(result.needsManualCompletion,true);
  assert.ok(result.missing.includes("addedVehicle.annualKm"));
  assert.equal(result.templateId,"MANUAL_FALLBACK");
  assert.doesNotMatch(result.text,/undefined|NaN|15,000/);
});
test("Pembridge counts spaces, punctuation and line breaks, rejects over 460",()=>{
  const exact="X".repeat(459)+"!";
  assert.equal(remarksCharacterCount(exact),460);
  assert.equal(validateRemarks(exact,"Pembridge").valid,true);
  assert.equal(validateRemarks(exact+" ","PEMBRIDGE").valid,false);
  assert.equal(remarksCharacterCount("A\nB,C "),6);
});
test("Pembridge generator returns a clear over-limit state without truncating VIN",()=>{
  const verbose={...vehicle,model:"EXTRA-LONG VEHICLE DESCRIPTION ".repeat(12)};
  const result=generateRemarks({company:"Pembridge",type:"ADD_VEHICLE",
    addedVehicle:verbose,effectiveDate:"2026-10-22"});
  assert.equal(result.overLimit,true);
  assert.equal(result.valid,false);
  assert.ok(result.text.includes(vehicle.vin));
  assert.ok(result.characters>460);
});
test("Pembridge compact form applies and preserves required facts when within limit",()=>{
  const v={...vehicle, winterTires:false, lienholder:null,model:"CIVIC"};
  const result=generateRemarks({company:"Pembridge",type:"ADD_VEHICLE",
    addedVehicle:v,effectiveDate:"2026-10-22"});
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.ok(result.characters<=460);
  assert.match(result.text,/annual 15,000 km/);
  assert.match(result.text,/one-way commute 12 km/);
});
test("Cancellation requires a selected type and never guesses flat vs short rate",()=>{
  const missing=generateRemarks({company:"Aviva",type:"CANCELLATION",
    cancellation:{reason:"insured elsewhere"},effectiveDate:"2026-10-22"});
  assert.equal(missing.needsManualCompletion,true);
  const filled=generateRemarks({company:"Aviva",type:"CANCELLATION",
    cancellation:{type:"SHORT_RATE",reason:"insured elsewhere"},effectiveDate:"2026-10-22"});
  assert.equal(filled.valid,true);
  assert.match(filled.text,/short-rate cancel/i);
});
test("Void cheque Remarks do not leak bank account number",()=>{
  const result=generateRemarks({company:"Aviva",type:"PAYMENT_CHANGE",
    voidChequeAttached:true,accountNumber:"999000000",effectiveDate:"2026-10-22"});
  assert.equal(result.valid,true);
  assert.match(result.text,/attached void cheque/i);
  assert.ok(!result.text.includes("999000000"));
});
test("Vehicle substitution includes both VINs when all fields supplied",()=>{
  const result=generateRemarks({company:"Aviva",type:"VEHICLE_SUBSTITUTION",
    addedVehicle:vehicle,removedVehicle:old,effectiveDate:"2026-07-31"});
  assert.equal(result.valid,true,JSON.stringify(result));
  assert.ok(result.text.includes(vehicle.vin));
  assert.ok(result.text.includes(old.vin));
  assert.match(result.text,/July 31, 2026/);
});
test("Unsupported policy change returns the requested editable fallback",()=>{
  const result=generateRemarks({company:"Intact",type:"OTHER_POLICY_CHANGE",
    effectiveDate:"2026-10-22"});
  assert.equal(result.templateId,"MANUAL_FALLBACK");
  assert.equal(result.needsManualCompletion,true);
  assert.match(result.text,/Hi U\/W,\nAs insured's request,\nPlease\nEffective date:/);
});
test("Invalid ISO dates do not roll forward to a different date",()=>{
  assert.equal(remarksDate("2026-02-30"),null);
  assert.equal(remarksDate("2026-07-31"),"July 31, 2026");
});

test("Unknown Collision / Comprehensive must not be silently represented as absent",()=>{
  const v={...vehicle,coverage:{liability:1000000,opcf:["44"],
    allPerils:{present:true,deductible:1000}}};
  const result=generateRemarks({company:"Aviva",type:"ADD_VEHICLE",
    addedVehicle:v,effectiveDate:"2026-10-22"});
  assert.equal(result.needsManualCompletion,true);
  assert.ok(result.missing.includes("addedVehicle.coverage.collision.present"));
  assert.ok(result.missing.includes("addedVehicle.coverage.comprehensive.present"));
});

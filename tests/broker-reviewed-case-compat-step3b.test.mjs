import test from "node:test";
import assert from "node:assert/strict";
import {projectBrokerReviewedCase} from "../local-server/reviewed-case-projection-stage3b.mjs";
import {reviewedCaseConsistencyIssues} from "../local-server/reviewed-keyin-package.mjs";

const base=()=>({
  case_id:"test1",case_type:"new_auto",
  insured:{name:"John Doe"},
  policy:{company:"Pembridge",policy_number:"P100"},
  drivers:[{id:"driver-id",name:"John Doe",licence_number:"D100"}],
  vehicles:[{id:"vehicle-id",vin:"AAA00000000000001"}]
});
const reviewFor=(item,changes)=>({
  source_case_id:item.case_id,case_type:item.case_type,company:item.policy.company,
  review_status:"DRAFT",sections:[{id:"policy",status:"CONFIRMED",confirmation:{brokerId:"B1"}}],
  fields:Object.entries(changes).map(([id,value])=>({id,value}))
});
test("Step 3A import consistency accepts corrected VIN only after outbound projection",()=>{
  const item=base(),review=reviewFor(item,{
    "policy.insurer":"Pembridge","vehicle:vehicle-id.vin":"CCC00000000000003"
  });
  assert.ok(reviewedCaseConsistencyIssues(review,item).some(x=>/VIN differs/.test(x)));
  const projected=projectBrokerReviewedCase(item,review);
  assert.deepEqual(projected.issues,[]);
  assert.deepEqual(reviewedCaseConsistencyIssues(review,projected.item),[]);
});
test("Step 3A import consistency accepts corrected licence and insured after outbound projection",()=>{
  const item=base(),review=reviewFor(item,{
    "policy.insurer":"Pembridge","policy.insured":"DOE, JOHN",
    "driver:driver-id.licenceNumber":"D200"
  });
  const projected=projectBrokerReviewedCase(item,review);
  assert.deepEqual(projected.issues,[]);
  assert.deepEqual(reviewedCaseConsistencyIssues(review,projected.item),[]);
});

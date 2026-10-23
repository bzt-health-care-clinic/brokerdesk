import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStructuredAuditorSheet, structuredGroupText, structuredSectionText, structuredSheetText
} from "../lib/auditor-structured-sheet.mjs";

const row=(id,label,originalValue,evidencePresent=true)=>({
  id,label,originalValue,value:typeof originalValue==="string"?originalValue:
    JSON.stringify(originalValue),evidencePresent
});
const section=(id,title,rows)=>({id,title,rows});
function sample() {
  return {brokerReview:"BROKER_CONFIRMED",sourceReviewHash:"hash",
    sections:[
    section("policy","Policy",[
      row("policy.insured","Named Insured","DOE, JOHN"),
      row("policy.number","Policy #","POL-1"),
    ]),
    section("drivers","Drivers",[
      row("driver:D1.name","Doe, John · Name","John Doe"),
      row("driver:D1.licenceNumber","Doe, John · Licence Number","D00001"),
      row("driver:D2.name","Jane Doe · Name","Jane Doe"),
      row("driver:D2.licenceNumber","Jane Doe · Licence Number","D00002"),
    ]),
    section("vehicles","Vehicles",[
      row("vehicle:V1.year","VIN1 · Year",2026),
      row("vehicle:V1.make","VIN1 · Make","BMW"),
      row("vehicle:V1.model","VIN1 · Model","X1"),
      row("vehicle:V1.vin","VIN1 · VIN","VIN1"),
      row("vehicle:V1.annualKm","VIN1 · Annual KM",18000),
      row("vehicle:V1.commute","VIN1 · Commute",false),
      row("vehicle:V1.driverAssignments","VIN1 · Assigned Driver -> Role",
        [{driverId:"D1",role:"PRINCIPAL"}]),
      row("vehicle:V2.year","VIN2 · Year",2019),
      row("vehicle:V2.make","VIN2 · Make","Nissan"),
      row("vehicle:V2.model","VIN2 · Model","Rogue"),
      row("vehicle:V2.vin","VIN2 · VIN","VIN2"),
      row("vehicle:V2.driverAssignments","VIN2 · Assigned Driver -> Role",
        [{driverId:"D2",role:"SECONDARY"}]),
    ]),
    section("coverage","Coverage",[
      row("vehicle:V1.liability","VIN1 · Liability",1000000),
      row("vehicle:V1.allPerils.present","VIN1 · All Perils",true),
      row("vehicle:V1.allPerils.deductible","VIN1 · All Perils Deductible",1000),
      row("vehicle:V1.collision.present","VIN1 · Collision",false),
      row("vehicle:V1.collision.deductible","VIN1 · Collision Deductible",null),
      row("vehicle:V1.opcf","VIN1 · Selected OPCF",["20","27","44"]),
      row("vehicle:V2.liability","VIN2 · Liability",2000000),
      row("vehicle:V2.comprehensive.present","VIN2 · Comprehensive",true),
      row("vehicle:V2.comprehensive.deductible","VIN2 · Comprehensive Deductible",500),
      row("quoteDiscount:winter.selected","Quote Discount: Winter Tires",true),
      row("quoteDiscounts.checkedAgainstQuote","All discounts shown on Quote checked",true),
    ]),
    section("history","MVR / DASH / Prior Insurance",[
      row("report:mvr:M1.pulledDate","MVR Pulled Date","2026-10-01"),
      row("report:mvr:M1.summary","MVR Convictions / Claims",
        {hasConvictions:true,convictions:[
          {offenceDate:"2024-05-14",description:"Speeding",classification:"Minor"}
        ]}),
      row("report:mvr:M2.pulledDate","MVR Pulled Date","2026-10-02"),
      row("report:mvr:M2.summary","MVR Convictions / Claims",
        {hasConvictions:false,convictions:[]}),
      row("report:dash:H1.pulledDate","DASH Pulled Date","2026-10-03"),
      row("report:dash:H1.summary","DASH Claims",
        {hasClaims:true,claims:[
          {claimNumber:"C-1",lossDate:"2021-08-21",driver:"John Doe",
           vehicle:"VIN1",atFaultPercent:0},
          {claimNumber:"C-2",lossDate:"2022-02-10",driver:"Jane Doe",
           vehicle:"VIN2",atFaultPercent:50},
        ]}),
      row("prior.insurer","Prior Insurer","Company A"),
      row("prior.policyNumber","Prior Policy #","PA-1"),
      row("prior.start","Prior Start Date","2022-01-01"),
      row("prior.end","Prior End Date","2026-01-01"),
      row("prior.continuous","Continuous Insurance","4 years"),
    ]),
    section("documents","Payment / Documents",[
      row("document:doc1.received","Ownership File Present",true),
    ]),
  ]};
}
const view=()=>buildStructuredAuditorSheet(sample());
const getSection=(sheet,id)=>sheet.sections.find(section=>section.id===id);
const getGroup=(sheet,section,id)=>getSection(sheet,section)?.groups.find(group=>group.id===id);

test("requires explicit Broker-confirmed state",()=>{
  assert.throws(()=>buildStructuredAuditorSheet({brokerReview:"DRAFT",sections:[]}),/Broker-confirmed/);
  assert.throws(()=>buildStructuredAuditorSheet({brokerReview:"BROKER_CONFIRMED",sections:"wrong"}),/Broker-confirmed/);
});
test("keeps original hash and uses canonical section order",()=>{
  const result=view();
  assert.equal(result.sourceReviewHash,"hash");
  assert.deepEqual(result.sections.map(s=>s.id),
    ["policy","drivers","vehicles","coverage","history","documents"]);
});
test("groups vehicles and own coverage in separate subject cards",()=>{
  const result=view();
  const v1=getGroup(result,"vehicles","vehicle:V1");
  const v2=getGroup(result,"vehicles","vehicle:V2");
  assert.match(v1.title,/2026 BMW X1/);
  assert.ok(v1.rows.some(r=>r.label==="Liability"&&r.value==="1000000"));
  assert.ok(v2.rows.some(r=>r.label==="Liability"&&r.value==="2000000"));
  assert.equal(v2.rows.some(r=>r.label==="All Perils"),false);
  assert.equal(getSection(result,"coverage").groups.some(g=>g.id.startsWith("vehicle:")),false);
});
test("only actual driver assignments are shown without invented roles",()=>{
  const result=view();
  const first=getGroup(result,"vehicles","vehicle:V1").tables.find(t=>t.title==="Assigned Drivers");
  assert.deepEqual(first.rows[0].values,["John Doe","Principal"]);
  assert.equal(first.rows.length,1);
  assert.doesNotMatch(structuredSheetText(result),/Occasional/);
});
test("secondary driver stays with second vehicle",()=>{
  const second=getGroup(view(),"vehicles","vehicle:V2").tables.find(t=>t.title==="Assigned Drivers");
  assert.deepEqual(second.rows[0].values,["Jane Doe","Secondary"]);
});
test("cannot invent driver's name for unknown ID",()=>{
  const s=sample();
  s.sections.find(x=>x.id==="vehicles").rows.find(r=>r.id==="vehicle:V1.driverAssignments")
    .originalValue=[{driverId:"D-UNKNOWN",role:"OCCASIONAL"}];
  const result=buildStructuredAuditorSheet(s);
  const roles=getGroup(result,"vehicles","vehicle:V1").tables.find(t=>t.title==="Assigned Drivers");
  assert.deepEqual(roles.rows[0].values,["Driver ID: D-UNKNOWN","Occasional"]);
});
test("shows false Collision and hides only inactive deductible",()=>{
  const v1=getGroup(view(),"vehicles","vehicle:V1");
  assert.ok(v1.rows.some(r=>r.label==="Collision"&&r.value==="No"));
  assert.equal(v1.rows.some(r=>r.label==="Collision Deductible"),false);
  assert.ok(v1.rows.some(r=>r.label==="All Perils Deductible"&&r.value==="1000"));
});
test("vehicle annual distance and OPCF survive as final values",()=>{
  const v1=getGroup(view(),"vehicles","vehicle:V1");
  assert.ok(v1.rows.some(r=>r.label==="Annual KM"&&r.value==="18000"));
  assert.ok(v1.rows.some(r=>r.label==="Commute"&&r.value==="No"));
  assert.match(structuredGroupText(v1),/20; 27; 44/);
});
test("quote discount section only lists explicitly supplied discounts",()=>{
  const result=view(), groups=getSection(result,"coverage").groups;
  assert.deepEqual(groups.map(g=>g.title),["Discounts Shown on Quote"]);
  assert.match(structuredSectionText(getSection(result,"coverage")),/Winter Tires: Yes/);
  assert.doesNotMatch(structuredSectionText(getSection(result,"coverage")),/Multi-Vehicle/);
});
test("MVR pulled date and convictions are structured not raw JSON",()=>{
  const mvr=getGroup(view(),"history","report:mvr:M1");
  assert.ok(mvr.rows.some(r=>r.label==="Pulled Date"&&r.value==="2026-10-01"));
  assert.equal(mvr.tables.length,1);
  assert.deepEqual(mvr.tables[0].columns,["Offence Date","Description","Classification"]);
  assert.deepEqual(mvr.tables[0].rows[0].values,["2024-05-14","Speeding","Minor"]);
});
test("MVR zero convictions remains explicit, not a missing record",()=>{
  const mvr=getGroup(view(),"history","report:mvr:M2");
  assert.ok(mvr.rows.some(r=>r.label==="Convictions"&&r.value==="No"));
  assert.equal(mvr.tables.length,0);
});
test("unknown MVR is never labeled as clean",()=>{
  const s=sample(), fields=s.sections.find(x=>x.id==="history").rows;
  fields.find(f=>f.id==="report:mvr:M2.summary").originalValue={};
  const mvr=getGroup(buildStructuredAuditorSheet(s),"history","report:mvr:M2");
  assert.ok(mvr.rows.some(r=>r.label==="Convictions"&&r.value==="Not provided"));
});
test("DASH 0% at fault retained and per-record details not merged",()=>{
  const dash=getGroup(view(),"history","report:dash:H1");
  assert.equal(dash.tables[0].rows.length,2);
  assert.deepEqual(dash.tables[0].rows[0].values,
    ["C-1","2021-08-21","John Doe","VIN1","0%"]);
  assert.deepEqual(dash.tables[0].rows[1].values,
    ["C-2","2022-02-10","Jane Doe","VIN2","50%"]);
});
test("prior insurance shows only most recent fields without assuming longer history",()=>{
  const g=getGroup(view(),"history","history:prior");
  assert.match(structuredGroupText(g),/Company A/);
  assert.match(structuredGroupText(g),/PA-1/);
  assert.match(structuredGroupText(g),/4 years/);
});
test("all groups provide clipboard-ready plain text",()=>{
  const plain=structuredSheetText(view());
  assert.match(plain,/2026 BMW X1 · VIN1/);
  assert.match(plain,/0%/);
  assert.match(plain,/Minor/);
  assert.doesNotMatch(plain,/\"hasConvictions\":/);
});
test("Policy Change preserves Before / After and mandatory plain Remarks",()=>{
  const s={
    brokerReview:"BROKER_CONFIRMED",
    sections:[
      section("changes","Requested Changes / Before -> After",[
        row("change.effectiveDate","Effective Date","2026-07-31"),
        row("change:ADD-1.type","ADD-1 · Action","VEHICLE_SUBSTITUTION"),
        row("change:ADD-1.subject","ADD-1 · Affected Object","BMW X1"),
        row("change:ADD-1.before","ADD-1 · Before","2019 Nissan"),
        row("change:ADD-1.after","ADD-1 · After","2026 BMW X1"),
        row("change:ADD-1.date","ADD-1 · Effective Date","2026-07-31"),
      ]),
      section("remarks","UW Remarks",[
        row("remarks.text","UW Remarks",
          "Hi U/W,\nAs insured's request,\nPlease add 2026 BMW X1.\nEffective date: July 31, 2026.")
      ])
    ]
  };
  const result=buildStructuredAuditorSheet(s);
  const change=getGroup(result,"changes","change:ADD-1");
  assert.match(change.title,/VEHICLE_SUBSTITUTION/);
  assert.match(structuredGroupText(change),/Before: 2019 Nissan/);
  assert.match(structuredGroupText(change),/After: 2026 BMW X1/);
  const remark=getSection(result,"remarks").groups[0].rows[0].value;
  assert.ok(remark.startsWith("Hi U/W,\n"));
  assert.equal((remark.match(/\*/g)??[]).length,0);
  assert.match(structuredSheetText(result),/Effective date: July 31, 2026/);
});
test("no report row or vehicle owner is guessed for unexpected catalog entries",()=>{
  const s=sample();
  s.sections.find(x=>x.id==="history").rows.push(
    row("history.notes","History Note","Subject could not be matched"));
  const result=buildStructuredAuditorSheet(s);
  assert.match(structuredSheetText(result),/Subject could not be matched/);
});
test("empty or false values are not mistakenly labelled confirmed zero",()=>{
  const s=sample();
  s.sections.find(x=>x.id==="vehicles").rows.push(
    row("vehicle:V1.parkingSameAsMailing","VIN1 · Garaging = Mailing",false));
  s.sections.find(x=>x.id==="coverage").rows.push(
    row("vehicle:V1.otherDeductible","VIN1 · Additional Deductible",0));
  const v1=getGroup(buildStructuredAuditorSheet(s),"vehicles","vehicle:V1");
  assert.equal(v1.rows.find(x=>x.label==="Garaging = Mailing").value,"No");
  assert.equal(v1.rows.find(x=>x.label==="Additional Deductible").value,"0");
});

test("two DASH report perspectives for one loss remain separate, not added together",()=>{
  const s=sample();
  s.sections.find(x=>x.id==="history").rows.push(
    row("report:dash:H2.pulledDate","DASH Pulled Date","2026-10-04"),
    row("report:dash:H2.summary","DASH Claims",{
      hasClaims:true,
      claims:[{claimNumber:"C-1",lossDate:"2021-08-21",
        driver:"Jane Doe",vehicle:"VIN2",atFaultPercent:100,
        reportPerspective:"Third Party",claimAmount:3000}]
    })
  );
  const result=buildStructuredAuditorSheet(s);
  const all=getSection(result,"history").groups.filter(g=>g.id.startsWith("report:dash:"));
  assert.equal(all.length,2);
  assert.equal(all[0].tables[0].rows.length,2);
  assert.equal(all[1].tables[0].rows.length,1);
  assert.match(structuredSheetText(result),/100%/);
  assert.doesNotMatch(structuredSheetText(result),/150%/);
});
test("optional DASH report perspective and claim amount are not silently discarded",()=>{
  const s=sample();
  const summary=s.sections.find(x=>x.id==="history").rows.find(r=>r.id==="report:dash:H1.summary");
  summary.originalValue.claims[0].reportPerspective="First Party";
  summary.originalValue.claims[0].claimAmount=4200;
  const d=getGroup(buildStructuredAuditorSheet(s),"history","report:dash:H1").tables[0];
  assert.ok(d.columns.includes("Report Perspective"));
  assert.ok(d.columns.includes("Claim Amount"));
  assert.ok(d.rows[0].values.includes("First Party"));
  assert.ok(d.rows[0].values.includes("4200"));
});
test("a confirmed Home worksheet without Vehicles keeps its coverage",()=>{
  const result=buildStructuredAuditorSheet({
    brokerReview:"BROKER_CONFIRMED",
    sections:[
      section("property","Property",[row("home.riskAddress","Risk Address","10 Sample St")]),
      section("coverage","Coverage",[
        row("home.coverage","Coverage / Limits",{dwelling:900000,liability:2000000})
      ])
    ]
  });
  assert.deepEqual(result.sections.map(x=>x.id),["property","coverage"]);
  assert.match(structuredSheetText(result),/"dwelling":900000/);
});
test("unidentified driver assignment is never silently reassigned to first driver",()=>{
  const s=sample();
  const assignment=s.sections.find(x=>x.id==="vehicles").rows.find(r=>r.id==="vehicle:V2.driverAssignments");
  assignment.originalValue=[{driverId:"",role:"EXCLUDED"}];
  const roles=getGroup(buildStructuredAuditorSheet(s),"vehicles","vehicle:V2").tables[0];
  assert.deepEqual(roles.rows[0].values,["Unidentified driver","Excluded"]);
});

test("conflicting report details remain visible rather than silently hidden",()=>{
  const s=sample();
  const dash=s.sections.find(x=>x.id==="history").rows
    .find(r=>r.id==="report:dash:H1.summary");
  dash.originalValue.hasClaims=false;  // should be rejected by the Step 3E gate
  const group=getGroup(buildStructuredAuditorSheet(s),"history","report:dash:H1");
  assert.match(structuredGroupText(group),/Report Conflict/);
  assert.equal(group.tables[0].rows.length,2);
});

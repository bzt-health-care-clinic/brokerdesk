// Synthetic UI smoke of the ACTUAL Auditor inbox, local ZIP and Case opening.
// No customer uploads, keys, email or LAN services are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBlankHabCase, createBlankPolicyChangeCase } from "../lib/case-factories.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { SubmissionPilotService } from "../local-server/submission-service.mjs";
import { BrokerReviewService } from "../local-server/broker-review-integration.mjs";
import { readBdzip } from "../local-server/bdzip.mjs";

const front="http://127.0.0.1:5193",api="http://127.0.0.1:47843";
const temp=mkdtempSync(join(tmpdir(),"bd-pilot-ui-"));
const root=fileURLToPath(new URL("../",import.meta.url));
const env=Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","COMSPEC","PATHEXT","USERPROFILE","HOME","APPDATA","LOCALAPPDATA"]
  .filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{BROKERDESK_DATA_DIR:temp,BROKERDESK_LOCAL_API_PORT:"47843",
  NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL:api,BROKERDESK_LOCAL_FRONTEND_ORIGIN:front,
  NEXT_PUBLIC_BROKERDESK_MODE:"auditor",BROKERDESK_MODE:"auditor",
  BROKERDESK_FAST_LOCAL:"true",NEXT_TELEMETRY_DISABLED:"1"});
const children=[];
let db,browser;
function launch(args) {
  let errors="";
  const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",v=>{errors+=v.toString();});
  child.stderr.on("data",v=>{errors+=v.toString();});
  children.push(child);
  return {child,log:()=>errors};
}
async function until(fn,label,timeout=90000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    const answer=await fn().catch(()=>false);if(answer)return answer;
    await delay(180);
  }
  throw Error("Timed out: "+label);
}
const section=(physicalFileId,id,type)=>({id,physicalFileId,documentType:type,title:"Synthetic fixture",
  startPage:1,endPage:1,presenceStatus:"FOUND",parseStatus:"PARSED",
  validationStatus:"VALID",classificationSource:"MANUAL"});
function addDocument(repo,item,id,type) {
  const bytes=Buffer.from("No real PDF bytes: synthetic "+id);
  repo.saveDocument(item.case_id,{
    id,fileName:id+".pdf",mimeType:"application/pdf",size:bytes.length,documentType:type,
    classification:{documentType:type,confidence:1,reason:"synthetic"},state:"PARSED",
    logicalDocuments:[section(id,id+"SEC",type)],
  },bytes,id+".pdf");
}
try {
  const back=launch(["local-server/server.mjs"]);
  const ui=launch(["scripts/run-framework.mjs","dev","--port","5193","--hostname","127.0.0.1"]);
  await until(async()=> (await fetch(api+"/health")).ok,"backend",60000);
  await until(async()=> (await fetch(front)).ok,"frontend",90000);
  const paths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:temp});
  db=openDatabase(paths.database);
  const repo=new LocalRepositories(db,paths);
  const pilot=new SubmissionPilotService(db,paths,repo);
  const home=createBlankHabCase();
  home.policy.company="Pembridge";home.policy.client_code="UITEST01";
  home.policy.effective_date="2026-10-16";home.insured.name="SYNTHETIC PILOT CLIENT";
  repo.upsertCase({case:home},"CREATE_CASE");
  addDocument(repo,home,"UISIGNED","HAB_APPLICATION");
  addDocument(repo,home,"UIQUOTE","HAB_QUOTE");
  repo.saveSignedCase(home.case_id,{
    ...repo.getCase(home.case_id),signed_document_id:"UISIGNED",
    signed_logical_document_id:"UISIGNEDSEC"
  },"SIGNED_VERIFIED");
  repo.saveNamedInsuredComparison(home.case_id,{verified:true,
    applicationDocumentId:"UISIGNED",applicationLogicalDocumentId:"UISIGNEDSEC",
    quoteDocumentId:"UIQUOTE",quoteLogicalDocumentId:"UIQUOTESEC",
    applicationNames:["SYNTHETIC PILOT CLIENT"],quoteNames:["SYNTHETIC PILOT CLIENT"]});
  repo.saveIntakeWarningFacts(home.case_id,{quote_issued_date:"2023-08-10",quote_bound:false});
  const bundle=pilot.exportCase(home.case_id,{id:"PILOT-BROKER-1",name:"Pilot Broker One"});

  const { chromium }=await import("playwright");
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  const browserIssues=[];
  page.on("pageerror",e=>browserIssues.push("pageerror: "+e.message));
  page.on("requestfailed",r=>browserIssues.push("requestfailed: "+r.method()+" "+r.url()+" "+r.failure()?.errorText));
  page.on("console",m=>{if(m.type()==="error")browserIssues.push("console: "+m.text());});
  // The heading is server-rendered BEFORE React attaches onChange handlers.
  // Wait for both client useEffect inbox requests as proof of hydration,
  // otherwise setInputFiles can silently dispatch before the handler exists.
  const hydratedInbox=Promise.all(["new-business","policy-change"].map(channel=>
    page.waitForResponse(r=>r.url()===api+"/inbox?system="+channel &&
      r.request().method()==="GET",{timeout:60000})));
  await page.goto(front+"/inbox",{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Authoritative submission inbox"}).waitFor();
  try {
    for(const response of await hydratedInbox){
      assert.equal(response.status(),200,"Hydrated inbox channel must be readable: "+response.url());
      assert(Array.isArray(await response.json()),"Hydrated inbox response must be an array");
    }
  } catch(error) {
    console.error("PILOT_BROWSER_HYDRATION_DEBUG: "+String(error));
    console.error("PILOT_BROWSER_UI_TEXT: "+(await page.locator("body").innerText().catch(()=>"unavailable")).slice(0,3000));
    console.error("PILOT_BROWSER_REQUESTS: "+JSON.stringify(browserIssues.slice(-18)));
    console.error("PILOT_BROWSER_BACKEND_LOG: "+back.log().slice(-3500));
    console.error("PILOT_BROWSER_FRONTEND_LOG: "+ui.log().slice(-3500));
    throw error;
  }
  // Assert the actual upload POST and authoritative server result below.
  const attempted=page.waitForResponse(r=>r.url().includes("/submissions/import")&&r.request().method()==="POST",
    {timeout:30000});
  await page.getByLabel("Import BDZIP package").setInputFiles({
    name:bundle.filename,mimeType:"application/zip",buffer:bundle.archive
  });
  try {
    const response=await attempted;
    const body=await response.text();
    assert.equal(response.status(),201,"Actual UI import rejected ("+response.url()+"): "+body.slice(0,2000));
    const result=JSON.parse(body);
    assert.equal(result.imported,true,"UI import must create the submitted Case");
    assert.equal(result.system,"new-business","Manifest must route into New Business inbox");
    await page.getByText(/Imported .* Routed into new-business/).waitFor({timeout:20000});
    await page.getByText(/Warnings \(1\)/).first().waitFor({timeout:20000});
  } catch(error) {
    console.error("PILOT_BROWSER_IMPORT_DEBUG: "+String(error));
    console.error("PILOT_BROWSER_UI_TEXT: "+(await page.locator("body").innerText().catch(()=>"unavailable")).slice(0,3500));
    console.error("PILOT_BROWSER_REQUESTS: "+JSON.stringify(browserIssues.slice(-18)));
    console.error("PILOT_BROWSER_BACKEND_LOG: "+back.log().slice(-4500));
    console.error("PILOT_BROWSER_FRONTEND_LOG: "+ui.log().slice(-4500));
    console.error("PILOT_BROWSER_DB_TASK_COUNT: "+pilot.listInbox("new-business").length);
    throw error;
  }
  await page.getByRole("button",{name:"Take Case"}).waitFor();
  await page.getByRole("button",{name:"Take Case"}).click();
  await page.getByRole("button",{name:"Open Case"}).waitFor();
  await page.getByRole("button",{name:"Open Case"}).click();
  await page.getByText("SYNTHETIC PILOT CLIENT").first().waitFor({timeout:60000});
  await page.getByRole("tab",{name:"Worksheet"}).waitFor({timeout:30000});
  await page.getByRole("heading",{name:/New Home.*Key-in data/}).waitFor({timeout:30000});
  await page.getByText("1 · Policy / quote / insured").waitFor();
  assert.equal(await page.getByRole("tab",{name:"Worksheet"}).getAttribute("data-state"),"active",
    "Auditor must open source-linked key-in worksheet by default, not Broker submission UI");
  assert.equal(await page.getByText("File intake & accuracy check").count(),0,
    "Broker-only intake workspace must not appear on the Auditor console");
  assert.equal(pilot.listInbox("new-business")[0].status,"in_progress");
  assert.equal(pilot.listInbox("policy-change").length,0);
  const legacyCaseId=pilot.listInbox("new-business")[0].case_id;
  assert.equal(repo.listDocuments(legacyCaseId).length,2);
  // An existing legacy Case with no reviewed snapshot is an empty optional
  // resource, not an HTTP failure that contaminates A–E browser acceptance.
  const legacyReview=await fetch(api+"/cases/"+legacyCaseId+"/reviewed-keyin");
  assert.equal(legacyReview.status,204,"Legacy Case must use no-content response.");
  const unknownReview=await fetch(api+"/cases/UNKNOWN-CASE-ID/reviewed-keyin");
  assert.equal(unknownReview.status,404,"Unknown Case must remain a real 404.");
  // V0.4 REAL INTEGRATION: Broker-reviewed cancellation travels through the UI
  // upload, import and Auditor worksheet. The existing v0.3 Home case above
  // confirms the legacy source-extraction workflow stays unconfirmed.
  const policy=createBlankPolicyChangeCase();
  const today=new Date().toISOString().slice(0,10);
  policy.policy.company="Intact";
  policy.policy.client_code="SYNV04UI";
  policy.policy.policy_number="SYNTHETIC-POLICY-UI";
  policy.policy.effective_date=today;
  policy.insured.name="SYNTHETIC POLICY PERSON";
  policy.insured.co_insured=[];
  policy.policy_change.transaction_types=["CANCELLATION"];
  policy.policy_change.requested_action="Cancellation";
  policy.policy_change.change_effective_date=today;
  policy.policy_change.requested_changes=[{
    id:"synthetic-cancel",type:"CANCELLATION",subject_name:"Whole policy",
    effective_date:today,new_value:"Cancel on requested effective date"
  }];
  policy.policy_change.notes="Hi U/W,\\nAs insured's request, please cancel the auto policy.\\nEffective date: "+today+".";
  repo.upsertCase({case:policy},"CREATE_CASE");
  addDocument(repo,policy,"UIV04REQ","CANCELLATION_REQUEST");
  repo.saveTransactionAuthorization(policy.case_id,{
    verified:true,documentId:"UIV04REQ",logicalDocumentId:"UIV04REQSEC",
    signers:[{name:"SYNTHETIC POLICY PERSON",documentId:"UIV04REQ",
      logicalDocumentId:"UIV04REQSEC",signaturePage:1,verified:true}]
  });
  const confirmation=new BrokerReviewService(db,repo);
  let reviewState=confirmation.create(policy.case_id,{actor:"PILOT-BROKER-1"});
  const originalRemarks=policy.policy_change.notes;
  const correctedRemarks="Hi U/W, As insured's request, please cancel the auto policy. Effective date: "+
    today+". Broker confirmed corrected Remarks.";
  reviewState=confirmation.edit(policy.case_id,{
    actor:"PILOT-BROKER-1",expectedRevision:reviewState.review.revision,
    fieldId:"remarks.text",value:correctedRemarks
  });
  assert.equal(repo.getCase(policy.case_id).policy_change.notes,originalRemarks,
    "Browser synthetic Broker Review must preserve the original local Case.");
  for(const section of reviewState.review.sections){
    reviewState=confirmation.confirm(policy.case_id,{
      actor:"PILOT-BROKER-1",expectedRevision:reviewState.review.revision,sectionId:section.id
    });
  }
  assert.equal(reviewState.ready,true,"All v0.4 Broker pages must be confirmed.");
  const v04Pilot=new SubmissionPilotService(db,paths,repo,{reviewedV04:true});
  const verifiedBundle=v04Pilot.exportCase(policy.case_id,{id:"PILOT-BROKER-1",name:"Pilot Broker One"});
  assert.equal(verifiedBundle.manifest.package_version,"0.4-reviewed-keyin");
  assert(readBdzip(verifiedBundle.archive).has("reviewed-keyin.json"));
  assert.equal(JSON.parse(readBdzip(verifiedBundle.archive).get("case.json").toString())
    .policy_change.notes,correctedRemarks);
  assert.equal(repo.getCase(policy.case_id).policy_change.notes,originalRemarks);
  const hydratedV04=Promise.all(["new-business","policy-change"].map(channel=>
    page.waitForResponse(response=>response.url()===api+"/inbox?system="+channel &&
      response.request().method()==="GET",{timeout:60000})));
  await page.goto(front+"/inbox",{waitUntil:"domcontentloaded"});
  await Promise.all(await hydratedV04);
  const v04ImportResponse=page.waitForResponse(response=>response.url().includes("/submissions/import") &&
    response.request().method()==="POST",{timeout:30000});
  await page.getByLabel("Import BDZIP package").setInputFiles({
    name:verifiedBundle.filename,mimeType:"application/zip",buffer:verifiedBundle.archive
  });
  const v04Resp=await v04ImportResponse;
  assert.equal(v04Resp.status(),201,
    "UI must accept the reviewed v0.4 BDZIP: "+(await v04Resp.text()).slice(0,1200));
  const v04Imported=await v04Resp.json();
  assert.equal(v04Imported.imported,true);
  assert.equal(v04Imported.system,"policy-change");
  assert.equal(repo.getCase(v04Imported.case_id).policy_change.notes,correctedRemarks);
  const confirmedReview=await fetch(api+"/cases/"+v04Imported.case_id+"/reviewed-keyin");
  assert.equal(confirmedReview.status,200,"Imported v0.4 must return the confirmed worksheet.");
  assert.equal((await confirmedReview.json()).sheet.brokerReview,"BROKER_CONFIRMED");
  await page.getByRole("heading",{name:"Policy Change queue"}).waitFor({timeout:30000});
  await page.getByRole("button",{name:"Take Case"}).click();
  await page.getByRole("button",{name:"Open Case"}).waitFor({timeout:30000});
  await page.getByRole("button",{name:"Open Case"}).click();
  await page.getByRole("heading",{name:"Ready-to-use Key-in Data"}).waitFor({timeout:60000});
  await page.getByText(/Broker confirmed corrected Remarks/).first().waitFor({timeout:15000});
  await page.getByRole("button",{name:"Copy all",exact:true}).waitFor();
  assert.equal(await page.getByText("Auditor · Broker-confirmed Key-in").count(),1);
  assert(await page.getByText("Copy section",{exact:true}).count()>=1);
  assert.equal(v04Pilot.readReviewedKeyin(v04Imported.case_id).sheet.brokerReview,"BROKER_CONFIRMED");

  // STEP4B_BROWSER: render a synthetic two-car/two-driver v0.4 worksheet via
  // a mocked GET response on the ACTUAL Auditor Case page. This verifies the
  // React view while the earlier real imported policy-change path verifies
  // package hashes, SQLite and authoritative Auditor API separately.
  const syntheticRow=(id,label,value)=>({
    id,label,originalValue:value,value:typeof value==="string"?value:JSON.stringify(value),
    evidencePresent:true
  });
  const syntheticSection=(id,title,rows)=>({id,title,rows});
  const structuredSynthetic={
    packageId:"SYNTHETIC-STEP4B-UI",brokerId:"PILOT-BROKER-1",
    finalizedAt:new Date().toISOString(),reviewedHash:"SYNTHETIC-REVIEW-HASH",
    sheet:{
      sourceCaseId:policy.case_id,sourceReviewHash:"SYNTHETIC-REVIEW-HASH",
      brokerReview:"BROKER_CONFIRMED",
      sections:[
        syntheticSection("policy","Policy",[
          syntheticRow("policy.insured","Named Insured","SYNTHETIC POLICY PERSON")
        ]),
        syntheticSection("drivers","Drivers",[
          syntheticRow("driver:D1.name","Driver 1 · Name","Synthetic John"),
          syntheticRow("driver:D2.name","Driver 2 · Name","Synthetic Jane"),
        ]),
        syntheticSection("vehicles","Vehicles",[
          syntheticRow("vehicle:V1.year","VIN-A · Year",2026),
          syntheticRow("vehicle:V1.make","VIN-A · Make","BMW"),
          syntheticRow("vehicle:V1.model","VIN-A · Model","X1"),
          syntheticRow("vehicle:V1.vin","VIN-A · VIN","SYNTHETIC-VIN-A"),
          syntheticRow("vehicle:V1.driverAssignments","VIN-A · Assigned Drivers",
            [{driverId:"D1",role:"PRINCIPAL"}]),
          syntheticRow("vehicle:V2.year","VIN-B · Year",2019),
          syntheticRow("vehicle:V2.make","VIN-B · Make","Nissan"),
          syntheticRow("vehicle:V2.model","VIN-B · Model","Rogue"),
          syntheticRow("vehicle:V2.vin","VIN-B · VIN","SYNTHETIC-VIN-B"),
          syntheticRow("vehicle:V2.driverAssignments","VIN-B · Assigned Drivers",
            [{driverId:"D2",role:"SECONDARY"}]),
        ]),
        syntheticSection("coverage","Coverage",[
          syntheticRow("vehicle:V1.liability","VIN-A · Liability",1000000),
          syntheticRow("vehicle:V1.opcf","VIN-A · Selected OPCF",["20","27"]),
          syntheticRow("vehicle:V2.liability","VIN-B · Liability",2000000),
          syntheticRow("vehicle:V2.opcf","VIN-B · Selected OPCF",["43"]),
          syntheticRow("quoteDiscount:winter.selected","Quote Discount: Winter Tires",true)
        ]),
        syntheticSection("history","MVR / DASH / Prior Insurance",[
          syntheticRow("report:mvr:M1.pulledDate","MVR Pulled Date","2026-10-02"),
          syntheticRow("report:mvr:M1.summary","MVR Summary",{
            hasConvictions:true,convictions:[{
              offenceDate:"2024-04-11",description:"Synthetic speeding",classification:"Minor"
            }]
          }),
          syntheticRow("report:mvr:M2.pulledDate","MVR Pulled Date","2026-10-03"),
          syntheticRow("report:mvr:M2.summary","MVR Summary",{
            hasConvictions:false,convictions:[]
          }),
          syntheticRow("report:dash:H1.pulledDate","DASH Pulled Date","2026-10-04"),
          syntheticRow("report:dash:H1.summary","DASH Summary",{
            hasClaims:true,claims:[
              {claimNumber:"SYN-CLM-1",lossDate:"2022-01-03",driver:"Synthetic John",
               vehicle:"SYNTHETIC-VIN-A",atFaultPercent:0},
              {claimNumber:"SYN-CLM-2",lossDate:"2023-02-04",driver:"Synthetic Jane",
               vehicle:"SYNTHETIC-VIN-B",atFaultPercent:75}
            ]
          }),
          syntheticRow("prior.insurer","Prior Insurer","Synthetic Prior Carrier")
        ]),
        syntheticSection("changes","Requested Changes / Before -> After",[
          syntheticRow("change:1.type","Change · Type","VEHICLE_SUBSTITUTION"),
          syntheticRow("change:1.before","Change · Before","2019 Nissan"),
          syntheticRow("change:1.after","Change · After","2026 BMW X1"),
        ]),
        syntheticSection("remarks","UW Remarks",[
          syntheticRow("remarks.text","UW Remarks","Hi U/W,\nSynthetic line two\nEnd.")
        ])
      ]
    }
  };
  await page.route(api+"/cases/"+v04Imported.case_id+"/reviewed-keyin",route=>
    route.fulfill({status:200,headers:{"access-control-allow-origin":"*",
      "content-type":"application/json"},body:JSON.stringify(structuredSynthetic)}));
  const mockedResponse=page.waitForResponse(resp=>resp.url()===
    api+"/cases/"+v04Imported.case_id+"/reviewed-keyin",{timeout:30000});
  await page.reload({waitUntil:"domcontentloaded"});
  await mockedResponse;
  await page.getByRole("heading",{name:"Ready-to-use Key-in Data"}).waitFor({timeout:30000});
  const syntheticVehicles=page.locator('section[aria-label="Vehicles / Assigned Drivers / Coverage"]');
  await syntheticVehicles.waitFor();
  const carCards=syntheticVehicles.locator("article.auditor-worksheet-entity");
  assert.equal(await carCards.count(),2,"Two vehicles must render in different Auditor cards");
  assert.match(await carCards.nth(0).innerText(),/2026 BMW X1/);
  assert.match(await carCards.nth(0).innerText(),/1000000/);
  assert.match(await carCards.nth(0).innerText(),/Synthetic John/);
  assert.doesNotMatch(await carCards.nth(0).innerText(),/2000000/);
  assert.match(await carCards.nth(1).innerText(),/2019 Nissan Rogue/);
  assert.match(await carCards.nth(1).innerText(),/2000000/);
  assert.match(await carCards.nth(1).innerText(),/Synthetic Jane/);
  assert.doesNotMatch(await carCards.nth(1).innerText(),/1000000/);
  const historyCard=page.locator('section[aria-label="MVR / DASH / Prior Insurance"]');
  assert.match(await historyCard.innerText(),/Synthetic speeding/);
  assert.match(await historyCard.innerText(),/SYN-CLM-1/);
  assert.match(await historyCard.innerText(),/0%/);
  assert.match(await historyCard.innerText(),/75%/);
  const remarkCard=page.locator('section[aria-label="UW Remarks"]');
  assert.match(await remarkCard.innerText(),/Synthetic line two/);
  assert.equal(await page.getByText("Copy section",{exact:true}).count(),7);
  console.log("Step 4B synthetic two-vehicle structured Chromium view: PASS");

  assert.equal(browserIssues.filter(x=>x.includes("pageerror")).length,0,
    "Reviewed v0.4 UI cannot cause a browser JavaScript exception: "+browserIssues.slice(-8));

  await context.close();
  console.log("Pilot Auditor inbox Chromium smoke: PASS (legacy v0.3 + Broker-reviewed v0.4)");

} finally {
  await browser?.close().catch(()=>{});
  db?.close();
  for(const p of children.reverse()) {
    if(p.exitCode===null){p.kill();await delay(450);}
  }
  rmSync(temp,{recursive:true,force:true});
}

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
  assert.equal(repo.listDocuments(pilot.listInbox("new-business")[0].case_id).length,2);
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
  await page.getByRole("heading",{name:"Policy Change queue"}).waitFor({timeout:30000});
  await page.getByRole("button",{name:"Take Case"}).click();
  await page.getByRole("button",{name:"Open Case"}).waitFor({timeout:30000});
  await page.getByRole("button",{name:"Open Case"}).click();
  await page.getByRole("heading",{name:"Key-in data — Broker confirmed"}).waitFor({timeout:60000});
  await page.getByRole("button",{name:"Copy all Key-in data"}).waitFor();
  assert.equal(await page.getByText("Auditor · Imported Broker review").count(),1);
  assert.equal(await page.getByText("Copy section",{exact:true}).count(),
    reviewState.review.sections.length);
  assert.equal(v04Pilot.readReviewedKeyin(v04Imported.case_id).sheet.brokerReview,"BROKER_CONFIRMED");
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

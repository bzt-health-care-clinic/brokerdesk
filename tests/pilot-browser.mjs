// Synthetic UI smoke of the ACTUAL Auditor inbox, local ZIP and Case opening.
// No customer uploads, keys, email or LAN services are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createBlankHabCase } from "../lib/case-factories.ts";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { SubmissionPilotService } from "../local-server/submission-service.mjs";

const front="http://127.0.0.1:5193",api="http://127.0.0.1:47843";
const temp=mkdtempSync(join(tmpdir(),"bd-pilot-ui-"));
const root=resolve(new URL("../", import.meta.url).pathname.replace(/^\/(\w):\//,"$1:/"));
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
  const bundle=pilot.exportCase(home.case_id,{id:"PILOT-BROKER-1",name:"Pilot Broker One"});

  const { chromium }=await import("playwright");
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(front+"/inbox",{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Authoritative submission inbox"}).waitFor();
  await page.getByLabel("Import BDZIP package").setInputFiles({
    name:bundle.filename,mimeType:"application/zip",buffer:bundle.archive
  });
  await page.getByText(/Imported .* Routed into new-business/).waitFor({timeout:60000});
  await page.getByRole("button",{name:"Take Case"}).waitFor();
  await page.getByRole("button",{name:"Take Case"}).click();
  await page.getByRole("button",{name:"Open Case"}).waitFor();
  await page.getByRole("button",{name:"Open Case"}).click();
  await page.getByText("SYNTHETIC PILOT CLIENT").first().waitFor({timeout:60000});
  assert.equal(pilot.listInbox("new-business")[0].status,"in_progress");
  assert.equal(pilot.listInbox("policy-change").length,0);
  assert.equal(repo.listDocuments(pilot.listInbox("new-business")[0].case_id).length,2);
  await context.close();
  console.log("Pilot Auditor inbox Chromium smoke: PASS");
} finally {
  await browser?.close().catch(()=>{});
  db?.close();
  for(const p of children.reverse()) {
    if(p.exitCode===null){p.kill();await delay(450);}
  }
  rmSync(temp,{recursive:true,force:true});
}

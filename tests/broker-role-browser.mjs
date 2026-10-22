// Browser role-isolation smoke: Broker can verify files without the Auditor key-in workspace.
// Synthetic local-only; no real insured information or external OCR requests.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const front="http://127.0.0.1:5194",api="http://127.0.0.1:47844";
const temp=mkdtempSync(join(tmpdir(),"bd-broker-role-ui-"));
const root=fileURLToPath(new URL("../",import.meta.url));
const env=Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","COMSPEC",
  "PATHEXT","USERPROFILE","HOME","APPDATA","LOCALAPPDATA"]
  .filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{BROKERDESK_DATA_DIR:temp,BROKERDESK_LOCAL_API_PORT:"47844",
  NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL:api,BROKERDESK_LOCAL_FRONTEND_ORIGIN:front,
  NEXT_PUBLIC_BROKERDESK_MODE:"broker",BROKERDESK_MODE:"broker",
  BROKERDESK_FAST_LOCAL:"true",NEXT_TELEMETRY_DISABLED:"1"});
const children=[];let browser;
function start(args){
  let log="";
  const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",v=>log+=v.toString());
  child.stderr.on("data",v=>log+=v.toString());
  children.push(child);return{child,log:()=>log};
}
async function until(fn,description,timeout=75000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    if(await fn().catch(()=>false))return;
    await delay(200);
  }
  throw Error("Timed out waiting for "+description);
}
try{
  const backend=start(["local-server/server.mjs"]);
  const frontend=start(["scripts/run-framework.mjs","dev","--port","5194","--hostname","127.0.0.1"]);
  await until(async()=> (await fetch(api+"/health")).ok,"Broker local API");
  await until(async()=> (await fetch(front)).ok,"Broker UI");
  const {chromium}=await import("playwright");
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.goto(front,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"No case selected"}).waitFor();
  await page.getByRole("button",{name:"Create a new case"}).count(); // role is either landing New case or header
  await page.getByRole("button",{name:/New case/i}).last().click();
  await page.getByRole("heading",{name:"File intake & accuracy check"}).waitFor({timeout:30000});
  await page.getByLabel("Broker insurer").fill("Intact");
  await page.getByLabel("Broker named insured").fill("SYNTHETIC BROKER CASE");
  assert.equal(await page.getByRole("tab",{name:"Worksheet"}).count(),0);
  assert.equal(await page.getByText("QA review",{exact:true}).count(),0);
  assert.equal(await page.getByRole("button",{name:"Start key-in"}).count(),0);
  assert.equal(await page.getByRole("heading",{name:"File intake & accuracy check"}).count(),1);
  await page.getByText("Saved",{exact:true}).first().waitFor({timeout:15000});
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"File intake & accuracy check"}).waitFor();
  assert.equal(await page.getByLabel("Broker insurer").inputValue(),"Intact");
  assert.equal(await page.getByLabel("Broker named insured").inputValue(),"SYNTHETIC BROKER CASE");
  // Step 2 must actually open in Broker mode, persist a field and reload from local SQLite.
  const savedCaseId=await page.evaluate(()=>window.localStorage.getItem("brokerdesk.lastCaseId"));
  assert.match(savedCaseId??"",/^[A-Za-z0-9_-]+$/);
  await page.goto(front+"/broker-review?caseId="+encodeURIComponent(savedCaseId),{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Broker Key-in Review"}).waitFor({timeout:30000});
  await page.getByRole("button",{name:"Create Review Draft"}).click();
  await page.getByRole("navigation",{name:"Broker Review pages"}).waitFor({timeout:30000});
  const insuredInput=page.getByRole("textbox",{name:"Named Insured"});
  await insuredInput.fill("SYNTHETIC REVIEWED CLIENT");
  await insuredInput.blur();
  await page.getByText("Named Insured saved.",{exact:true}).waitFor({timeout:15000});
  await page.reload({waitUntil:"domcontentloaded"});
  await page.getByRole("navigation",{name:"Broker Review pages"}).waitFor({timeout:30000});
  assert.equal(await page.getByRole("textbox",{name:"Named Insured"}).inputValue(),"SYNTHETIC REVIEWED CLIENT");
  assert.equal(await page.getByText(/current BDZIP still uses the Step 1 package format/i).count(),1);
  await page.goto(front,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"File intake & accuracy check"}).waitFor({timeout:30000});
  // Broker can create Home Policy Change without receiving the Auditor editing UI.
  await page.getByRole("button",{name:"Home Policy Change"}).click();
  await page.getByRole("button",{name:"Create a new case"}).click();
  await page.getByLabel("Broker policy change type").waitFor();
  await page.getByLabel("Broker policy change type").selectOption("CANCELLATION");
  assert.equal(await page.getByLabel("Broker policy change type").inputValue(),"CANCELLATION");
  assert.equal(await page.getByRole("tab",{name:"Worksheet"}).count(),0);
  assert.equal(await page.getByRole("heading",{name:"File intake & accuracy check"}).count(),1);
  await browser.close();browser=null;
  console.log("Broker-only file intake Chromium role isolation: PASS");
}catch(e){
  console.error("Broker role smoke ERROR:",String(e));
  throw e;
}finally{
  await browser?.close().catch(()=>{});
  for(const child of children.reverse()){
    if(child.exitCode!==null || child.signalCode!==null)continue;
    if(!child.killed)child.kill();
    try{
      await Promise.race([
        new Promise(resolve=>{
          if(child.exitCode!==null || child.signalCode!==null)return resolve();
          child.once("exit",resolve);
        }),
        delay(2500)
      ]);
    }catch{}
  }
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}

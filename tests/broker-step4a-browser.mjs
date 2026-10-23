/**
 * Step 4A Chromium smoke: exercise the real React MVR/DASH form controls.
 * All fields and responses are synthetic, with an isolated mocked local API.
 * Complements SQLite/BDZIP tests; does not claim actual insurer report parsing.
 */
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";

const front="http://127.0.0.1:5197",api="http://127.0.0.1:47847";
const root=fileURLToPath(new URL("../",import.meta.url));
const temp=mkdtempSync(join(tmpdir(),"bd-step4a-browser-"));
const env=Object.fromEntries(["PATH","Path","SystemRoot","WINDIR","TEMP","TMP","COMSPEC",
  "PATHEXT","USERPROFILE","HOME","APPDATA","LOCALAPPDATA"]
  .filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
Object.assign(env,{BROKERDESK_DATA_DIR:temp,BROKERDESK_LOCAL_API_PORT:"47847",
  NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL:api,BROKERDESK_LOCAL_FRONTEND_ORIGIN:front,
  NEXT_PUBLIC_BROKERDESK_MODE:"broker",BROKERDESK_MODE:"broker",
  BROKERDESK_FAST_LOCAL:"true",NEXT_TELEMETRY_DISABLED:"1"});
const children=[];let browser;
function start(args) {
  let output="";
  const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",v=>output+=v.toString());
  child.stderr.on("data",v=>output+=v.toString());
  children.push(child);
  return ()=>output;
}
async function until(fn,label,timeout=80000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(await fn().catch(()=>false))return;
    await delay(200);
  }
  throw Error("Step 4A timeout: "+label);
}

const state={
  review:{
    revision:1,review_status:"DRAFT",company:"Intact",case_type:"new_auto",
    sections:[
      {id:"history",title:"MVR / DASH",status:"PENDING",confirmation:null},
      {id:"final",title:"Final Submission",status:"PENDING",confirmation:null}
    ],
    fields:[
      {id:"report:mvr:synthetic-mvr.summary",section:"history",
        label:"MVR Convictions / Claims",type:"record",value:null,required:true,
        origin:"CASE_UNVERIFIED",evidence:[],conflict:false},
      {id:"report:mvr:synthetic-mvr.pulledDate",section:"history",
        label:"MVR Pulled Date",type:"date",value:"2026-10-20",required:true},
      {id:"report:dash:synthetic-dash.summary",section:"history",
        label:"DASH Convictions / Claims",type:"record",value:null,required:true,
        origin:"CASE_UNVERIFIED",evidence:[],conflict:false},
      {id:"report:dash:synthetic-dash.pulledDate",section:"history",
        label:"DASH Pulled Date",type:"date",value:"2026-10-20",required:true}
    ]
  },
  sourceIssues:[],fieldIssues:[],confirmed:0,total:2,ready:false
};
const edits=[];let confirmations=0;
const header={
  "access-control-allow-origin":"*",
  "access-control-allow-headers":"content-type",
  "access-control-allow-methods":"GET,PATCH,POST,OPTIONS",
  "content-type":"application/json"
};
try {
  const frontLogs=start(["scripts/run-framework.mjs","dev","--port","5197","--hostname","127.0.0.1"]);
  await until(async()=>(await fetch(front+"/broker-review?caseId=SYN4A")).ok,"Broker Review frontend",90000);
  const {chromium}=await import("playwright");
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  page.setDefaultTimeout(25000);
  await page.route(api+"/cases/SYN4A/broker-review**",async route=>{
    const request=route.request(),method=request.method();
    if(method==="OPTIONS"){
      await route.fulfill({status:204,headers:header,body:""});return;
    }
    const pathname=new URL(request.url()).pathname;
    if(method==="PATCH"&&pathname.endsWith("/fields")){
      const body=request.postDataJSON();
      assert.equal(body.expectedRevision,state.review.revision);
      const f=state.review.fields.find(f=>f.id===body.fieldId);
      assert(f,"Review field not found");
      f.value=body.value;state.review.revision++;edits.push(body);
    } else if(method==="POST"&&pathname.endsWith("/sections")){
      confirmations++;
    } else if(method!=="GET") {
      await route.fulfill({status:405,headers:header,body:JSON.stringify({error:"Unsupported synthetic request"})});return;
    }
    await route.fulfill({status:200,headers:header,body:JSON.stringify(state)});
  });
  await page.goto(front+"/broker-review?caseId=SYN4A",{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Broker Key-in Review"}).waitFor();
  await page.getByRole("navigation",{name:"Broker Review pages"}).waitFor();
  const mvr=page.locator('[data-broker-report-editor="mvr"]');
  const dash=page.locator('[data-broker-report-editor="dash"]');
  await mvr.waitFor();await dash.waitFor();
  assert.equal(await mvr.getByLabel("MVR reported result").inputValue(),"");
  assert.equal(await dash.getByLabel("DASH reported result").inputValue(),"");
  assert.equal(await mvr.getByRole("textbox",{name:/JSON/i}).count(),0);
  await mvr.getByLabel("MVR reported result").selectOption("yes");
  await mvr.getByRole("button",{name:"Add Conviction"}).click();
  assert.equal(await page.getByRole("button",{name:/2\. Final Submission/}).isDisabled(),true);
  assert.equal(await page.getByRole("button",{name:"Confirm this page"}).isDisabled(),true);
  await mvr.getByLabel("MVR Offence Date 1").fill("2026-05-01");
  await mvr.getByLabel("MVR Classification (Minor / Major / offence type) 1").fill("Minor");
  await mvr.getByLabel("MVR Offence Description 1").fill("Synthetic speeding");
  await mvr.getByRole("button",{name:"Save report"}).click();
  await until(()=>edits.length===1,"MVR field PATCH");
  assert.equal(edits[0].fieldId,"report:mvr:synthetic-mvr.summary");
  assert.equal(edits[0].value.hasConvictions,true);
  assert.equal(edits[0].value.convictions.length,1);
  await until(async()=>await page.getByRole("button",{name:"Confirm this page"}).isEnabled(),"MVR save clearing dirty");

  await dash.getByLabel("DASH reported result").selectOption("yes");
  await dash.getByRole("button",{name:"Add Claim"}).click();
  await dash.getByLabel("DASH Claim # 1").fill("SYN-CLAIM-1");
  await dash.getByLabel("DASH Loss Date 1").fill("2026-02-02");
  await dash.getByLabel("DASH Driver at time of loss 1").fill("Synthetic Driver");
  await dash.getByLabel("DASH Vehicle (if known) 1").fill("Synthetic Vehicle");
  await dash.getByLabel("DASH At-fault % 1").fill("0");
  assert.equal(await page.getByRole("button",{name:/2\. Final Submission/}).isDisabled(),true);
  await dash.getByRole("button",{name:"Save report"}).click();
  await until(()=>edits.length===2,"DASH field PATCH");
  assert.equal(edits[1].fieldId,"report:dash:synthetic-dash.summary");
  assert.equal(edits[1].value.hasClaims,true);
  assert.equal(edits[1].value.claims[0].atFaultPercent,0);
  await until(async()=>await page.getByRole("button",{name:"Confirm this page"}).isEnabled(),"DASH save clearing dirty");
  await page.reload({waitUntil:"domcontentloaded"});
  await mvr.waitFor();await dash.waitFor();
  assert.equal(await mvr.getByLabel("MVR reported result").inputValue(),"yes");
  assert.equal(await mvr.getByLabel("MVR Offence Description 1").inputValue(),"Synthetic speeding");
  assert.equal(await dash.getByLabel("DASH At-fault % 1").inputValue(),"0");
  await dash.getByLabel("DASH Driver at time of loss 1").fill("Unsaved change");
  assert.equal(await page.getByRole("button",{name:"Confirm this page"}).isDisabled(),true);
  assert.equal(await page.getByRole("button",{name:/2\. Final Submission/}).isDisabled(),true);
  assert.equal(confirmations,0);
  await browser.close();browser=null;
  console.log("Broker Step 4A MVR/DASH Chromium interactions: PASS");
}catch(e){
  console.error("Step 4A browser smoke error:",String(e));
  throw e;
}finally{
  await browser?.close().catch(()=>{});
  for(const child of children.reverse()){
    if(child.exitCode!==null||child.signalCode!==null)continue;
    child.kill();
    await Promise.race([
      new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();
        child.once("exit",resolve);}),
      delay(2000)
    ]);
  }
  rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}

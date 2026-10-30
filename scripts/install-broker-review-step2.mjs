/**
 * Installs minimal Step 2 integration hooks against commit 770b786 or a
 * descendant. Existing database, Inbox, and BDZIP files are not changed.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root=process.cwd(),dry=process.argv.includes("--dry-run");
const changed=[];
if(Number(process.versions.node.split(".")[0])<22)
  throw new Error("Node.js 22+ is required.");
for(const name of [
  "lib/broker-keyin-review.mjs","local-server/broker-review-store.mjs",
  "local-server/broker-review-integration.mjs","app/broker-review/page.tsx"
]) {
  if(!existsSync(resolve(root,name)))throw new Error("Required file missing: "+name);
}
const check=spawnSync("git",["merge-base","--is-ancestor","770b786","HEAD"],{cwd:root});
if(check.status!==0)throw new Error("Current branch must contain Step 1 commit 770b786.");
const targets=[
  "local-server/server.mjs",
  "components/submission-panel.tsx",
  "components/broker-intake-panel.tsx",
  "app/page.tsx"
];
const installed=[
  ["local-server/server.mjs",["STEP2_BROKER_REVIEW_IMPORT","STEP2_BROKER_REVIEW_SERVICE","STEP2_BROKER_REVIEW_ROUTE"]],
  ["components/submission-panel.tsx",["STEP2_BROKER_REVIEW_LINK"]],
  ["components/broker-intake-panel.tsx",["Broker checks originals here, then confirms"]],
  ["app/page.tsx",["Check originals and confirm every applicable Key-in"]]
].every(([name,markers])=>{
  const value=readFileSync(resolve(root,name),"utf8");
  return markers.every(marker=>value.includes(marker));
});
if(installed) {
  console.log("Step 2 hooks already installed; no existing files changed.");
  process.exit(0);
}
const dirty=execFileSync("git",["status","--porcelain","--",...targets],{cwd:root,encoding:"utf8"});
if(dirty.trim())throw new Error("Commit or stash modifications to existing integration targets first:\n"+dirty);
const staged = new Map();
function patch(file,anchor,replacement,marker) {
  const full=resolve(root,file);
  if(!existsSync(full))throw new Error("Cannot locate "+file);
  const old=staged.get(file)??readFileSync(full,"utf8");
  if(old.includes(marker))return;
  const occurrences=old.split(anchor).length-1;
  if(occurrences!==1)throw new Error(`Unexpected ${file} layout: anchor count ${occurrences}. No files written.`);
  staged.set(file,old.replace(anchor,replacement));
  changed.push(file);
}
patch("local-server/server.mjs",
  'import { localAllowedOrigins } from "./origins.mjs";',
  'import { localAllowedOrigins } from "./origins.mjs";\nimport { BrokerReviewService } from "./broker-review-integration.mjs"; // STEP2_BROKER_REVIEW_IMPORT',
  "STEP2_BROKER_REVIEW_IMPORT");
patch("local-server/server.mjs",
  "const pilot = new SubmissionPilotService(db, paths, repositories);",
  "const pilot = new SubmissionPilotService(db, paths, repositories);\nconst brokerReview = new BrokerReviewService(db, repositories); // STEP2_BROKER_REVIEW_SERVICE",
  "STEP2_BROKER_REVIEW_SERVICE");
const hook=`    // STEP2_BROKER_REVIEW_ROUTE: Broker-only local drafts, not a BDZIP approval.
    const reviewRoute = url.pathname.match(/^\\/cases\\/([A-Za-z0-9_-]+)\\/broker-review(?:\\/(rebuild|fields|sections|remarks-preview))?$/);
    if (reviewRoute) {
      if (!brokerOnly) return sendJson(response, request, 403, { error: "Broker Review is only available in Broker mode." });
      const result = brokerReview.handle(reviewRoute[1], reviewRoute[2] || "",
        request.method, ["GET","HEAD"].includes(request.method) ? null : await readJson(request));
      return sendJson(response, request, result.status, result.body);
    }
`;
patch("local-server/server.mjs",
  "    const preflight = url.pathname.match(/^\\/cases\\/([A-Za-z0-9_-]+)\\/preflight$/);",
  hook+"    const preflight = url.pathname.match(/^\\/cases\\/([A-Za-z0-9_-]+)\\/preflight$/);",
  "STEP2_BROKER_REVIEW_ROUTE");
patch("components/submission-panel.tsx",
  '      <small>Intake profile v1 · Manual email attachment</small>\n    </div>',
  '      <small>Intake profile v1 · Manual email attachment</small>\n    </div>\n'+
  '    {/* STEP2_BROKER_REVIEW_LINK: draft is NOT in BDZIP until Step 3. */}\n'+
  '    <p><a href={`/broker-review?caseId=${encodeURIComponent(data.case_id)}`} className="underline font-semibold">Open Broker Key-in Review pages</a></p>',
  "STEP2_BROKER_REVIEW_LINK");
patch("components/broker-intake-panel.tsx",
  "        The Auditor will extract, organize and key in detailed insurance information.\n        Do not enter full MVR, coverage or payment details here.",
  "        Broker checks originals here, then confirms the complete Key-in fields in Broker Review.\n        The Auditor will use Broker-confirmed information after the reviewed BDZIP integration.",
  "Broker checks originals here, then confirms");
patch("app/page.tsx",
  "Check source completeness, client / VIN identity and signed evidence; Auditor handles full Key-in.",
  "Check originals and confirm every applicable Key-in section before handing the worksheet to Auditor.",
  "Check originals and confirm every applicable Key-in");
if(dry){
  console.log("Dry run: would change "+[...new Set(changed)].join(", "));
  process.exit(0);
}
for(const [file,contents] of staged)
  writeFileSync(resolve(root,file),contents,"utf8");
console.log("Step 2 integrated: "+[...staged.keys()].join(", "));

#!/usr/bin/env node
/**
 * Apply Step 4A only to the Broker Review page. Never overwrite the file.
 * Dry-run checks the exact anchors first; install is idempotent.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const root=process.cwd();
const target=resolve(root,"app/broker-review/page.tsx");
const required=[
  "components/broker-review-report-editor.tsx",
  "lib/broker-review-report-form.mjs",
  "lib/broker-review-report-form.d.mts"
];
const dryRun=process.argv.includes("--dry-run");
const marker='import BrokerReviewReportEditor from "@/components/broker-review-report-editor";';

const modifications=[
  [
    'import { brokerReviewClient, type BrokerReview, type BrokerReviewStatus, type ReviewField } from "@/lib/broker-review-client";',
    'import { brokerReviewClient, type BrokerReview, type BrokerReviewStatus, type ReviewField } from "@/lib/broker-review-client";\n'+
    marker+'\n'+
    'import { reportKind } from "@/lib/broker-review-report-form.mjs";'
  ],
  [
    '  const [busy,setBusy]=useState(false);',
    '  const [busy,setBusy]=useState(false);\n'+
    '  const [reportDirtyIds,setReportDirtyIds]=useState<string[]>([]);\n'+
    '  const markReportDirty=useCallback((fieldId:string,dirty:boolean)=>{\n'+
    '    setReportDirtyIds(old=>dirty?(old.includes(fieldId)?old:[...old,fieldId]):old.filter(id=>id!==fieldId));\n'+
    '  },[]);'
  ],
  [
    '  const hasDirty=Object.keys(draft).length>0;',
    '  const hasDirty=Object.keys(draft).length>0||reportDirtyIds.length>0;\n'+
    '  useEffect(()=>{\n'+
    '    if(!hasDirty)return;\n'+
    '    const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue="";};\n'+
    '    window.addEventListener("beforeunload",warn);\n'+
    '    return ()=>window.removeEventListener("beforeunload",warn);\n'+
    '  },[hasDirty]);'
  ],
  [
    '    if(!caseId||!currentRef.current?.review)return;',
    '    if(!caseId||!currentRef.current?.review)return false;'
  ],
  [
    '    if(submitting.current)return;',
    '    if(submitting.current)return false;'
  ],
  [
    '      setNotice(`${field.label} saved.`);',
    '      setNotice(`${field.label} saved.`);\n      return true;'
  ],
  [
    '    }catch(e){setError(readError(e));}\n    finally {setSavingField(null);submitting.current=false;}',
    '    }catch(e){setError(readError(e));return false;}\n    finally {setSavingField(null);submitting.current=false;}'
  ],
  [
    '  const fieldInput=(field:ReviewField)=>{\n',
    '  const fieldInput=(field:ReviewField)=>{\n'+
    '    const reportType=field.type==="record"?reportKind(field.id):null;\n'+
    '    if(reportType)return <BrokerReviewReportEditor\n'+
    '      key={field.id} fieldId={field.id} kind={reportType}\n'+
    '      value={field.value} disabled={busy||Boolean(savingField)||stale}\n'+
    '      onSave={v=>persist(field,v)} onDirtyChange={markReportDirty}/>;\n'
  ]
];
try {
  for (const rel of required)
    if (!existsSync(resolve(root,rel)))
      throw Error(`Missing new file ${rel}. Extract the entire ZIP at repository root first.`);
  const before=readFileSync(target,"utf8");
  if (before.includes(marker)) {
    const checks=[
      "reportDirtyIds.length>0",
      "onDirtyChange={markReportDirty}",
      "return true;",
      'import { reportKind } from "@/lib/broker-review-report-form.mjs";'
    ];
    if (!checks.every(check=>before.includes(check)))
      throw Error("Step 4A seems partially installed; check git diff before proceeding.");
    console.log("Step 4A already installed; no file changes.");
    process.exit(0);
  }
  let after=before;
  for (const [original,replacement] of modifications) {
    const first=after.indexOf(original);
    if(first<0||after.indexOf(original,first+original.length)>=0)
      throw Error(`Expected unique anchor not found in Broker Review page:\n${original.slice(0,150)}`);
    after=after.replace(original,replacement);
  }
  if(dryRun) {
    console.log("Step 4A dry-run: all required files and exact page anchors found. No files changed.");
    process.exit(0);
  }
  const temp=join(dirname(target),`.page.tsx.step4a-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp,after,{encoding:"utf8",flag:"wx"});
    renameSync(temp,target);
  } catch (e) {
    if(existsSync(temp))unlinkSync(temp);
    throw e;
  }
  console.log("Step 4A installed in app/broker-review/page.tsx. Review git diff and run tests.");
} catch (e) {
  console.error("Step 4A refused to modify the page:",e.message);
  process.exitCode=1;
}

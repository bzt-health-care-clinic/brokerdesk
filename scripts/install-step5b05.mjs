#!/usr/bin/env node
/**
 * Step 5B-05 installer. Refuses to edit unknown upstream sources.
 * Supports --dry-run; idempotent after verified full installation.
 */
import {readFileSync as nativeReadFileSync,writeFileSync as nativeWriteFileSync,existsSync,renameSync,unlinkSync} from "node:fs";
// Installer-only newline adapter: exact anchors are checked against Git-blob LF,
// while original Windows CRLF source bytes are preserved on writes and rollback.
const sourceNewlines = new Map();
const sourceKey = path => String(path).replace(/\.step5b\d{2}\.tmp$/, "");
function readFileSync(path, ...args) {
  const value = nativeReadFileSync(path, ...args);
  if (typeof value !== "string") return value;
  sourceNewlines.set(sourceKey(path), value.includes("\r\n") ? "\r\n" : "\n");
  return value.replace(/\r\n/g, "\n");
}
function writeFileSync(path, value, ...args) {
  const ending = sourceNewlines.get(sourceKey(path));
  const source = ending === "\r\n" && typeof value === "string"
    ? value.replace(/\r?\n/g, "\r\n") : value;
  return nativeWriteFileSync(path, source, ...args);
}

import {resolve} from "node:path";
const root=resolve(process.cwd()),dry=process.argv.includes("--dry-run");
const mark="STEP5B05_DIAGNOSTICS";
const rel="components/ingestion-panel.tsx";
const file=resolve(root,rel);
try{
  if(!existsSync(file)||!existsSync(resolve(root,"lib/step5b05-diagnostics.ts")))
    throw Error("Missing source component or diagnostics helper.");
  const before=readFileSync(file,"utf8");
  if(before.includes(mark)){
    if(!before.includes('buildDocumentDiagnostics(record)') ||
        !before.includes('import { buildDocumentDiagnostics }'))
      throw Error("Partial Step 5B-05 installation; abort.");
    console.log("STEP5B05 ALREADY INSTALLED");process.exit(0);
  }
  const anchor='import { documentOcrUi } from "@/lib/document-ocr-ui";';
  if(before.split(anchor).length!==2)throw Error("Diagnostics import anchor mismatch.");
  const lines=before.split("\n");
  const index=lines.findIndex(line=>line.includes('{record.raw?.metadata && <details className="ocr-diagnostics">'));
  if(index<0||lines.filter(line=>line.includes('className="ocr-diagnostics"')).length!==1 ||
     !lines[index].includes('requestSucceeded: record.raw.metadata.requestSucceeded ?? false') ||
     !lines[index].includes('finalParsedFieldCount: ocrUi.fieldCount') ||
     !lines[index].includes('</details>'))
    throw Error("Diagnostics rendering anchor mismatch.");
  lines[index]='        {/* '+mark+' */}{(record.raw || record.packagePages?.length || record.parsedSources?.length) && <details className="ocr-diagnostics"><summary>PDF / OCR diagnostics</summary><pre>{JSON.stringify(buildDocumentDiagnostics(record), null, 2)}</pre></details>}';
  let after=lines.join("\n");
  after=after.replace(anchor,anchor+'\nimport { buildDocumentDiagnostics } from "@/lib/step5b05-diagnostics";');
  if(dry){console.log("STEP5B05 DRY RUN OK");process.exit(0);}
  const tmp=file+".step5b05.tmp";
  try{writeFileSync(tmp,after,"utf8");renameSync(tmp,file);}
  catch(e){try{if(existsSync(tmp))unlinkSync(tmp);}catch{}throw e;}
  console.log("STEP5B05 INSTALLED");
}catch(e){console.error("STEP5B05 ABORTED: "+e.message);process.exitCode=1;}

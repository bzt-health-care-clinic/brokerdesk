#!/usr/bin/env node
/**
 * Step 5B-02 — receipt and VIN verification are different states.
 * Pinned to the eac983c layout, also compatible with Step 5B-01 applied.
 *
 * --dry-run performs every anchor check without writing anything.
 * Prevalidates all target files before changing any file. Does not use git,
 * touch secrets, or enable v0.4 by default.
 */
import { existsSync, readFileSync as nativeReadFileSync, writeFileSync as nativeWriteFileSync, renameSync, unlinkSync } from "node:fs";
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

import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");
const marker = "Step 5B-02";
const replaceExactlyOnce = (text, before, after, label) => {
  const occurrences = text.split(before).length - 1;
  if (occurrences !== 1)
    throw new Error(`${label}: expected 1 anchor, found ${occurrences}; no files changed.`);
  return text.replace(before, after);
};
const replaceBlock = (text, start, end, after, label) => {
  const startIndex = text.indexOf(start);
  if (startIndex < 0 || text.indexOf(start, startIndex + 1) >= 0)
    throw new Error(`${label}: start anchor missing/ambiguous.`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  if (endIndex < 0 || text.indexOf(end, endIndex + end.length) >= 0)
    throw new Error(`${label}: end anchor missing/ambiguous.`);
  return text.slice(0, startIndex) + after + "\n" + text.slice(endIndex);
};

const patches = [
  ["lib/document-package.ts", text => {
    text = replaceExactlyOnce(text,
      'import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";',
      'import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";\n' +
      'import { ownershipReceiptStatus } from "./ownership-receipt.ts";',
      "Receipt helper import");
    return replaceExactlyOnce(text,
      '  next.documents = next.documents.map((document) => ({ ...document, received: (categoryTypes[document.category] ?? []).some((type) => active.has(type)) }));',
      `  // Step 5B-02: receipt is physical; the VIN verification gate remains separate.
  // Only Ownership is changed here. Do not loosen general document rules.
  const scannedOwnership = ownershipReceiptStatus(records).received;
  next.documents = next.documents.map((document) => ({
    ...document,
    received: document.category === "ownership" ? scannedOwnership
      : (categoryTypes[document.category] ?? []).some((type) => active.has(type)),
  }));`,
      "Ownership receipt in checklist");
  }],
  ["lib/broker-file-intake.ts", text => {
    text = replaceExactlyOnce(text,
      'import { activeParsedSources } from "./active-evidence.ts";',
      'import { activeParsedSources } from "./active-evidence.ts";\n' +
      'import { currentPhysicalFile, sectionWithdrawn } from "./ownership-receipt.ts";',
      "Strict VIN helper import");
    text = replaceBlock(text,
      '/** No filename/checklist shortcut.',
      '/** Manual broker attestation',
      `/** Step 5B-02: a section subjectId does not prove VIN; unreadable scans stay blocked. */
export function hasOwnershipSectionForVehicle(vehicle:Vehicle,records:UploadedDocumentRecord[]):boolean {
  const vin=normalizedVin(vehicle.vin);
  if(!vehicle.id || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ||
    normalizedVin(vehicle.ownership?.vin)!==vin)return false;
  return records.some(record=>{
    if(!currentPhysicalFile(record))return false;
    const sections=(record.logicalDocuments??[]).filter(section=>
      section.documentType==="OWNERSHIP" &&
      section.presenceStatus==="FOUND" &&
      !sectionWithdrawn(record,section));
    if(!sections.length)return false;
    const parsed=activeParsedSources(record);
    return sections.some(section=>{
      // An explicit different subject is never available to this vehicle.
      if(section.subjectId && section.subjectId!==vehicle.id)return false;
      const observed=parsed.filter(source=>
        source.documentType==="OWNERSHIP" &&
        (!source.logicalDocumentId || source.logicalDocumentId===section.id))
        .map(source=>normalizedVin(source.data?.vin))
        .filter(Boolean);
      // Both "no VIN" and "correct VIN plus conflicting VIN" fail closed.
      return observed.includes(vin) && observed.every(candidate=>candidate===vin);
    });
  });
}`,
      "Strict Ownership VIN lookup");
    return replaceExactlyOnce(text,
      '    if(checked&&!hasOwnershipSectionForVehicle(vehicle,records))return vehicle;',
      `    if(checked){
      const vin=normalizedVin(vehicle.vin);
      // Step 5B-02: one VIN/physical proof cannot confirm two rated vehicles.
      if(item.vehicles.filter(candidate=>normalizedVin(candidate.vin)===vin).length!==1 ||
        !hasOwnershipSectionForVehicle(vehicle,records))return vehicle;
    }`,
      "Reject duplicate VIN confirmation");
  }],
  ["components/broker-intake-panel.tsx", text => {
    text = replaceExactlyOnce(text,
      'import { applyDocumentPresence } from "@/lib/document-package";',
      'import { applyDocumentPresence } from "@/lib/document-package";\n' +
      'import { ownershipReceiptStatus } from "@/lib/ownership-receipt";',
      "Broker display receipt import");
    text = replaceExactlyOnce(text,
      '  const missing=presence.documents.filter(d=>d.required&&!d.received);',
      `  // Step 5B-02: a hashed, unreadable Ownership scan is RECEIVED, not VERIFIED.
  const ownershipReceipt=ownershipReceiptStatus(records);
  const uniqueVins=new Set(data.vehicles.map(v=>String(v.vin??"").toUpperCase()));
  const ownershipNeedsVinReview=ownershipReceipt.received && auto &&
    (data.vehicles.length===0 || uniqueVins.size!==data.vehicles.length ||
      data.vehicles.some(v=>!v.ownership?.received || !hasOwnershipSectionForVehicle(v,records)));
  const missing=presence.documents.filter(d=>d.required&&!d.received);`,
      "Broker intake verification state");
    text = replaceExactlyOnce(text,
      '            checked={vehicle.ownership?.received===true}',
      '            checked={vehicle.ownership?.received===true && hasOwnershipSectionForVehicle(vehicle,records)}',
      "Do not display stale checkbox as verified");
    text = replaceExactlyOnce(text,
      `        {!hasOwnershipSectionForVehicle(vehicle,records)&&
          <small>Link an active Ownership section to this vehicle in Documents → Manage sections,
            or confirm a matching VIN from parsed Ownership, before verifying.</small>}`,
      `        {!hasOwnershipSectionForVehicle(vehicle,records)&&
          <small>Ownership VIN evidence is not verified for this vehicle. A received
            but unreadable scan requires OCR or a separate source-bound verification;
            linking a section or checking a box alone cannot verify VIN.</small>}`,
      "Unverified Ownership hint");
    text = replaceExactlyOnce(text,
      `      <p>Checklist is calculated from active classified source sections. A filename alone cannot
        prove a required document has been received.</p>`,
      `      <p>The checklist distinguishes a current hashed original from verified vehicle evidence.
        An uploaded Ownership PDF does not, by itself, verify a VIN.</p>`,
      "Checklist explanation");
    return replaceExactlyOnce(text,
      `          <strong>{doc.received?"Found":"Missing"}</strong><span>{doc.name}</span>
        </div>)}`,
      `          <strong>{doc.category==="ownership"&&doc.received?"Received":
            doc.received?"Found":"Missing"}</strong><span>{doc.name}</span>
          {doc.category==="ownership"&&doc.received&&ownershipNeedsVinReview&&
            <small>Received — OCR / VIN verification required. Preflight still
              requires matching evidence for every affected vehicle.</small>}
        </div>)}`,
      "Ownership receipt is not verification");
  }],
];

const planned=[];
for(const [relative,transform] of patches){
  const path=resolve(projectRoot,relative);
  if(!path.startsWith(projectRoot+sep)||!existsSync(path))
    throw new Error(`Missing target ${relative}; no files changed.`);
  const before=readFileSync(path,"utf8");
  const already=before.includes(marker);
  const after=already?before:transform(before);
  if(after===before&&!already)throw new Error(`${relative}: no changes created`);
  planned.push({relative,path,before,after,already});
}
if(!existsSync(resolve(projectRoot,"lib/ownership-receipt.ts")))
  throw new Error("Missing lib/ownership-receipt.ts. Extract the entire cumulative ZIP first.");
console.log(`${dry?"DRY RUN":"INSTALL"} Step 5B-02 (no PR/main changes)`);
for(const target of planned)
  console.log(`  ${target.already?"already installed":"validated"} ${target.relative}`);
if(dry)process.exit(0);
const modified=planned.filter(p=>!p.already);
try{
  for(const target of modified){
    const tmp=target.path+".step5b02.tmp";
    writeFileSync(tmp,target.after,"utf8");
    renameSync(tmp,target.path);
  }
}catch(error){
  for(const target of modified){
    try{writeFileSync(target.path,target.before,"utf8");}catch{}
    try{unlinkSync(target.path+".step5b02.tmp");}catch{}
  }
  throw error;
}
console.log(`Installed ${modified.length} source changes. Step 5B-03 can be developed next; aggregate CI is deferred.`);

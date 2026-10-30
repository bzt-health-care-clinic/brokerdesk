#!/usr/bin/env node
/**
 * Step 5B-01, pinned to the source layout at eac983c.
 * Anchored, atomic-by-validation edits: never overwrite whole repository files.
 * This script NEVER runs git push, checkout, merge, or changes default v0.3.
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

import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dry = process.argv.includes("--dry-run");
const marker = "Step 5B-01";
const replace = (text, before, after, label) => {
  const found = text.split(before).length - 1;
  if (found !== 1) throw new Error(`${label}: expected one source anchor, found ${found}. No files changed.`);
  return text.replace(before, after);
};

const patches = [
  ["lib/applied-rating-parser.ts", text => {
    text = replace(text,
      "import { LayoutReader, cleanLayoutText, evidenceOf, joinCells, labelKey, templateDate, type LayoutCell } from './layout-reader.ts';",
      "import { LayoutReader, cleanLayoutText, evidenceOf, joinCells, labelKey, templateDate, type LayoutCell } from './layout-reader.ts';\nimport { extractAppliedQuoteNumber } from './applied-quote-number.ts';",
      "Applied parser import");
    return replace(text,
      "  const blocked=new Set<string>();\n  const auto=type==='AUTO_APPLICATION'||type==='AUTO_QUOTE';",
      `  const blocked=new Set<string>();
  // Step 5B-01: a labelled quote number is policy-scoped, not a vehicle/driver cell.
  if (type === 'AUTO_QUOTE') {
    const quote = extractAppliedQuoteNumber(raw);
    if (quote.value !== undefined) result.data.quoteNumber = quote.value;
    if (quote.evidence.length) result.fieldEvidence.quoteNumber = quote.evidence;
    result.warnings.push(...quote.warnings);
  }
  const auto=type==='AUTO_APPLICATION'||type==='AUTO_QUOTE';`,
      "Applied parser policy-scoped quote");
  }],
  ["lib/document-ingestion.ts", text => {
    text=replace(text,
      'import { parseAppliedRating } from "./applied-rating-parser.ts";',
      'import { parseAppliedRating } from "./applied-rating-parser.ts";\nimport { extractAppliedQuoteNumber } from "./applied-quote-number.ts";',
      "Ingestion helper import");
    text=replace(text,
      'export const PARSER_VERSION = 8;',
      '// Step 5B-01: bump AUTO_QUOTE only; other v8 parsers stay valid.\nexport const PARSER_VERSION = 9;',
      "Parser version");
    text=replace(text,
      '  return kinds.some(type=>isDriverReport(type)||expanded.has(type))?PARSER_VERSION:3;',
      '  return kinds.includes("AUTO_QUOTE")?PARSER_VERSION:\n    kinds.some(type=>isDriverReport(type)||expanded.has(type))?8:3;',
      "Targeted reparse version gate");
    text=replace(text,
      '    const noText = !text.trim();',
      `    // Step 5B-01: even the non-Applied AUTO_QUOTE fallback must use explicit
    // labels and a physical-page proof, never the generic "Quote"/"Submission" alias.
    if (this.documentType === "AUTO_QUOTE") {
      delete data.quoteNumber;
      delete fieldEvidence.quoteNumber;
      const quote = extractAppliedQuoteNumber(raw);
      if (quote.value !== undefined) data.quoteNumber = quote.value;
      if (quote.evidence.length) fieldEvidence.quoteNumber = quote.evidence;
      rejected.push(...quote.warnings);
    }
    const noText = !text.trim();`,
      "Auto Quote generic safe fallback");
    text=replace(text,
      'quoteNumber: ["Quote Number", "Quote", "Submission"]',
      'quoteNumber: ["Here is your quote number", "Quote Number"]',
      "Dangerous Quote Number aliases");
    return text;
  }],
  ["local-server/broker-review-source.mjs", text => {
    text=replace(text,
      '  "policy.insured":["insuredName","namedInsured"],',
      '  // Step 5B-01: only explicitly labelled AUTO_QUOTE evidence may set this field.\n  "policy.quoteNumber":["quoteNumber"],\n  "policy.insured":["insuredName","namedInsured"],',
      "Broker Review Quote mapping");
    text=replace(text,
      '  if (record.state === "NEEDS_REVIEW" || record.extractionStatus === "NEEDS_REVIEW") return null;',
      `  // Step 5B-01: a mixed PDF may need review for unrelated pages.
  // Quote auto-fill is permitted only from a completed, individually proven page.
  if (record.state === "FAILED" || record.extractionStatus === "FAILED") return null;
  if (record.state === "NEEDS_REVIEW" || record.extractionStatus === "NEEDS_REVIEW") {
    if (key !== "quoteNumber") return null;
    const proof = source.fieldEvidence?.quoteNumber;
    if (!Array.isArray(proof) || proof.length !== 1) return null;
    const page = (record.packagePages ?? []).find(p =>
      p.page === proof[0]?.page || p.pageNumber === proof[0]?.page);
    if (!page || page.extractionStatus !== "COMPLETE") return null;
  }`,
      "Per-field review status");
    text=replace(text,
      '        if (!id.startsWith("policy.")) continue;',
      `        if (!id.startsWith("policy.")) continue;
        // Step 5B-01: a Quote Number must not come from an Application or another doc.
        if (id === "policy.quoteNumber" && s.documentType !== "AUTO_QUOTE") continue;`,
      "Quote source type restriction");
    return text;
  }],
  ["lib/broker-keyin-review.mjs", text => {
    return replace(text,
      `    if (unique.size===1) {
      field.value=deep(candidates[0].value);
      field.origin="EXTRACTED";
    }`,
      `    if (unique.size===1) {
      // Step 5B-01: a previously entered Case Quote # is not silently replaced
      // with a different parser observation. Broker must resolve the conflict.
      const existingQuote = field.id === "policy.quoteNumber" &&
        field.value !== null && field.value !== undefined &&
        String(field.value).trim() !== "";
      if (existingQuote &&
          String(field.value).trim().toUpperCase() !==
          String(candidates[0].value).trim().toUpperCase()) {
        field.conflict = true;
      } else {
        field.value=deep(candidates[0].value);
        field.origin="EXTRACTED";
      }
    }`,
      "Broker Case/manual Quote conflict");
  }],
  ["local-server/broker-review-integration.mjs", text => {
    return replace(text,
      `    const fresh=createBrokerReview(live.item,this.createOptions(live));
    fresh.revision=previous.revision+1;`,
      `    const fresh=createBrokerReview(live.item,this.createOptions(live));
    // Step 5B-01: an explicit Broker correction survives a deliberate rebuild.
    // The newly built page stays PENDING, and changed extracted evidence raises
    // a conflict instead of overwriting that correction.
    const previousQuote=previous.fields.find(f=>f.id==="policy.quoteNumber");
    const freshQuote=fresh.fields.find(f=>f.id==="policy.quoteNumber");
    if (previousQuote && freshQuote &&
        ["BROKER_CORRECTED","MANUAL_FROM_SOURCE"].includes(previousQuote.origin)) {
      const nextExtracted=freshQuote.value;
      freshQuote.value=previousQuote.value;
      freshQuote.origin=previousQuote.origin;
      freshQuote.corrected_by=previousQuote.corrected_by;
      freshQuote.corrected_at=previousQuote.corrected_at;
      freshQuote.conflict=freshQuote.conflict ||
        (nextExtracted !== null && nextExtracted !== undefined &&
         String(nextExtracted).trim().toUpperCase() !==
         String(previousQuote.value??"").trim().toUpperCase());
    }
    fresh.revision=previous.revision+1;`,
      "Broker rebuilt Quote preservation");
  }],
  ["local-server/reviewed-case-projection-stage3b.mjs", text => {
    return replace(text,
      `  for(const [fieldId,[parent,key,convert]] of Object.entries(POLICY_PATHS)){
    const dest=projected[parent]??(projected[parent]={});
    apply(dest,key,fieldId,convert);
  }`,
      `  for(const [fieldId,[parent,key,convert]] of Object.entries(POLICY_PATHS)){
    const dest=projected[parent]??(projected[parent]={});
    apply(dest,key,fieldId,convert);
  }
  // Step 5B-01: the reviewed Quote # must agree with the outbound Case.
  // Only project a real reviewed value; optional Policy Change blanks stay blank.
  if(fields.get("policy.quoteNumber") !== null &&
     fields.get("policy.quoteNumber") !== undefined) {
    const policy=projected.policy??(projected.policy={});
    apply(policy,"quote_number","policy.quoteNumber",requiredString);
    if(Object.prototype.hasOwnProperty.call(policy,"auto_quote_number"))
      apply(policy,"auto_quote_number","policy.quoteNumber",requiredString);
  }`,
      "Outbound Quote # projection");
  }],
  ["local-server/reviewed-keyin-package.mjs", text => {
    return replace(text,
      '    ["policy.number",item.policy?.policy_number]',
      `    ["policy.number",item.policy?.policy_number],
    // Step 5B-01: fail if Broker's reviewed Quote # and outbound Case differ.
    ["policy.quoteNumber",item.policy?.auto_quote_number || item.policy?.hab_quote_number || item.policy?.quote_number]`,
      "Reviewed BDZIP quote consistency");
  }]
];

const planned=[];
for (const [rel, transform] of patches) {
  const absolute=resolve(projectRoot, rel);
  if (!absolute.startsWith(projectRoot + sep) || !existsSync(absolute))
    throw new Error(`Missing/invalid target: ${rel}. No files changed.`);
  const before=readFileSync(absolute,"utf8");
  if (before.includes(marker)) { planned.push({rel,absolute,before,after:before,unchanged:true});continue; }
  const after=transform(before);
  if(after===before)throw new Error(`No change made: ${rel}.`);
  planned.push({rel,absolute,before,after,unchanged:false});
}
console.log(`${dry?"DRY RUN":"INSTALL"}: Step 5B-01`);
for(const f of planned)console.log(`  ${f.unchanged?"already installed":"validated"} ${f.rel}`);
if (dry) process.exit(0);

// A complete preflight is finished before touching any repository file.
const changed=planned.filter(f=>!f.unchanged);
try {
  for(const f of changed) {
    const temp=`${f.absolute}.step5b01.tmp`;
    writeFileSync(temp,f.after,"utf8");
    renameSync(temp,f.absolute);
  }
} catch(error) {
  for(const f of changed) {
    try { writeFileSync(f.absolute,f.before,"utf8"); } catch {}
    try { unlinkSync(`${f.absolute}.step5b01.tmp`); } catch {}
  }
  throw error;
}
console.log(`Done. ${changed.length} files updated. Run the isolated tests and CI before integration.`);

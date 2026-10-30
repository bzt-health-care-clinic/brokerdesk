/**
 * Step 5B-04: signed-application boundaries. A cover is an anchor, NOT proof of
 * signatures or complete extraction. Preserve source bytes/physical pages.
 *
 * This module does not confirm any broker attestations. Its output is only a
 * proposed logical section; actual signers and document pages remain checked
 * by signed-verification / intake-person-evidence.
 */
import type {
  DocumentType, PackagePage, SuggestedLogicalDocument, UploadedDocumentRecord,
} from "./extraction-types.ts";

export type ApplicationType = "AUTO_APPLICATION" | "HAB_APPLICATION";
export const isApplicationType = (type: string): type is ApplicationType =>
  type === "AUTO_APPLICATION" || type === "HAB_APPLICATION";

const autoCover = /\b(?:Ontario\s+Application\s+for\s+Automobile\s+Insurance|Owner['’]?s?\s+Form\s*\(\s*OAF\s*1\s*\)|Automobile\s+Insurance\s+Application)\b/i;
const homeCover = /\b(?:Habitational\s+Insurance\s+Application|Home\s+Insurance\s+Application|Application\s+for\s+(?:Home|Property)\s+Insurance)\b/i;
const signedFilename = /(?:^g4sign(?:[\s._-]|$)|signed[\s._-]*(?:auto|home|hab|application)|(?:auto|home|hab)[\s._-]*signed[\s._-]*application)/i;
const independentHeader = /(?:^\s*(?:DASH\s+(?:Driver\s+)?Report|AutoPlus(?:\s+Report)?|MVR(?:\s+Abstracts?)?|Ontario\s+Driving\s+Record|Vehicle\s+Ownership|Ontario\s+Vehicle\s+Permit|Bill\s+of\s+Sale|Void\s+Cheque|Payment\s+Authorization|Quote\s+Summary|Auto\s+Insurance\s+Quote|Home\s+Insurance\s+Quote|Applied\s+Rating\s+Quote)\b|^\s*Here\s+is\s+your\s+quote\s+number\b)/im;
const independentTypes = new Set<DocumentType>([
  "AUTO_QUOTE", "HAB_QUOTE", "MVR", "DASH", "OWNERSHIP",
  "BILL_OF_SALE", "VOID_CHEQUE", "PAYMENT_AUTHORIZATION",
  "POLICY_CHANGE", "OPCF_FORM", "LEASE_DOCUMENT", "FINANCE_DOCUMENT",
  "PRIOR_AUTO_POLICY", "PRIOR_PROPERTY_POLICY",
]);

const pageText = (page: PackagePage) =>
  page.text ?? page.blocks?.map(block => block.text).join("\n") ?? "";

export function signedApplicationCoverType(
  record: Pick<UploadedDocumentRecord, "fileName" | "originalFileName">,
  pages: readonly PackagePage[],
): ApplicationType | undefined {
  if (!signedFilename.test(record.originalFileName ?? record.fileName)) return undefined;
  const cover = pages.filter(page => page.page <= 2 &&
    page.extractionStatus === "COMPLETE").map(pageText).join("\n");
  const auto = autoCover.test(cover);
  const home = homeCover.test(cover);
  return auto === home ? undefined : auto ? "AUTO_APPLICATION" : "HAB_APPLICATION";
}

function isNewApplicationCover(page: PackagePage): boolean {
  const text = pageText(page).slice(0, 1000);
  return /(?:^|\n)\s*(?:g4sign\b.*\b(?:cover\s+page|new\s+application)|(?:new\s+signed\s+application))\b/i.test(text) ||
    /\bPage\s+1\s+(?:of|\/)\s+\d+\b/i.test(text) && (autoCover.test(text) || homeCover.test(text));
}

export function hasIndependentDocumentBoundary(
  page: PackagePage, family: ApplicationType,
): boolean {
  const text = pageText(page);
  if (independentHeader.test(text)) return true;
  const type = page.classification.documentType;
  if (isApplicationType(type) && type !== family) return true;
  return independentTypes.has(type);
}

/**
 * When the first cover proves the application family, weak OTHER continuations
 * can be proposed as part of that packet. Never overwrite quote/report/proof
 * classifications, even if a G4Sign filename is present.
 *
 * This does not classify FAILED pages as readable.
 */
export function prepareSignedApplicationPages(
  record: UploadedDocumentRecord, pages: PackagePage[],
): { record: UploadedDocumentRecord; pages: PackagePage[] } {
  const family = signedApplicationCoverType(record, pages);
  if (!family) return { record, pages };
  let inside = false, external = false;
  const converted = [...pages].sort((a,b)=>a.page-b.page).map(page => {
    const unequivocalCover=page.page<=2 &&
      (family==="AUTO_APPLICATION"?autoCover:homeCover).test(pageText(page)) &&
      !independentHeader.test(pageText(page));
    if (unequivocalCover) inside=true;
    if (external || !inside) return page;
    // A classifier can confuse the APPLICATION cover with a Quote due to
    // incidental references. The explicit signed cover wins *only here*.
    if (unequivocalCover && page.extractionStatus==="COMPLETE")
      return {...page,classification:{documentType:family,confidence:.95,
        reason:"Explicit signed application cover (not a quote)."}};
    if (hasIndependentDocumentBoundary(page, family)) {
      external = true;
      return page;
    }
    if (page.extractionStatus !== "COMPLETE") return page;
    if (page.classification.documentType !== family &&
      page.classification.documentType !== "OTHER") return page;
    if (page.classification.documentType === family) return page;
    return { ...page, classification: {
      documentType: family, confidence: Math.min(.85, page.classification.confidence || .85),
      reason: "G4Sign cover-anchored continuation; broker boundary review required.",
    } };
  });
  // A mixed PDF may contain a real Quote or MVR: keep its container type.
  const noExternal = converted.every(page =>
    page.extractionStatus !== "COMPLETE" ||
    page.classification.documentType === family);
  return { record: noExternal ? {
    ...record, documentType: family,
    classification: { documentType: family, confidence: .95,
      reason: "Signed application family supported by original cover." },
  } : record, pages: converted };
}

const overlaps = (a: number, b: number, c: number, d: number) =>
  a <= d && c <= b;

const rangeEnd = (section: { startPage?: number; endPage?: number }) =>
  section.endPage ?? section.startPage ?? 1;

function bridge(
  from: number, to: number, family: ApplicationType,
  pages: Map<number, PackagePage>, record: UploadedDocumentRecord,
): { allowed: boolean; needsReview: boolean } {
  if (to < from) return { allowed: true, needsReview: false };
  if ((record.withdrawnSectionRanges ?? []).some(r =>
    overlaps(from, to, r.startPage, r.endPage))) return { allowed: false, needsReview: true };
  if ((record.logicalDocuments ?? []).some(s =>
    s.classificationSource === "MANUAL" &&
    overlaps(from, to, s.startPage ?? 1, rangeEnd(s))))
    return { allowed: false, needsReview: true };
  let review = false;
  for (let i = from; i <= to; i++) {
    const page = pages.get(i);
    if (!page || page.extractionStatus !== "COMPLETE") {
      review = true; continue;
    }
    if (hasIndependentDocumentBoundary(page, family)) return { allowed: false, needsReview: true };
    if (page.classification.documentType === family) {
      if (page.classification.confidence < .9) review = true;
      continue;
    }
    if (page.classification.documentType === "OTHER" && !independentHeader.test(pageText(page))) {
      review = true; continue;
    }
    return { allowed: false, needsReview: true };
  }
  return { allowed: true, needsReview: review };
}

/**
 * Merges only sections corroborated by a strong signed-application cover, with
 * no intervening named independent document. Every unknown/failed intervening
 * physical page forces PENDING and NEEDS_REVIEW. The output never fabricates a
 * signature or accepts an old section verification for a new range.
 */
export function coalesceSignedApplicationSuggestions(
  record: UploadedDocumentRecord,
  suppliedPages: PackagePage[],
  suggestions: SuggestedLogicalDocument[],
): SuggestedLogicalDocument[] {
  const allPages = new Map<number,PackagePage>();
  for (const page of record.packagePages ?? []) allPages.set(page.page, page);
  for (const page of suppliedPages) allPages.set(page.page, page);
  const pages = [...allPages.values()].sort((a,b) => a.page - b.page);
  const family = signedApplicationCoverType(record, pages);
  if (!family) return suggestions;
  const application = suggestions.filter(s => s.documentType === family)
    .sort((a,b) => (a.startPage ?? 1) - (b.startPage ?? 1));
  if (!application.length) return suggestions;
  const groups: SuggestedLogicalDocument[][] = [];
  for (const item of application) {
    const current = groups.at(-1);
    const prior = current?.at(-1);
    if (!prior) { groups.push([item]); continue; }
    const p = allPages.get(item.startPage ?? 1);
    const independentCover = p && isNewApplicationCover(p);
    const between = bridge(rangeEnd(prior)+1,(item.startPage ?? 1)-1,
      family,allPages,record);
    if (independentCover || !between.allowed) groups.push([item]);
    else current!.push(item);
  }
  const merged = groups.map(parts => {
    const first = parts[0], last = parts.at(-1)!;
    const start = first.startPage ?? 1;
    let end = rangeEnd(last);
    // Append *only* trailing failed pages to dedicated G4Sign packets.
    // They remain PENDING, never automatically verified.
    for (let p = end+1; p <= (record.pageCount ?? Math.max(...allPages.keys())); p++) {
      const item = allPages.get(p);
      if (!item || item.extractionStatus !== "FAILED" ||
        hasIndependentDocumentBoundary(item,family)) break;
      end = p;
    }
    const inspection = bridge(start,end,family,allPages,record);
    const uncertain = !inspection.allowed || inspection.needsReview ||
      parts.some(part=>part.suggestionStatus==="PENDING" ||
        part.parseStatus==="NEEDS_REVIEW");
    const id = `${record.id}-suggested-${start}-${end}-${family}`;
    const wasSame = parts.length===1 && first.id===id && rangeEnd(first)===end;
    const prev = record.logicalDocuments?.find(s => s.id===id);
    const accepted = !uncertain &&
      (wasSame ? first.suggestionStatus==="ACCEPTED" :
        parts.every(part=>part.suggestionStatus==="ACCEPTED"));
    const sourceIssues: string[] = [];
    if (uncertain) sourceIssues.push(
      "Signed application pages include unreadable/ambiguous evidence; inspect and resolve before verification.");
    if (parts.length>1) sourceIssues.push(
      "Signed application sections grouped; previous page-scoped confirmation does not transfer.");
    const unique = [...new Set([...parts.flatMap(p => p.evidenceSignals),...sourceIssues])];
    return {
      ...first, id, startPage:start, endPage:end,
      title: first.title, subjectName: prev?.subjectName ?? first.subjectName,
      suggestionStatus: accepted ? "ACCEPTED" as const : "PENDING" as const,
      parseStatus: uncertain ? "NEEDS_REVIEW" as const : "NOT_EVALUATED" as const,
      validationStatus: "NOT_EVALUATED" as const,
      classificationConfidence: Math.min(...parts.map(p=>p.classificationConfidence??.8)),
      evidenceSignals:unique,
    };
  });
  const retained = suggestions.filter(item => item.documentType !== family);
  return [...retained,...merged].sort((a,b)=>
    (a.startPage??1)-(b.startPage??1));
}

/** A candidate for manual old-record regroup, never an implicit signed attestation. */
export function signedApplicationRegroupCandidate(
  record: UploadedDocumentRecord,
): SuggestedLogicalDocument | undefined {
  const sections=(record.logicalDocuments??[]).filter(s=>isApplicationType(s.documentType));
  const family=signedApplicationCoverType(record,record.packagePages??[]);
  if (!family || sections.length<2 ||
    sections.some(s=>s.documentType!==family || s.classificationSource==="MANUAL") ||
    !record.sourceHash || record.staleExtraction ||
    (record.currentSourceHash && record.currentSourceHash!==record.sourceHash))
    return undefined;
  const existing = (record.suggestedSections??[]).filter(s=>s.documentType!==family);
  const {pages}=prepareSignedApplicationPages(record,record.packagePages??[]);
  const parts=sections.map(s=>({
    ...s,suggestionStatus:"ACCEPTED" as const,evidenceSignals:[],
  }));
  const updated=coalesceSignedApplicationSuggestions(
    {...record,logicalDocuments:record.logicalDocuments?.filter(s=>s.classificationSource==="MANUAL")},
    pages,[...existing,...parts],
  ).filter(s=>s.documentType===family);
  if (updated.length!==1 || updated[0].suggestionStatus!=="ACCEPTED" ||
    !updated[0].startPage || !updated[0].endPage) return undefined;
  if ((record.withdrawnSectionRanges??[]).some(r=>overlaps(
    updated[0].startPage!,updated[0].endPage!,r.startPage,r.endPage))) return undefined;
  return updated[0];
}

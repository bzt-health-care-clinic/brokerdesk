/**
 * Step 5B-01: safely extract explicitly labelled Applied Auto quote numbers.
 * No unlabeled-number scan; never infer from Applied Ref, Policy, Account or Submission IDs.
 * This module is pure. Source-file identity and logical-document grouping are supplied
 * by the existing ingestion/package-analysis pipeline.
 */
import type { ExtractionWarning, FieldEvidence, RawExtractedDocument, ExtractedPage } from "./extraction-types.ts";

export interface ExplicitQuoteNumber {
  value?: string;
  evidence: FieldEvidence[];
  warnings: ExtractionWarning[];
}

type Hit = { value: string; evidence: FieldEvidence };
const LABEL = /^(?:here\s+is\s+your\s+quote\s+number|(?:your\s+)?quote\s+(?:number|no\.?|#))\s*(?::|：|#|-)?\s*(.*)$/i;
const NUMBER = /^(?:Q[A-Z0-9-]{3,31}|[A-Z0-9][A-Z0-9-]{4,31})$/i;
const normalize = (s: string) => s.normalize("NFKC").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
const valid = (s: string) => NUMBER.test(s) && /\d/.test(s) &&
  !/(?:^|-)N\/?A(?:$|-)/i.test(s) && !/---/.test(s);
const pageIndex = (p: ExtractedPage): number => p.pageNumber ?? p.page;

function evidence(page: ExtractedPage, raw: RawExtractedDocument, number: string): FieldEvidence {
  const matchingBlocks = (page.blocks ?? []).filter(b =>
    normalize(b.text).toUpperCase().includes(number.toUpperCase()) && b.boundingBox);
  const block = matchingBlocks.length === 1 ? matchingBlocks[0] : undefined;
  return {
    page: pageIndex(page),
    text: number,
    ...(block?.boundingBox ? { boundingBox: { ...block.boundingBox } } : {}),
    confidence: Math.min(page.confidence ?? raw.confidence ?? 0,
      block?.confidence ?? 1)
  };
}

function pageHits(page: ExtractedPage, raw: RawExtractedDocument) {
  const hits: Hit[] = [];
  const warnings: ExtractionWarning[] = [];
  const lines = String(page.text ?? "").replace(/\r\n?/g, "\n").split("\n").map(normalize);
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(LABEL);
    if (!label) continue;
    const inline = normalize(label[1] ?? "");
    const candidate = inline || normalize(lines[i + 1] ?? "");
    if (!candidate || !valid(candidate)) {
      warnings.push({
        code: "NEEDS_REVIEW", field: "quoteNumber", severity: "medium",
        message: `Explicit Quote Number label on page ${pageIndex(page)} has no safe value.`
      });
      continue;
    }
    hits.push({ value: candidate.toUpperCase(), evidence: evidence(page, raw, candidate) });
  }
  // When the text stream separates PDF table cells, use only an unambiguous
  // geometrically adjacent value; never scan an arbitrary number from the page.
  const blocks = (page.blocks ?? []).filter(b => b.boundingBox && b.text?.trim());
  for (const labelBlock of blocks) {
    const m = normalize(labelBlock.text).match(LABEL);
    if (!m || normalize(m[1] ?? "")) continue;
    const box = labelBlock.boundingBox!;
    const sameRow = blocks.filter(b => {
      if (b === labelBlock) return false;
      const v = normalize(b.text);
      if (!valid(v)) return false;
      const at = b.boundingBox!;
      const overlap = Math.min(at.y + at.height, box.y + box.height) - Math.max(at.y, box.y);
      return overlap >= Math.min(box.height, at.height) * .4 &&
        at.x >= box.x + box.width - 1 &&
        at.x - (box.x + box.width) <= Math.max(80, box.height * 12);
    });
    if (sameRow.length !== 1) continue;
    const selected = sameRow[0];
    const value = normalize(selected.text).toUpperCase();
    hits.push({
      value,
      evidence: {
        page: pageIndex(page), text: value,
        boundingBox: { ...selected.boundingBox! },
        confidence: Math.min(page.confidence ?? raw.confidence ?? 0, selected.confidence ?? 1)
      }
    });
  }
  return { hits, warnings };
}

/** Evidence must always point to an actual source page; no guessed default page. */
export function extractAppliedQuoteNumber(raw: RawExtractedDocument): ExplicitQuoteNumber {
  const warnings: ExtractionWarning[] = [];
  const hits: Hit[] = [];
  for (const page of raw.pages ?? []) {
    if (!Number.isSafeInteger(pageIndex(page)) || pageIndex(page) < 1) continue;
    const found = pageHits(page, raw);
    hits.push(...found.hits);
    warnings.push(...found.warnings);
  }
  if (!hits.length) return { evidence: [], warnings };
  const values = [...new Set(hits.map(h => h.value))];
  if (values.length > 1) {
    warnings.push({
      code: "NEEDS_REVIEW", field: "quoteNumber", severity: "high",
      message: "Conflicting explicitly labelled Quote Numbers; none selected. Broker must resolve."
    });
    return { evidence: hits.map(h => h.evidence), warnings };
  }
  const trusted = hits.find(h => (h.evidence.confidence ?? 0) >= .9);
  if (!trusted || hits.some(h => (h.evidence.confidence ?? 0) < .9)) {
    warnings.push({
      code: "NEEDS_REVIEW", field: "quoteNumber", severity: "medium",
      message: "Explicit Quote Number has low-confidence evidence; Broker verification required."
    });
    return { evidence: hits.map(h => h.evidence), warnings };
  }
  // The existing Broker source mapper requires a unique evidence page per
  // candidate. Identical occurrences on different pages are not a conflict.
  return { value: trusted.value, evidence: [trusted.evidence], warnings };
}

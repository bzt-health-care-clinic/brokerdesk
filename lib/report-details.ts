import type { FieldEvidence, ParsedSource, RawExtractedDocument } from "./extraction-types.ts";
import { reportIdentity, savedPageText } from "./report-boundaries.ts";

const textOf = (raw: RawExtractedDocument) => raw.text || raw.rawText || raw.pages?.map(savedPageText).join("\n") || "";
export const reportRaw = (raw: RawExtractedDocument): RawExtractedDocument => ({ ...raw, text: textOf(raw), pages: raw.pages?.map(page => ({ ...page, text: savedPageText(page) })) });
function evidence(raw: RawExtractedDocument, text: string, offset?: number): FieldEvidence[] {
  const combined = raw.pages?.map(savedPageText).join("\n");
  const start = offset ?? textOf(raw).indexOf(text);
  if (combined === textOf(raw) && start >= 0) {
    let position = 0;
    return raw.pages!.flatMap(page => {
      const end = position + savedPageText(page).length;
      const overlaps = position < start + text.length && end > start;
      position = end + 1;
      return overlaps ? [{ page: page.page, text, confidence: page.confidence ?? raw.confidence, boundingBox: page.blocks?.find(block => text.includes(block.text))?.boundingBox }] : [];
    });
  }
  const lines = text.split("\n").map(s => s.trim()).filter(Boolean);
  const pages = raw.pages?.filter(p => lines.some(line => (p.text ?? p.blocks?.map(b => b.text).join("\n") ?? "").includes(line))) ?? [];
  return pages.length ? pages.map(p => ({ page: p.page, text, confidence: p.confidence ?? raw.confidence, boundingBox: p.blocks?.find(b => lines.some(line => b.text.includes(line)))?.boundingBox })) : [{ text, confidence: raw.confidence }];
}
function arrayAfter(text: string, label: string) {
  const match = new RegExp(`^${label}\\s*:\\s*`, "im").exec(text);
  if (!match) return undefined;
  const tail = text.slice(match.index + match[0].length); if (!tail.startsWith("[")) return undefined;
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < tail.length; i++) {
    const char = tail[i];
    if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    if (char === "[") depth++;
    if (char === "]" && --depth === 0) {
      try {
        const arrayText = tail.slice(0, i + 1); const values: unknown = JSON.parse(arrayText);
        if (!Array.isArray(values)) return undefined;
        const slices: { text: string; offset: number }[] = [];
        let nested = 0, inString = false, escape = false, begin = 1;
        for (let at = 1; at < arrayText.length; at++) {
          const c = arrayText[at];
          if (inString) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') inString = false; continue; }
          if (c === '"') inString = true;
          if (nested === 0 && (c === "," || at === arrayText.length - 1)) {
            const piece = arrayText.slice(begin, at); const leading = piece.length - piece.trimStart().length;
            if (piece.trim()) slices.push({ text: piece.trim(), offset: match.index + match[0].length + begin + leading });
            begin = at + 1;
          } else if (c === "[" || c === "{") nested++; else if (c === "]" || c === "}") nested--;
        }
        return values.map((data, index) => ({ data, ...slices[index] }));
      } catch { return undefined; }
    }
  }
}
function labelledRecords(text: string, start: RegExp) {
  const matches = [...text.matchAll(start)];
  return matches.map((match, index) => {
    const block = text.slice(match.index!, matches[index + 1]?.index ?? text.length);
    const data: Record<string, unknown> = {};
    for (const line of block.split("\n")) { const part = line.match(/^\s*([^:]+):\s*(.*)$/); if (part) data[part[1].trim()] = part[2].trim(); }
    return { data, text: block, offset: match.index! };
  });
}
const value = (item: Record<string, unknown>, ...keys: string[]) => keys.map(key => item[key]).find(v => v !== undefined && v !== null && v !== "");
export function reportNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value ?? "").trim().replace(/^\$/, "").replace(/,/g, "").replace(/%$/, "");
  return /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

export function enrichDriverReport(parsed: ParsedSource, raw: RawExtractedDocument): ParsedSource {
  const text = textOf(raw); const identity = reportIdentity(text);
  // Report identity is separate from any driver mentioned in claims/history.
  delete parsed.data.licenceNumber;
  if (identity.licence) parsed.data.licenceNumber = identity.licence;
  if (identity.subjectName) parsed.data.driverName = identity.subjectName;
  if (identity.reportId) parsed.data.reportId = identity.reportId;
  if (identity.reportDate) parsed.data.reportDate = identity.reportDate;
  for (const field of ["licenceNumber", "driverName", "reportId", "reportDate"]) if (parsed.data[field]) parsed.fieldEvidence[field] = evidence(raw, String(parsed.data[field]));
  if (parsed.documentType === "MVR") {
    if (parsed.data.demeritPoints !== undefined) {
      const points = reportNumber(parsed.data.demeritPoints);
      if (points !== null && Number.isInteger(points) && points >= 0) parsed.data.demeritPoints = points;
      else { delete parsed.data.demeritPoints; parsed.warnings.push({ code: "NEEDS_REVIEW", field: "demeritPoints", message: "Demerit points are not a clear non-negative integer.", severity: "medium" }); }
    }
    if (typeof parsed.data.conditions === "string") parsed.data.conditions = /^(none|no restrictions)$/i.test(parsed.data.conditions) ? [] : parsed.data.conditions.split(/;|\|/).map(s => s.trim()).filter(Boolean);
    const json = arrayAfter(text, "Convictions(?: JSON)?");
    const blocks = labelledRecords(text, /^\s*Conviction(?: Description)?\s*:\s*/gim);
    const rows = [...(json ?? []), ...blocks];
    if (rows.length || json || /^Convictions\s*:\s*(?:none|0)\s*$/im.test(text)) {
      parsed.data.convictions = rows.map(({ data }) => {
        const item = data && typeof data === "object" ? data as Record<string, unknown> : { description: String(data) };
        return { ...item, description: String(value(item, "description", "Conviction", "Conviction Description") ?? ""), offence_date: value(item, "offence_date", "offenceDate", "Offence Date"), conviction_date: value(item, "conviction_date", "convictionDate", "Conviction Date"), severity: String(value(item, "severity", "Severity") ?? ""), demerit_points: reportNumber(value(item, "demerit_points", "demeritPoints", "Demerit Points")) };
      });
      parsed.fieldEvidence.convictions = rows.length ? rows.flatMap(row => evidence(raw, row.text, row.offset)) : evidence(raw, text.match(/^Convictions\s*:\s*(?:none|0)\s*$/im)?.[0] ?? "Convictions: []");
    }
  }
  if (parsed.documentType === "DASH") {
    const json = arrayAfter(text, "Claims(?: JSON)?");
    const blocks = labelledRecords(text, /^\s*Claim(?: Number| No\.?| ID| #)\s*:\s*/gim);
    const rows = [...(json ?? []), ...blocks];
    // A zero-recent summary is never a substitute for the historical detail rows.
    if (json || rows.length) {
      parsed.data.claims = rows.map(row => ({ ...(row.data && typeof row.data === "object" ? row.data : { unparsed: row.data }), __evidence: evidence(raw, row.text, row.offset) }));
      parsed.fieldEvidence.claims = rows.flatMap(row => evidence(raw, row.text, row.offset));
    } else if (/\bclaims?\b/i.test(text)) parsed.warnings.push({ code: "NEEDS_REVIEW", field: "claims", message: "Claim text requires review; a recent-period summary does not confirm complete claim history.", severity: "medium" });
    delete parsed.data.claimsJson;
  }
  return parsed;
}

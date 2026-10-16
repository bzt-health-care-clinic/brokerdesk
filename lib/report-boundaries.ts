import type { ExtractedPage, PackagePage } from "./extraction-types.ts";

export const SECTION_ANALYSIS_VERSION = 1;
export const isDriverReport = (type: string) => type === "DASH" || type === "MVR";
export const savedPageText = (page: ExtractedPage) => page.text || page.blocks?.map(block => block.text).join("\n") || "";
export const reportHeader = (text: string) => text.split(/\n\s*(?:claims?\b|convictions?\b|historical operators?\b)/i)[0];
export function reportIdentity(text: string) {
  // Only the report header can identify its subject, never a historical operator row.
  const header = reportHeader(text);
  const pick = (pattern: RegExp) => header.match(pattern)?.[1]?.trim().toUpperCase();
  const sequence = text.match(/\bpage\s+(\d+)\s*(?:of|\/)\s*(\d+)\b/i);
  const paired = (label: string) => pick(new RegExp(`^${label}(?:[ \\t]*:[ \\t]*|[ \\t]+|[ \\t]*\\n[ \\t]*)([^\\n]+)`, "im"));
  const reportId = paired("report[ \\t]*(?:id|number|no\\.?)") ?? pick(/\breport\s*[:#]\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i);
  return {
    reportId,
    licence: paired("(?:report subject licence|licence number|driver licence|DLN|DL)")?.replace(/[ -]/g, ""),
    subjectName: paired("(?:report subject(?![ \\t]+licence)|driver name|subject name)"),
    reportDate: paired("report date"),
    page: sequence ? Number(sequence[1]) : undefined,
    total: sequence ? Number(sequence[2]) : undefined,
    continuation: /\bcontinued|\bcontinuation\b/i.test(text),
    restart: /^(?:new report|start of report)\b/im.test(text),
    titleHeader: /^(?:DASH|AutoPlus|Ontario Driving Record|MVR)\b/im.test(header),
  };
}

export function reportBoundary(group: PackagePage[], current: PackagePage): "CONTINUE" | "BOUNDARY" | "REVIEW" {
  const identities = group.map(page => reportIdentity(savedPageText(page)));
  const prior = identities.at(-1)!;
  const next = reportIdentity(savedPageText(current));
  if (next.page === 1 || next.restart || prior.page && prior.total && prior.page === prior.total) return "BOUNDARY";
  for (const key of ["reportId", "licence", "subjectName", "reportDate"] as const) {
    if (next[key] && identities.some(identity => identity[key] && identity[key] !== next[key])) return "BOUNDARY";
  }
  if (prior.total && next.total && prior.total !== next.total) return "REVIEW";
  if (prior.page && next.page && next.page !== prior.page + 1) return "REVIEW";
  const sameReport = Boolean(next.reportId && identities.some(identity => identity.reportId === next.reportId));
  const sameSubjectReport = Boolean(next.licence && next.reportDate && identities.some(identity => identity.licence === next.licence && identity.reportDate === next.reportDate));
  const anchored = identities.some(identity => identity.reportId || identity.licence || identity.subjectName && identity.reportDate);
  const sequence = Boolean(prior.page && next.page === prior.page + 1 && prior.total && prior.total === next.total);
  if (next.titleHeader && (next.licence || next.subjectName) && !sequence && !next.continuation) return "REVIEW";
  // A missing identifier is not a matching identifier. An anchored, printed sequence
  // can nevertheless carry pages that omit the repeated header.
  if (sameReport || sameSubjectReport && (sequence || next.continuation) || anchored && sequence) return "CONTINUE";
  return "REVIEW";
}

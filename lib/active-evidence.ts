import type { LogicalDocument, ParsedSource, UploadedDocumentRecord } from "./extraction-types.ts";

export function sectionRevision(section: LogicalDocument) {
  return JSON.stringify([section.physicalFileId, section.id, section.documentType, section.startPage ?? 1, section.endPage ?? section.startPage ?? 1, section.subjectType ?? "", section.subjectId ?? "", section.subjectName ?? ""]);
}

export function activeParsedSources(record: UploadedDocumentRecord): ParsedSource[] {
  if (record.staleExtraction || record.currentSourceHash === "MISSING" || (record.sourceHash && record.currentSourceHash && record.sourceHash !== record.currentSourceHash)) return [];
  return [...(record.parsedSources ?? []), ...(record.parsed ? [record.parsed] : [])].flatMap(source => {
    if (source.documentId !== record.id) return [];
    if (source.logicalDocumentId) {
      const section = record.logicalDocuments?.find(s => s.id === source.logicalDocumentId && s.presenceStatus === "FOUND");
      if (!section || section.documentType !== source.documentType || (source.sourceRevision && source.sourceRevision !== sectionRevision(section))) return [];
      // Legacy section results need a local reparse before a changed definition is trusted.
      if (!source.sourceRevision && section.updatedAt > source.parsedAt) return [];
      return [{ ...source, subjectId: section.subjectId ?? source.subjectId, subjectType: section.subjectType ?? source.subjectType, sourceRevision: source.sourceRevision ?? sectionRevision(section) }];
    }
    if (record.logicalDocuments !== undefined && (record.logicalDocuments.length !== 1 || record.logicalDocuments[0].documentType !== source.documentType || record.logicalDocuments[0].presenceStatus !== "FOUND")) return [];
    return source.documentType === record.documentType ? [source] : [];
  }).flatMap(source => {
    const children = (source.entities ?? []).filter(entity => !entity.excluded && entity.kind !== "POLICY_HISTORY")
      .map(entity => ({ ...source, entities: undefined, data: entity.data, fieldEvidence: entity.fieldEvidence,
        warnings: entity.warnings, entityId: entity.id, entityLabel: entity.label,
        subjectType: entity.kind, subjectId: undefined, excluded: false }));
    // Driver reports retain scalar compatibility in stored parsed JSON. Only the
    // entity-scoped copy contributes those fields to canonical reconciliation.
    const groupedKeys = new Set(source.entities?.filter(e=>e.kind==="DRIVER").flatMap(e=>Object.keys(e.data)) ?? []);
    const main = ["MVR","DASH"].includes(source.documentType) && children.length
      ? {...source,data:Object.fromEntries(Object.entries(source.data).filter(([key])=>!groupedKeys.has(key)))} : source;
    return [main, ...children];
  });
}

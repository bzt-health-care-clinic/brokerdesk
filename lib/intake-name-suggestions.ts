import type { DocumentType, ParsedSource, UploadedDocumentRecord } from "./extraction-types.ts";
import { sameNamedPersons } from "./intake-person-evidence.ts";

export interface SuggestedPolicyholder {
  name: string;
  role: "Named insured" | "Co-insured";
}

/**
 * Only use parsed fields from the currently selected, active application/quote
 * document (and matching logical section). OCR suggestions are untrusted hints.
 */
export function parsedPolicyholderSuggestions(
  records: UploadedDocumentRecord[], documentId: string | undefined,
  logicalDocumentId: string | undefined, documentType: DocumentType | undefined,
): SuggestedPolicyholder[] {
  if (!documentId || !documentType || !["AUTO_APPLICATION", "AUTO_QUOTE",
    "HAB_APPLICATION", "HAB_QUOTE"].includes(documentType)) return [];
  const record=records.find(r=>r.id===documentId);
  if (!record?.sourceHash || record.staleExtraction || record.currentSourceHash==="MISSING" ||
    (record.currentSourceHash && record.currentSourceHash!==record.sourceHash)) return [];
  const active=record.logicalDocuments??[];
  if (logicalDocumentId) {
    const section=active.find(s=>s.id===logicalDocumentId&&s.documentType===documentType&&
      s.presenceStatus==="FOUND");
    if (!section || (record.withdrawnSectionRanges??[]).some(range=>
      (section.startPage??1)<=range.endPage&&
      (section.endPage??section.startPage??1)>=range.startPage)) return [];
  } else if (active.length || record.documentType!==documentType ||
    record.withdrawnSectionRanges?.length) return [];

  const currentSources:ParsedSource[]=[...(record.parsedSources??[]),
    ...(record.parsed?[record.parsed]:[])].filter(source=>{
      if (source.documentType!==documentType) return false;
      if (source.logicalDocumentId===logicalDocumentId) return true;
      // Legacy single-section parsers may predate logicalDocumentId annotation.
      return Boolean(logicalDocumentId && !source.logicalDocumentId &&
        active.length===1 && active[0].id===logicalDocumentId &&
        active[0].documentType===documentType);
    });
  const result:SuggestedPolicyholder[]=[];
  const add=(raw:unknown,role:SuggestedPolicyholder["role"])=>{
    if(Array.isArray(raw)){for(const entry of raw)add(entry,role);return;}
    if(typeof raw!=="string")return;
    const name=raw.trim();
    if(!name || name.length>120 || !sameNamedPersons([name],[name]) ||
      result.some(existing=>sameNamedPersons([existing.name],[name])))return;
    result.push({name,role});
  };
  for(const source of currentSources) {
    add(source.data?.namedInsured,"Named insured");
    add(source.data?.coInsured,"Co-insured");
    add(source.data?.namedInsureds,"Named insured");
    add(source.data?.coInsureds,"Co-insured");
  }
  return result.slice(0,8);
}
/** Append only the chosen hint; never replace user-entered text or auto-verify. */
export function appendSuggestedPolicyholder(current:string, suggestion:string):string {
  const existing=current.split(/\r?\n/).map(n=>n.trim()).filter(Boolean);
  if (!sameNamedPersons([suggestion],[suggestion]) ||
    existing.some(name=>sameNamedPersons([name],[suggestion]))) return current;
  return [...existing,suggestion.trim()].join("\n");
}

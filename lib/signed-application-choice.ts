/**
 * Broker new-business signed-application chooser.
 * A visually "whole document" option must be bound to ONE real logical
 * document covering the page interval, never a virtual ID or the first page
 * of a fragmented G4Sign file.
 */
import type {
  DocumentType, UploadedDocumentRecord,
} from "./extraction-types.ts";
import {
  isApplicationType, signedApplicationCoverType,
  hasIndependentDocumentBoundary,
} from "./signed-application-grouping.ts";

export interface SignedApplicationChoice {
  id: string;
  documentId: string;
  logicalId: string | undefined;
  type: DocumentType;
  label: string;
  selectable: boolean;
}

export function signedApplicationSelectionValid(
  record: UploadedDocumentRecord,
  logicalDocumentId?: string,
): { valid: boolean; reason?: string } {
  if (!record.sourceHash || record.staleExtraction ||
    record.currentSourceHash === "MISSING" ||
    record.currentSourceHash && record.currentSourceHash !== record.sourceHash)
    return {valid:false,reason:"Source file is missing or changed."};
  const section=(record.logicalDocuments??[]).find(s=>
    s.id===logicalDocumentId && s.presenceStatus==="FOUND" &&
    isApplicationType(s.documentType));
  // Legacy standalone uploads with no sections retain the original gate.
  if (!section && record.logicalDocuments !== undefined) return {
    valid:false,reason:"No active signed application section."};
  const family=signedApplicationCoverType(record,record.packagePages??[]);
  if (!family) return {valid:true}; // no verified G4Sign cover: legacy checks remain
  const active=(record.logicalDocuments??[]).filter(s=>
    s.presenceStatus==="FOUND" && s.documentType===family);
  if (active.length!==1 || !section || section.documentType!==family)
    return {valid:false,reason:"Signed application is fragmented; regroup all application pages."};
  if ((record.withdrawnSectionRanges??[]).some(r=>
    (section.startPage??1)<=r.endPage &&
    (section.endPage??section.startPage??1)>=r.startPage))
    return {valid:false,reason:"Signed application contains withdrawn evidence."};
  const pages=[...(record.packagePages??[])].sort((a,b)=>a.page-b.page);
  const start=pages.find(p=>p.extractionStatus==="COMPLETE" &&
    p.page<=2 && (p.classification.documentType===family ||
      /(?:Ontario Application for Automobile Insurance|Habitational Insurance Application|Home Insurance Application)/i.test(p.text??"")))?.page;
  if (!start) return {valid:false,reason:"Application cover is not readable."};
  let expectedEnd=start-1;
  for(let n=start;n<=(record.pageCount??pages.at(-1)?.page??start);n++){
    const page=pages.find(p=>p.page===n);
    if (!page) return {valid:false,reason:"Application source has missing pages."};
    if (hasIndependentDocumentBoundary(page,family)) break;
    if (page.extractionStatus!=="COMPLETE" || !page.text?.trim())
      return {valid:false,reason:"Application has unreadable pages; OCR/review required."};
    if (page.classification.documentType!==family)
      return {valid:false,reason:"Application page boundary is not confirmed."};
    expectedEnd=n;
  }
  if ((section.startPage??1)!==start || (section.endPage??section.startPage??1)!==expectedEnd)
    return {valid:false,reason:"Selected section does not cover the complete application."};
  if (pages.some(p=>p.page>expectedEnd && p.classification.documentType===family))
    return {valid:false,reason:"Additional application pages remain outside the selected section."};
  return {valid:true};
}

export function signedApplicationChoices(
  records: UploadedDocumentRecord[], caseType: string,
): SignedApplicationChoice[] {
  const type: DocumentType=caseType==="new_auto"?"AUTO_APPLICATION":"HAB_APPLICATION";
  const result: SignedApplicationChoice[]=[];
  for(const record of records){
    if (!record.sourceHash || record.staleExtraction ||
      record.currentSourceHash==="MISSING" ||
      record.currentSourceHash && record.currentSourceHash!==record.sourceHash)
      continue;
    const sections=record.logicalDocuments===undefined
      ? [{id:undefined as string|undefined,documentType:record.documentType,
        startPage:1,endPage:record.pageCount,presenceStatus:"FOUND" as const}]
      : record.logicalDocuments;
    const apps=sections.filter(s=>s.presenceStatus==="FOUND" &&
      s.documentType===type &&
      !(record.withdrawnSectionRanges??[]).some(r=>
        (s.startPage??1)<=r.endPage && (s.endPage??s.startPage??1)>=r.startPage));
    if (!apps.length) continue;
    if (apps.length>1 && signedApplicationCoverType(record,record.packagePages??[])===type){
      result.push({id:record.id+"::needs-regroup",documentId:record.id,
        logicalId:undefined,type,selectable:false,
        label:`${record.fileName} — Signed Application fragmented (${apps.length} sections); regroup in Documents`});
      continue;
    }
    for(const sec of apps){
      const check=signedApplicationSelectionValid(record,sec.id);
      result.push({id:record.id+"::"+(sec.id??""),documentId:record.id,
        logicalId:sec.id,type,selectable:check.valid,
        label:`${record.fileName} — ${type} p.${sec.startPage??1}–${sec.endPage??sec.startPage??1}`+
          (check.valid?"":` — ${check.reason??"Review required"}`)});
    }
  }
  return result;
}

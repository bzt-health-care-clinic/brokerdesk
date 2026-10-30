export interface ReviewField {
  id: string;
  section: string;
  label: string;
  type: string;
  value: unknown;
  required: boolean;
  origin?: string;
  conflict?: boolean;
  evidence?: Array<{documentId:string;page:number;sourceHash:string}>;
}
export interface ReviewSection {
  id:string; title:string;
  status:"PENDING"|"CONFIRMED";
  confirmation?:{brokerId:string;confirmedAt:string}|null;
}
export interface BrokerReview {
  revision:number;
  review_status:"DRAFT"|"BROKER_CONFIRMED";
  company:string;
  case_type:string;
  sections:ReviewSection[];
  fields:ReviewField[];
}
// STEP5B08_KEYIN_COVERAGE: counts are catalog-level, not OCR accuracy or carrier coverage.
export interface BrokerKeyinCoverage {
  schemaVersion:string;
  totals:{catalogFields:number;required:number;missing:number;
    requiredMissing:number;sourceBound:number;brokerEdited:number;
    caseUnverified:number;conflicts:number;physicalReports:number};
  sections:Array<{id:string;total:number;missing:number;requiredMissing:number}>;
  fields:Array<{id:string;section:string;required:boolean;state:string;
    origin:string|null;evidenceCount:number}>;
  structuralIssues:string[];
  reconciliationIssues:string[];
  fieldIssues:string[];
  warnings:string[];
}
export interface BrokerReviewStatus {
  review:BrokerReview|null;
  keyinCoverage?:BrokerKeyinCoverage|null;
  sourceIssues:string[];
  fieldIssues:Array<{sectionId:string;message:string}>;
  confirmed:number;
  total:number;
  ready:boolean;
}
const API=process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL ?? "http://127.0.0.1:47831";
async function call<T>(caseId:string,path:string,method="GET",payload?:unknown):Promise<T> {
  const response=await fetch(`${API}/cases/${encodeURIComponent(caseId)}/broker-review${path}`,{
    method,cache:"no-store",
    ...(payload===undefined?{}:{headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)})
  });
  const parsed=await response.json().catch(()=>({error:"Local Broker Review API is unavailable."}));
  if(!response.ok) {
    const error=parsed as {error?:string;blockers?:string[]};
    throw new Error([error.error??`HTTP ${response.status}`,...(error.blockers??[])].join("\n"));
  }
  return parsed as T;
}
export const brokerReviewClient={
  load:(caseId:string)=>call<BrokerReviewStatus>(caseId,""),
  create:(caseId:string,actor:string)=>call<BrokerReviewStatus>(caseId,"","POST",{actor}),
  edit:(caseId:string,actor:string,expectedRevision:number,fieldId:string,value:unknown)=>
    call<BrokerReviewStatus>(caseId,"/fields","PATCH",{actor,expectedRevision,fieldId,value}),
  confirm:(caseId:string,actor:string,expectedRevision:number,sectionId:string)=>
    call<BrokerReviewStatus>(caseId,"/sections","POST",{actor,expectedRevision,sectionId}),
  rebuild:(caseId:string,actor:string,expectedRevision:number)=>
    call<BrokerReviewStatus>(caseId,"/rebuild","POST",{actor,expectedRevision}),
  remarksPreview:(caseId:string)=>call<{
    preview:{text:string;valid:boolean;missing:string[];needsManualCompletion:boolean;characters:number;limit:number|null};
    reviewRevision:number
  }>(caseId,"/remarks-preview"),
};

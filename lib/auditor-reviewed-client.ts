export interface ReviewedSheetRow {
  id:string;
  label:string;
  value:string;
  originalValue:unknown;
  source?:string;
  evidencePresent:boolean;
}
export interface ReviewedSheetSection {
  id:string;
  title:string;
  rows:ReviewedSheetRow[];
}
export interface ReviewedKeyinResponse {
  packageId:string;
  brokerId:string;
  finalizedAt:string;
  reviewedHash:string;
  sheet:{
    sourceCaseId:string;
    sourceReviewHash:string;
    brokerReview:"BROKER_CONFIRMED";
    sections:ReviewedSheetSection[];
  };
}
const API=process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL??"http://127.0.0.1:47831";

/** A known Case with no imported review returns 204; older local APIs may use 404.
 * Neither response can be labelled Broker-confirmed. */
export async function fetchAuditorReviewedKeyin(caseId:string):Promise<ReviewedKeyinResponse|null> {
  const response=await fetch(`${API}/cases/${encodeURIComponent(caseId)}/reviewed-keyin`, {
    cache:"no-store"
  });
  if(response.status===204 || response.status===404)return null;
  if(!response.ok){
    const error=(await response.json().catch(()=>null)) as {error?:unknown}|null;
    throw new Error(typeof error?.error==="string"?error.error:
      `Auditor worksheet failed (${response.status}).`);
  }
  const data=await response.json() as ReviewedKeyinResponse;
  if(data?.sheet?.brokerReview!=="BROKER_CONFIRMED" ||
      !Array.isArray(data?.sheet?.sections) ||
      data.sheet.sourceReviewHash!==data.reviewedHash)
    throw new Error("Received worksheet does not match a confirmed Broker snapshot.");
  return data;
}

import type { IntakeResult, ChangeAuthorization } from "./intake-profile.ts";
import type { InsuranceCase } from "./insurance-types.ts";
import type { DiscountKind, IntakeWarningFacts, SupportPurpose, SelectedDiscount } from "./intake-support-evidence.ts";

export interface BrokerIdentity { id: string; name: string }
export interface InboxCase {
  package_id: string; source_case_id: string; case_id: string; revision: number;
  system: "new-business" | "policy-change"; broker_id: string; broker_name: string;
  submitted_at: string; imported_at: string; label: string; insured_name: string;
  carrier: string; status: "pending" | "in_progress" | "completed";
  assignee: string | null; lease_until: string | null; effective_date: string;
  warnings: Array<{code:string;message:string;field?:string;vehicle_id?:string}>;
}
const API = process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL ?? "http://127.0.0.1:47831";
async function checked(response: Response) {
  if (response.ok) return response;
  const problem = await response.json().catch(() => ({error:"Local submission service unavailable."})) as {
    error?: string; blockers?: Array<{code:string;message:string}> };
  const explanation = problem.blockers?.length ? "\n" + problem.blockers.map(b => b.message).join("\n") : "";
  throw Error((problem.error ?? `Submission request failed (HTTP ${response.status}).`) + explanation);
}
export async function pilotPreflight(id: string): Promise<IntakeResult> {
  const response = await checked(await fetch(`${API}/cases/${encodeURIComponent(id)}/preflight`, {cache:"no-store"}));
  return response.json();
}
export async function pilotDownload(id: string, broker: BrokerIdentity): Promise<string> {
  const response = await checked(await fetch(`${API}/cases/${encodeURIComponent(id)}/bdzip`, {
    method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({broker}) }));
  const cd = response.headers.get("Content-Disposition");
  const filename = cd?.match(/filename="([^"]+\.bdzip)"/)?.[1] ?? "BrokerDesk-submission.bdzip";
  const url = URL.createObjectURL(await response.blob());
  try {
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.style.display = "none";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 2000); }
  return filename;
}
export async function pilotCompareInsuredNames(id:string,request:{
  verified:boolean;applicationDocumentId?:string;applicationLogicalDocumentId?:string;
  quoteDocumentId?:string;quoteLogicalDocumentId?:string;
  applicationNames?:string[];quoteNames?:string[];
}):Promise<InsuranceCase>{
  const response=await checked(await fetch(API+"/cases/"+encodeURIComponent(id)+"/insured-name-comparison",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)}));
  return response.json();
}
export async function pilotAuthorize(id: string,
  request: {verified: boolean; documentId?: string; logicalDocumentId?: string; signers?: Array<{
    name:string;documentId:string;logicalDocumentId?:string;signaturePage:number;verified:boolean;
  }>; }): Promise<InsuranceCase> {
  const response = await checked(await fetch(`${API}/cases/${encodeURIComponent(id)}/change-authorization`,{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)}));
  return response.json();
}
export async function pilotSelectOpcf43Vehicle(id:string,vehicleKey:string,verified=true):Promise<InsuranceCase>{
  const response=await checked(await fetch(API+"/cases/"+encodeURIComponent(id)+"/opcf43-vehicle-target",{
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({vehicleKey,verified})}));
  return response.json();
}
export async function pilotSupportProof(id:string,request:{
  action:"verify"|"revoke";purpose:SupportPurpose;code:string;subjectKey:string;confirmed?:boolean;
  documentId?:string;logicalDocumentId?:string;signaturePage?:number;signerName?:string;
}):Promise<InsuranceCase>{
  const response=await checked(await fetch(API+"/cases/"+encodeURIComponent(id)+"/intake-proof",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(request)}));
  return response.json();
}
export async function pilotDiscountReview(id:string,selections:SelectedDiscount[]):Promise<InsuranceCase>{
  const response=await checked(await fetch(API+"/cases/"+encodeURIComponent(id)+"/discount-review",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selections})}));
  return response.json();
}
export async function pilotWarningFacts(id:string,facts:IntakeWarningFacts):Promise<InsuranceCase>{
  const response=await checked(await fetch(API+"/cases/"+encodeURIComponent(id)+"/warning-facts",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(facts)}));
  return response.json();
}
export async function pilotImport(file: File) {
  const response = await checked(await fetch(`${API}/submissions/import?filename=${encodeURIComponent(file.name)}`, {
    method:"POST",headers:{"Content-Type":"application/zip"},body:file }));
  return response.json() as Promise<{imported:boolean;duplicate:boolean;package_id:string;case_id:string;system:string}>;
}
export async function pilotInbox(system: "new-business" | "policy-change"): Promise<InboxCase[]> {
  const response=await checked(await fetch(`${API}/inbox?system=${system}`,{cache:"no-store"}));
  return response.json();
}
export async function pilotTaskAction(packageId:string,action:"claim"|"release"|"renew"|"complete") {
  const response=await checked(await fetch(`${API}/inbox/${encodeURIComponent(packageId)}/${action}`,{method:"POST"}));
  return response.json();
}

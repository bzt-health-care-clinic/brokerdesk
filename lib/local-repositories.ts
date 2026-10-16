import type { InsuranceCase } from "./insurance-types.ts";
import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { refreshParserVersion } from "./local-reparse.ts";

export interface CaseSummary { id: string; label: string; insuredName: string; caseType: string; carrier: string; policyNumber: string; quoteNumber: string; status: string; archived: boolean; createdAt: string; updatedAt: string; }
export interface StorageStats { dataLocation: string; database: string; documentsPath: string; backupsPath: string; caseCount: number; documentCount: number; documentBytes: number; lastBackupAt: string | null; }
export interface BootstrapPayload { cases: CaseSummary[]; selected: InsuranceCase | null; documents: UploadedDocumentRecord[]; notes: Record<string, string>; }
export interface CaseRepository { list(search?: string, archived?: boolean): Promise<CaseSummary[]>; get(id: string): Promise<InsuranceCase>; create(item: InsuranceCase): Promise<InsuranceCase>; save(item: InsuranceCase): Promise<InsuranceCase>; rename(id: string, label: string): Promise<InsuranceCase>; archive(id: string): Promise<void>; delete(id: string): Promise<void>; recordAction(id: string, action: string, details?: Record<string, unknown>, documentId?: string): Promise<void>; signedTransition(item: InsuranceCase, action: string, details?: Record<string, unknown>): Promise<InsuranceCase>; }
export interface DocumentRepository { list(caseId: string): Promise<UploadedDocumentRecord[]>; upload(caseId: string, file: File, record: UploadedDocumentRecord): Promise<UploadedDocumentRecord>; update(record: UploadedDocumentRecord): Promise<UploadedDocumentRecord>; rename(recordId: string, filename: string): Promise<UploadedDocumentRecord>; replace(recordId: string, file: File, replacement: UploadedDocumentRecord): Promise<UploadedDocumentRecord>; delete(recordId: string): Promise<void>; openUrl(recordId: string): string; fetchFile(record: UploadedDocumentRecord): Promise<File>; }
export interface NoteRepository { get(caseId: string): Promise<Record<string, string>>; save(caseId: string, type: string, text: string): Promise<void>; }
export interface StorageRepository { stats(): Promise<StorageStats>; exportBackup(): Promise<{ path: string; filename: string }>; cleanTemp(): Promise<{ removed: number }>; openFolder(): Promise<void>; }

const API = process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL ?? "http://127.0.0.1:47831";
async function request<T>(path: string, init?: RequestInit): Promise<T> { const response = await fetch(`${API}${path}`, init); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error((body as { error?: string }).error ?? "Local storage is unavailable."); return body as T; }
const jsonInit = (method: string, body?: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

export class HttpCaseRepository implements CaseRepository {
  list(search = "", archived = false) { return request<CaseSummary[]>(`/cases?search=${encodeURIComponent(search)}&archived=${archived}`); }
  get(id: string) { return request<InsuranceCase>(`/cases/${encodeURIComponent(id)}`); }
  create(item: InsuranceCase) { return request<InsuranceCase>("/cases", jsonInit("POST", { case: item })); }
  save(item: InsuranceCase) { return request<InsuranceCase>(`/cases/${encodeURIComponent(item.case_id)}`, jsonInit("PUT", { case: item })); }
  rename(id: string, label: string) { return request<InsuranceCase>(`/cases/${encodeURIComponent(id)}`, jsonInit("PATCH", { action: "rename", label })); }
  async archive(id: string) { await request(`/cases/${encodeURIComponent(id)}`, jsonInit("PATCH", { action: "archive" })); }
  async delete(id: string) { await request(`/cases/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  async recordAction(id: string, action: string, details: Record<string, unknown> = {}, documentId?: string) { await request(`/cases/${encodeURIComponent(id)}/actions`, jsonInit("POST", { action, details, documentId })); }
  signedTransition(item: InsuranceCase, action: string, details: Record<string, unknown> = {}) { return request<InsuranceCase>(`/cases/${encodeURIComponent(item.case_id)}/signed-verification`, jsonInit("POST", { case: item, action, details })); }
}

export class HttpDocumentRepository implements DocumentRepository {
  async refresh(record: UploadedDocumentRecord) { const next = await refreshParserVersion(record); return next === record ? record : this.update(next); }
  async list(caseId: string) { return Promise.all((await request<UploadedDocumentRecord[]>(`/cases/${encodeURIComponent(caseId)}/documents`)).map(record => this.refresh(record))); }
  upload(caseId: string, file: File, record: UploadedDocumentRecord) { const body = new FormData(); body.append("file", file); body.append("record", JSON.stringify(record)); return request<UploadedDocumentRecord>(`/cases/${encodeURIComponent(caseId)}/documents`, { method: "POST", body }); }
  update(record: UploadedDocumentRecord) { return request<UploadedDocumentRecord>(`/documents/${encodeURIComponent(record.id)}`, jsonInit("PUT", { record })); }
  rename(recordId: string, filename: string) { return request<UploadedDocumentRecord>(`/documents/${encodeURIComponent(recordId)}/rename`, jsonInit("POST", { filename })); }
  replace(recordId: string, file: File, replacement: UploadedDocumentRecord) { const body = new FormData(); body.append("file", file); body.append("record", JSON.stringify(replacement)); return request<UploadedDocumentRecord>(`/documents/${encodeURIComponent(recordId)}/replace`, { method: "POST", body }); }
  async delete(recordId: string) { await request(`/documents/${encodeURIComponent(recordId)}`, { method: "DELETE" }); }
  openUrl(recordId: string) { return `${API}/documents/${encodeURIComponent(recordId)}/file`; }
  async fetchFile(record: UploadedDocumentRecord) { const response = await fetch(this.openUrl(record.id)); if (!response.ok) throw new Error("Saved document is unavailable."); return new File([await response.blob()], record.fileName, { type: record.mimeType }); }
}

export class HttpNoteRepository implements NoteRepository {
  get(caseId: string) { return request<Record<string, string>>(`/cases/${encodeURIComponent(caseId)}/notes`); }
  async save(caseId: string, type: string, text: string) { await request(`/cases/${encodeURIComponent(caseId)}/notes`, jsonInit("PUT", { type, text })); }
}

export class HttpStorageRepository implements StorageRepository {
  stats() { return request<StorageStats>("/settings/storage"); }
  exportBackup() { return request<{ path: string; filename: string }>("/settings/backup", { method: "POST" }); }
  async cleanTemp() { return request<{ removed: number }>("/settings/clean-temp", { method: "POST" }); }
  async openFolder() { await request("/settings/open-folder", { method: "POST" }); }
}

export class HttpBootstrapRepository {
  async load(preferredCaseId?: string | null) {
    const suffix = preferredCaseId ? `?caseId=${encodeURIComponent(preferredCaseId)}` : "";
    const payload = await request<BootstrapPayload>(`/bootstrap${suffix}`);
    return { ...payload, documents: await Promise.all(payload.documents.map(record => new HttpDocumentRepository().refresh(record))) };
  }
}

export const localRepositories = { bootstrap: new HttpBootstrapRepository(), cases: new HttpCaseRepository(), documents: new HttpDocumentRepository(), notes: new HttpNoteRepository(), storage: new HttpStorageRepository() };

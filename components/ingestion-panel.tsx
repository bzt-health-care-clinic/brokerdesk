"use client";

import { RefObject, useEffect, useMemo, useRef, useState } from "react";
import { FileSearch, RefreshCw, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { applyManualCorrection, BrowserFileStore, classifyDocument, ingestFiles, LocalTextProvider, reprocessDocument } from "@/lib/document-ingestion";
import { DocumentType, LogicalDocument, UploadedDocumentRecord } from "@/lib/extraction-types";
import { DocumentRepository } from "@/lib/local-repositories";
import { EmbeddedPdfTextProvider, HttpOcrSpaceTransport, HttpPaddleOcrTransport, OcrServerHealth, OcrSpaceProvider, OptionalAzureDocumentProvider, PaddleOcrProvider, RoutingDocumentExtractor } from "@/lib/ocr-providers";
import { getCanonicalInstitution, InstitutionRole } from "@/lib/institution-directory";
import { DOCUMENT_UPLOAD_ACCEPT, openDocumentPicker } from "@/lib/file-picker";
import { suggestDocumentFilename } from "@/lib/document-filenames";
import { acceptedDroppedFiles } from "@/lib/document-drop";
import { analyzePdfPackage, getBrowserPdfAdapter, packageFailureRecord } from "@/lib/package-analysis";
import { hasReusableText, reparseDocument, updateLogicalSections } from "@/lib/local-reparse";
import { documentOcrUi } from "@/lib/document-ocr-ui";

const LOCAL_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

export const DOCUMENT_TYPES: DocumentType[] = ["AUTO_APPLICATION", "AUTO_QUOTE", "OWNERSHIP", "BILL_OF_SALE", "VEHICLE_PHOTO", "SAFETY_INSPECTION", "STUDENT_PROOF", "ANTI_THEFT_PROOF", "RETIREMENT_PROOF", "MVR", "DASH", "DRIVER_TRAINING_CERTIFICATE", "PAYMENT_AUTHORIZATION", "CANCELLATION_REQUEST", "WINTER_TIRE_PROOF", "PRIOR_AUTO_POLICY", "LEASE_DOCUMENT", "FINANCE_DOCUMENT", "OPCF_FORM", "POLICY_CHANGE", "PORTAL_SCREENSHOT", "HAB_APPLICATION", "HAB_QUOTE", "PRIOR_PROPERTY_POLICY", "MORTGAGE_DOCUMENT", "CTSAC_MEMBERSHIP_APPLICATION", "DIPLOMA", "DEGREE_CERTIFICATE", "VOID_CHEQUE", "OTHER"];
const DOCUMENT_LABELS: Partial<Record<DocumentType, string>> = { AUTO_APPLICATION: "Signed Application", AUTO_QUOTE: "Auto Quote", BILL_OF_SALE: "Bill of Sale", VEHICLE_PHOTO: "Vehicle Photo", SAFETY_INSPECTION: "Vehicle Safety Inspection", STUDENT_PROOF: "Student Discount Evidence", ANTI_THEFT_PROOF: "Anti-theft Installation / Activation Evidence", RETIREMENT_PROOF: "Retirement Discount Evidence", DASH: "DASH / AutoPlus", DRIVER_TRAINING_CERTIFICATE: "Graduation Certificate", PAYMENT_AUTHORIZATION: "Payment Authorization", CANCELLATION_REQUEST: "Cancellation Request", LEASE_DOCUMENT: "Lease Agreement", OPCF_FORM: "OPCF / Endorsement Form", POLICY_CHANGE: "Policy Change Document" };
const label = (value: string) => DOCUMENT_LABELS[value as DocumentType] ?? value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
function recordText(record: UploadedDocumentRecord) { return record.raw?.normalizedText ?? record.raw?.rawText ?? record.raw?.text ?? record.packagePages?.map((page) => page.text ?? "").filter(Boolean).join("\n\n") ?? ""; }

function canonicalFor(record: UploadedDocumentRecord) {
  const data = record.parsed?.data ?? {};
  const choices: { role: InstitutionRole; name: unknown }[] = [
    { role: "lessor", name: data.lessor }, { role: "lienholder", name: data.lienholder }, { role: "mortgagee", name: data.mortgagee },
  ];
  for (const choice of choices) if (typeof choice.name === "string") {
    const match = getCanonicalInstitution(choice.role, choice.name);
    if (match) return { role: choice.role, ...match };
  }
  return null;
}

export function IngestionPanel({ caseId, insuredName, records, repository, onChange, onAudit, inputRef, subjects = [] }: { subjects?: { id: string; type: string; label: string }[]; caseId: string; insuredName?: string; records: UploadedDocumentRecord[]; repository: DocumentRepository; onChange: (records: UploadedDocumentRecord[]) => void; onAudit?: (action: string, documentId?: string) => void; inputRef?: RefObject<HTMLInputElement | null> }) {
  const store = useMemo(() => new BrowserFileStore(), []);
  const ocrTransport = useMemo(() => new HttpPaddleOcrTransport(), []);
  const cloudTransport = useMemo(() => new HttpOcrSpaceTransport(), []);
  const cloudProvider = useMemo(() => new OcrSpaceProvider(store, cloudTransport), [store, cloudTransport]);
  const extractor = useMemo(() => new RoutingDocumentExtractor([new LocalTextProvider(store), new EmbeddedPdfTextProvider(store), cloudProvider, new PaddleOcrProvider(store, ocrTransport), new OptionalAzureDocumentProvider()]), [store, cloudProvider, ocrTransport]);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = inputRef ?? internalInputRef;
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const [ocrHealth, setOcrHealth] = useState<OcrServerHealth>({ state: "NOT_CONFIGURED" });
  const [ocrProcessingId, setOcrProcessingId] = useState<string | null>(null);
  const [autoOcr, setAutoOcr] = useState(true);

  useEffect(() => { const timer = window.setTimeout(() => { void cloudTransport.health().then(setOcrHealth).catch(() => setOcrHealth({ state: "OFFLINE" })); }, 250); return () => window.clearTimeout(timer); }, [cloudTransport]);
  useEffect(() => { setAutoOcr(window.localStorage.getItem("brokerdesk.autoOcrOnUpload") !== "false"); }, []);
  useEffect(() => {
    const preventFileNavigation = (event: DragEvent) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); };
    document.addEventListener("dragover", preventFileNavigation);
    document.addEventListener("drop", preventFileNavigation);
    return () => { document.removeEventListener("dragover", preventFileNavigation); document.removeEventListener("drop", preventFileNavigation); };
  }, []);

  async function persistPackageFailure(record: UploadedDocumentRecord, error: unknown, baseRecords = records) {
    const failed = packageFailureRecord(record, error);
    const persisted = await repository.update(failed).catch(() => failed); onChange(baseRecords.map((item) => item.id === record.id ? persisted : item)); return persisted;
  }

  async function upload(files: FileList | File[] | null) {
    if (!files || files.length === 0) return;
    const sourceFiles = Array.from(files);
    const oversized = sourceFiles.filter((file) => file.size > LOCAL_UPLOAD_LIMIT_BYTES);
    if (oversized.length) { window.alert(`${oversized.map((file) => file.name).join(", ")} exceeds the 50 MB local upload limit. Split or compress the file, then try again.`); return; }
    setBusy(true);
    let currentHealth = ocrHealth;
    try {
      if (autoOcr) { try { currentHealth = await cloudTransport.health(); } catch { currentHealth = { state: "OFFLINE" }; } setOcrHealth(currentHealth); }
      cloudProvider.setAutoEnabled(autoOcr && currentHealth.state === "ONLINE");
      const added: UploadedDocumentRecord[] = [];
      for (const file of sourceFiles) {
        if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) { const id = crypto.randomUUID(); store.register(id, file); const classification = classifyDocument(file.name, file.type); added.push({ id, fileName: file.name, mimeType: file.type || "application/pdf", size: file.size, documentType: classification.documentType, classification, state: "UPLOADED", logicalDocuments: [], packageProgress: { status: "NOT_STARTED", processed: 0, total: 0, embedded: 0, ocr: 0, failed: 0, updatedAt: new Date().toISOString() } }); }
        else { const [record] = await ingestFiles([file], store, extractor); added.push(record); }
      }
      const results = await Promise.allSettled(added.map((record, index) => repository.upload(caseId, sourceFiles[index], record)));
      const savedEntries = results.flatMap((result, index) => result.status === "fulfilled" ? [{ record: result.value, file: sourceFiles[index] }] : []);
      const failedUploads = results.flatMap((result, index) => result.status === "rejected" ? [sourceFiles[index].name] : []);
      if (failedUploads.length) window.alert(`Could not save: ${failedUploads.join(", ")}. Other files in this batch were kept.`);
      let combined = [...records, ...savedEntries.map((entry) => entry.record)]; onChange(combined);
      for (const entry of savedEntries) if (entry.record.mimeType === "application/pdf" || /\.pdf$/i.test(entry.record.fileName)) {
        try { const pdfAdapter = await getBrowserPdfAdapter(); const updated = await analyzePdfPackage(entry.record, entry.file, pdfAdapter, { extract: async (page) => { if (!autoOcr || currentHealth.state !== "ONLINE") throw new Error("OCR.Space is unavailable; embedded pages remain usable and scanned pages can be retried."); return cloudTransport.extract(page, { pageCount: 1 }); } }, { maxOcrBytes: currentHealth.maxFileBytes ?? 1024 * 1024, concurrency: Number(window.localStorage.getItem("brokerdesk.packageOcrConcurrency") || 1), onProgress: async (progress) => { const persisted = await repository.update(progress); combined = combined.map((item) => item.id === persisted.id ? persisted : item); onChange([...combined]); } }); combined = combined.map((item) => item.id === updated.id ? updated : item); onChange([...combined]); }
        catch (error) { const failed = await persistPackageFailure(entry.record, error, combined); combined = combined.map((item) => item.id === failed.id ? failed : item); }
      }
    } finally {
      cloudProvider.setAutoEnabled(false);
      setBusy(false);
      if (pickerRef.current) pickerRef.current.value = "";
    }
  }

  async function reprocess(record: UploadedDocumentRecord) {
    const updated = await reparseDocument(record);
    await repository.update(updated);
    onChange(records.map((item) => item.id === record.id ? updated : item));
  }
  async function runCloudOcr(record: UploadedDocumentRecord, force = false) {
    if (!force && hasReusableText(record) && !record.packagePages?.some(p => p.extractionStatus !== "COMPLETE" || !p.text?.trim())) { await reprocess(record); return; }
    if (ocrHealth.state === "NOT_CONFIGURED") { window.alert("OCR.Space is not configured. Configure it on the local server and restart BrokerDesk."); return; }
if (record.mimeType === "application/pdf" || /\.pdf$/i.test(record.fileName)) { setOcrProcessingId(record.id); try { if (force || record.sourceHash !== record.currentSourceHash || !store.get(record.id)) store.register(record.id, await repository.fetchFile(record)); const file = store.get(record.id)!; const pdfAdapter = await getBrowserPdfAdapter(); const updated = await analyzePdfPackage(record, file, pdfAdapter, cloudTransport, { maxOcrBytes: ocrHealth.maxFileBytes ?? 1024 * 1024, concurrency: Number(window.localStorage.getItem("brokerdesk.packageOcrConcurrency") || 1), force, onProgress: async (progress) => { const persisted = await repository.update(progress); onChange(records.map((item) => item.id === record.id ? persisted : item)); } }); const persisted = await repository.update(updated); onChange(records.map((item) => item.id === record.id ? persisted : item)); } catch (error) { await persistPackageFailure(record, error); } finally { setOcrProcessingId(null); } return; }
    const section = record.logicalDocuments?.find((item) => item.presenceStatus === "FOUND"); cloudProvider.enableOnce(record.id, { pageCount: record.pageCount, startPage: section?.startPage, endPage: section?.endPage }); setOcrProcessingId(record.id);
    try {
      const file = await repository.fetchFile(record); store.register(record.id, file);
      const sourceHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), b => b.toString(16).padStart(2, "0")).join("");
      const updated = await reprocessDocument({ ...record, sourceHash, currentSourceHash: sourceHash }, extractor, true);
      await repository.update(updated); onChange(records.map(item => item.id === record.id ? updated : item));
    } catch (error) { await persistPackageFailure(record, error); } finally { setOcrProcessingId(null); }
  }

  async function reviewSuggestion(record: UploadedDocumentRecord, id: string, status: "ACCEPTED" | "IGNORED") { const changed = { ...record, suggestedSections: record.suggestedSections?.map((item) => item.id === id ? { ...item, suggestionStatus: status } : item) }; const updated = await updateLogicalSections({ ...record, suggestedSections: changed.suggestedSections }, [...(record.logicalDocuments ?? []).filter(s => s.classificationSource === "MANUAL"), ...(changed.suggestedSections ?? []).filter(s => s.suggestionStatus === "ACCEPTED")]); const persisted = await repository.update(updated); onChange(records.map((item) => item.id === record.id ? persisted : item)); }
  async function acceptAllSuggestions(record: UploadedDocumentRecord) { const changed = { ...record, suggestedSections: record.suggestedSections?.map((item) => ({ ...item, suggestionStatus: "ACCEPTED" as const })) }; const updated = await updateLogicalSections({ ...record, suggestedSections: changed.suggestedSections }, [...(record.logicalDocuments ?? []).filter(s => s.classificationSource === "MANUAL"), ...(changed.suggestedSections ?? []).filter(s => s.suggestionStatus === "ACCEPTED")]); const persisted = await repository.update(updated); onChange(records.map((item) => item.id === record.id ? persisted : item)); }
  async function editSuggestion(record: UploadedDocumentRecord, section: NonNullable<UploadedDocumentRecord["suggestedSections"]>[number]) { const type = window.prompt(`Document type:\n${DOCUMENT_TYPES.join(", ")}`, section.documentType) as DocumentType | null; if (!type || !DOCUMENT_TYPES.includes(type)) return; const startPage = Number(window.prompt("Start page:", String(section.startPage ?? 1))); const endPage = Number(window.prompt("End page:", String(section.endPage ?? startPage))); if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) return; const stamp = new Date().toISOString(); const manual = { ...section, id: crypto.randomUUID(), documentType: type, title: label(type), startPage, endPage, classificationSource: "MANUAL" as const, classificationConfidence: 1, createdAt: stamp, updatedAt: stamp }; const changed = { ...record, logicalDocuments: [...(record.logicalDocuments ?? []).filter((item) => item.id !== section.id), manual], suggestedSections: record.suggestedSections?.map((item) => item.id === section.id ? { ...item, suggestionStatus: "IGNORED" as const } : item) }; const updated = await updateLogicalSections({ ...record, suggestedSections: changed.suggestedSections }, changed.logicalDocuments); const persisted = await repository.update(updated); onChange(records.map((item) => item.id === record.id ? persisted : item)); }

  function correctExtraction(record: UploadedDocumentRecord) {
    const fields = Object.keys(record.parsed?.data ?? {});
    if (!fields.length) return;
    const field = window.prompt(`Field to correct:\n${fields.join(", ")}`, fields[0]);
    if (!field || !fields.includes(field)) return;
    const value = window.prompt("Correct value:", String(record.parsed?.data[field] ?? ""));
    if (value === null) return;
    const corrected = applyManualCorrection(record, field, value);
    void repository.update(corrected);
    onAudit?.("OCR_CORRECTION", record.id);
    onChange(records.map((item) => item.id === record.id ? corrected : item));
  }

  async function reclassify(record: UploadedDocumentRecord, documentType: DocumentType) {
    const stamp = new Date().toISOString();
    const logicalDocuments = record.logicalDocuments?.length ? record.logicalDocuments.map((item, index) => index === 0 ? { ...item, documentType, title: label(documentType), presenceStatus: "FOUND" as const, classificationSource: "MANUAL" as const, classificationConfidence: 1, validationStatus: "NOT_EVALUATED" as const, updatedAt: stamp } : item) : [{ id: crypto.randomUUID(), physicalFileId: record.id, documentType, title: label(documentType), startPage: 1, endPage: record.pageCount, presenceStatus: "FOUND" as const, parseStatus: "NOT_EVALUATED" as const, validationStatus: "NOT_EVALUATED" as const, classificationSource: "MANUAL" as const, classificationConfidence: 1, createdAt: stamp, updatedAt: stamp }];
    const changed = { ...record, documentType, logicalDocuments, classification: { documentType, confidence: 1, reason: "Manually classified by broker." }, state: "CLASSIFIED" as const };
    const updated = await repository.update({ ...await updateLogicalSections(record, logicalDocuments), documentType, classification: changed.classification });
    onChange(records.map((item) => item.id === record.id ? updated : item));
  }

  function chooseSubject(type?: string, previousId?: string) {
    const candidates = subjects.filter(s => s.type === type);
    if (!candidates.length) return undefined;
    const previous = candidates.findIndex(s => s.id === previousId);
    const answer = window.prompt(`Associate section with a specific ${type?.toLowerCase()} (blank = unassigned):\n${candidates.map((s, i) => `${i + 1}. ${s.label}`).join("\n")}`, previous < 0 ? "" : String(previous + 1));
    if (answer === null) return previousId;
    return candidates[Number(answer) - 1]?.id;
  }
  async function saveSections(record: UploadedDocumentRecord, logicalDocuments: LogicalDocument[]) { const updated = await repository.update(await updateLogicalSections(record, logicalDocuments)); onChange(records.map((item) => item.id === record.id ? updated : item)); }
  async function addSection(record: UploadedDocumentRecord) {
    const type = window.prompt(`Document type:\n${DOCUMENT_TYPES.join(", ")}`, "AUTO_APPLICATION") as DocumentType | null; if (!type || !DOCUMENT_TYPES.includes(type)) return;
    const startPage = Number(window.prompt("Start page:", "1")); const endPage = Number(window.prompt("End page:", String(startPage))); if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) return;
    const subjectName = window.prompt("Driver or vehicle name (optional):", "") || undefined; const subjectType = subjectName ? (window.prompt("Subject type (DRIVER or VEHICLE):", ["MVR", "DASH", "DRIVER_TRAINING_CERTIFICATE"].includes(type) ? "DRIVER" : "VEHICLE") || undefined) : undefined; const documentSubtype = type === "VEHICLE_PHOTO" ? (window.prompt("Photo view (FRONT, REAR, LEFT, RIGHT, VIN, DAMAGE or OTHER):", "FRONT") || undefined) : undefined; const stamp = new Date().toISOString();
    const subjectId = chooseSubject(subjectType);
    await saveSections(record, [...(record.logicalDocuments ?? []), { id: crypto.randomUUID(), physicalFileId: record.id, documentType: type, title: label(type), startPage, endPage, subjectName, subjectType, subjectId, documentSubtype, presenceStatus: "FOUND", parseStatus: "NOT_EVALUATED", validationStatus: "NOT_EVALUATED", classificationSource: "MANUAL", classificationConfidence: 1, createdAt: stamp, updatedAt: stamp }]);
  }
  async function editSection(record: UploadedDocumentRecord, section: LogicalDocument) {
    const type = window.prompt(`Document type:\n${DOCUMENT_TYPES.join(", ")}`, section.documentType) as DocumentType | null; if (!type || !DOCUMENT_TYPES.includes(type)) return;
    const startPage = Number(window.prompt("Start page:", String(section.startPage ?? 1))); const endPage = Number(window.prompt("End page:", String(section.endPage ?? startPage))); if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) return;
    const subjectName = window.prompt("Driver or vehicle name (optional):", section.subjectName ?? "") || undefined; const subjectType = subjectName ? (window.prompt("Subject type (DRIVER or VEHICLE):", section.subjectType ?? (["MVR", "DASH", "DRIVER_TRAINING_CERTIFICATE"].includes(type) ? "DRIVER" : "VEHICLE")) || undefined) : undefined; const documentSubtype = type === "VEHICLE_PHOTO" ? (window.prompt("Photo view (FRONT, REAR, LEFT, RIGHT, VIN, DAMAGE or OTHER):", section.documentSubtype ?? "FRONT") || undefined) : undefined;
    const subjectId = chooseSubject(subjectType, section.subjectId);
    await saveSections(record, (record.logicalDocuments ?? []).map((item) => item.id === section.id ? { ...item, documentType: type, title: label(type), startPage, endPage, subjectName, subjectType, subjectId, documentSubtype, presenceStatus: "FOUND", classificationSource: "MANUAL", validationStatus: "NOT_EVALUATED", updatedAt: new Date().toISOString() } : item));
  }
  async function renameSaved(record: UploadedDocumentRecord) {
    const suggestion = suggestDocumentFilename(record, insuredName); if (!suggestion) return;
    const filename = window.prompt(`Current filename:\n${record.currentFileName ?? record.fileName}\n\nSuggested filename:\n${suggestion}\n\nEdit the suggestion if needed, choose OK to apply, or Cancel to keep the original.`, suggestion);
    if (!filename?.trim()) return; const updated = await repository.rename(record.id, filename.trim()); onChange(records.map((item) => item.id === record.id ? updated : item));
  }

  async function deleteSaved(record: UploadedDocumentRecord) {
    if (!window.confirm(`Delete ${record.fileName}?\n\nThis permanently removes the local file, extracted source data, and related evidence. This action cannot be undone.`)) return;
    await repository.delete(record.id);
    onChange(records.filter((item) => item.id !== record.id));
  }

  async function replaceSaved(record: UploadedDocumentRecord) {
    const picker = document.createElement("input"); picker.type = "file"; picker.accept = ".pdf,image/*,.txt,.json,.csv,.xml";
    picker.onchange = async () => { const file = picker.files?.[0]; if (!file) return; const [replacement] = await ingestFiles([file], store, extractor); await repository.replace(record.id, file, replacement); onChange(records.map((item) => item.id === record.id ? replacement : item)); };
    picker.click();
  }

  return <div className="ingestion-block">
    <div className={`ocr-health state-${ocrHealth.state.toLowerCase()}`} role="status" aria-live="polite"><span className="ocr-health-dot" /><div><strong>OCR.Space · {label(ocrHealth.state)}</strong><small>{ocrHealth.state === "ONLINE" ? "Cloud Test Provider · 1 MB / 3 pages default" : ocrHealth.state === "NOT_CONFIGURED" ? "Configure OCR.Space on the local server to enable test OCR" : "Manual review remains available"}</small></div><label className="auto-ocr-toggle"><input type="checkbox" checked={autoOcr} onChange={(event) => { setAutoOcr(event.target.checked); window.localStorage.setItem("brokerdesk.autoOcrOnUpload", String(event.target.checked)); }} /> Auto OCR on upload</label><Button variant="outline" size="sm" type="button" onClick={() => void cloudTransport.health().then(setOcrHealth).catch(() => setOcrHealth({ state: "OFFLINE" }))}>Check</Button></div>
    <input ref={pickerRef} className="sr-only" type="file" multiple accept={DOCUMENT_UPLOAD_ACCEPT} onChange={(event) => upload(event.target.files)} />
    <div className={`upload-zone active-upload${dragOver ? " is-drag-over" : ""}`} onClick={() => !busy && openDocumentPicker(pickerRef.current)} role="button" tabIndex={busy ? -1 : 0} aria-busy={busy} aria-disabled={busy} onKeyDown={(event) => { if (!busy && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openDocumentPicker(pickerRef.current); } }} onDragEnter={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current += 1; setDragOver(true); }} onDragOver={(event) => { event.preventDefault(); event.stopPropagation(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; }} onDragLeave={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); }} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragOver(false); if (!busy) void upload(acceptedDroppedFiles(event.dataTransfer.files)); }}>
      <Upload /><strong>{busy ? "Processing files…" : "Drop or choose files"}</strong><span>PDF, image, text · batch upload · 50 MB maximum per file</span><span className="upload-cta" aria-hidden="true">Choose files</span>
    </div>
    {records.length > 0 && <div className="ingestion-list">{records.map((record) => {
      const canonical = canonicalFor(record);
      const ocrUi = documentOcrUi(record, ocrHealth.state, busy || ocrProcessingId === record.id);
      return <article className="ingestion-record" key={record.id}>
        <div className="record-top"><FileSearch /><div><strong>{record.currentFileName ?? record.fileName}</strong><span>{record.originalFileName && record.currentFileName && record.originalFileName !== record.currentFileName ? `Original: ${record.originalFileName} · ` : ""}{record.state.replaceAll("_", " ")} · {Math.round(record.classification.confidence * 100)}% classification</span></div><span className={`record-state state-${record.state.toLowerCase()}`}>{record.state === "PARSED" ? "Parsed" : record.state === "FAILED" ? "Failed" : "Review"}</span></div>
        <p className="classification-reason">{record.classification.reason}</p>
        <p className="extraction-summary">{ocrUi.summary}</p>
        {record.packageProgress && record.packageProgress.status !== "NOT_STARTED" && <div className="package-progress" role="status" aria-live="polite"><strong>Package analysis: {record.packageProgress.processed}/{record.packageProgress.total} pages</strong><span>Embedded text: {record.packageProgress.embedded} · OCR: {record.packageProgress.ocr} · Failed: {record.packageProgress.failed} · {label(record.packageProgress.status)}</span><progress aria-label={`Package analysis ${record.packageProgress.processed} of ${record.packageProgress.total} pages`} max={Math.max(1, record.packageProgress.total)} value={record.packageProgress.processed} /></div>}
        <div className="document-meta"><span>{Math.max(1, Math.round(record.size / 1024))} KB</span><span>{record.state.replaceAll("_", " ")}</span><span>{record.validation?.validationStatus?.replaceAll("_", " ") ?? "Not evaluated"}</span></div>
<div className="record-actions"><Select value={record.documentType} onValueChange={(value) => reclassify(record, value as DocumentType)}><SelectTrigger size="sm" aria-label={`Classify ${record.fileName}`}><SelectValue /></SelectTrigger><SelectContent>{DOCUMENT_TYPES.map((type) => <SelectItem value={type} key={type}>{label(type)}</SelectItem>)}</SelectContent></Select><Button variant="outline" size="sm" onClick={() => window.open(repository.openUrl(record.id), "_blank", "noopener,noreferrer")}>Open</Button>{suggestDocumentFilename(record, insuredName) && <Button variant="outline" size="sm" onClick={() => renameSaved(record)}>Rename</Button>}{ocrUi.showOcr && <Button variant="outline" size="sm" disabled={!ocrUi.canOcr} onClick={() => void runCloudOcr(record).catch(error => persistPackageFailure(record, error))}><RefreshCw />{ocrUi.ocrLabel}</Button>}<Button variant="outline" size="sm" disabled={!ocrUi.canReparse} onClick={() => void reprocess(record).catch(error => persistPackageFailure(record, error))}><RefreshCw />{ocrUi.reparseLabel}</Button>{ocrUi.showRegenerate && <Button variant="outline" size="sm" disabled={!ocrUi.canRegenerate} onClick={() => void runCloudOcr(record, true).catch(error => persistPackageFailure(record, error))}>{ocrUi.regenerateLabel}</Button>}<Button variant="outline" size="sm" onClick={() => replaceSaved(record)}>Replace</Button>{record.parsed && <Button variant="outline" size="sm" onClick={() => correctExtraction(record)}>Correct</Button>}<Button variant="outline" size="sm" className="delete-document" onClick={() => deleteSaved(record)}>Delete</Button></div>
        {(record.mimeType === "application/pdf" || record.logicalDocuments?.length) && <details className="section-manager"><summary>Manage sections</summary><Button variant="outline" size="sm" onClick={() => addSection(record)}>Add section</Button><div>{(record.logicalDocuments ?? []).map((section) => <article key={section.id}><div><strong>{label(section.documentType)}{section.subjectName ? ` — ${section.subjectName}` : ""}{section.documentSubtype ? ` — ${label(section.documentSubtype)}` : ""}</strong><span>{section.startPage === section.endPage ? `Page ${section.startPage ?? "—"}` : `Pages ${section.startPage ?? "—"}–${section.endPage ?? "—"}`} · Found · {label(section.validationStatus)}</span></div><Button variant="outline" size="sm" onClick={() => editSection(record, section)}>Edit</Button><Button variant="outline" size="sm" onClick={() => saveSections(record, (record.logicalDocuments ?? []).filter((item) => item.id !== section.id))}>Delete section</Button></article>)}</div></details>}
        {record.suggestedSections?.some((item) => item.suggestionStatus === "PENDING") && <details className="section-manager suggested-sections" open><summary>Suggested sections</summary><Button variant="outline" size="sm" onClick={() => void acceptAllSuggestions(record).catch((error) => persistPackageFailure(record, error))}>Accept all</Button><div>{record.suggestedSections.filter((item) => item.suggestionStatus === "PENDING").map((section) => <article key={section.id}><div><strong>{label(section.documentType)}</strong><span>{section.startPage === section.endPage ? `Page ${section.startPage}` : `Pages ${section.startPage}–${section.endPage}`} · {Math.round((section.classificationConfidence ?? 0) * 100)}% confidence</span><span>{section.evidenceSignals.join(" · ")}</span></div><Button variant="outline" size="sm" onClick={() => void reviewSuggestion(record, section.id, "ACCEPTED").catch((error) => persistPackageFailure(record, error))}>Accept</Button><Button variant="outline" size="sm" onClick={() => void editSuggestion(record, section).catch((error) => persistPackageFailure(record, error))}>Edit</Button><Button variant="outline" size="sm" onClick={() => void reviewSuggestion(record, section.id, "IGNORED").catch((error) => persistPackageFailure(record, error))}>Ignore</Button></article>)}</div></details>}
        {Boolean(record.raw?.metadata?.provider) && <p className="classification-reason">Provider: {label(String(record.raw?.metadata?.provider))}</p>}
        {(record.raw || record.packagePages?.length) && <details className="ocr-text-view"><summary>View OCR Text</summary><p>Normalized OCR text · read-only</p><pre>{recordText(record) || "No OCR text was returned."}</pre></details>}
        {record.raw?.metadata && <details className="ocr-diagnostics"><summary>OCR diagnostics</summary><pre>{JSON.stringify({ requestSucceeded: record.raw.metadata.requestSucceeded ?? false, provider: record.raw.metadata.provider, providerAttempts: record.raw.metadata.providerAttempts, providerErrorCodes: record.raw.metadata.providerErrorCodes, charactersExtracted: ocrUi.chars, pageCount: record.raw.metadata.pageCount ?? record.raw.pages?.length ?? record.packagePages?.length ?? 0, classifier: record.raw.metadata.classification ?? record.classification.documentType, parserInvoked: record.raw.metadata.parserInvoked ?? record.raw.metadata.parser ?? "none", parserCandidateFields: record.raw.metadata.parserCandidateFields ?? [], vinCandidateCount: record.raw.metadata.vinCandidateCount ?? 0, finalParsedFieldCount: ocrUi.fieldCount, sanitizedPreview: record.raw.metadata.sanitizedPreview ?? "" }, null, 2)}</pre></details>}
        {record.raw?.metadata?.reviewReason === "OCR SERVER OFFLINE" && <p className="record-error"><XCircle /> OCR provider was unavailable during extraction · document kept for review. Check provider status; use {ocrUi.ocrLabel} for missing content or {ocrUi.reparseLabel} for saved text.</p>}
        {record.error && <p className="record-error"><XCircle /> {record.error}</p>}
        {record.parsed?.warnings.map((warning, index) => <p className="record-warning" key={`${warning.code}-${index}`}>{warning.code === "EXTRACTION_PROVIDER_REQUIRED" ? (ocrHealth.state === "ONLINE" ? "Image/scanned PDF — run OCR or enter manually." : "OCR provider not configured — manual entry available.") : warning.message}</p>)}
        {canonical && <div className="canonical-match"><span>{label(canonical.role)} directory match</span><strong>{canonical.name}</strong><p>{canonical.address}</p></div>}
        {record.parsed && Object.keys(record.parsed.data).length > 0 && <details><summary>Parsed source object</summary><pre>{JSON.stringify({ data: record.parsed.data, corrections: record.parsed.corrections }, null, 2)}</pre></details>}
      </article>;
    })}</div>}
  </div>;
}

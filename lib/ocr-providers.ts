import { BrowserFileStore } from "./document-ingestion.ts";
import type { ExtractedPage, ExtractionInput, ExtractionProvider, RawExtractedDocument } from "./extraction-types.ts";

export const EMBEDDED_TEXT_MIN_CHARACTERS = 40;
export const CRITICAL_FIELD_CONFIDENCE = .9;

export interface PdfTextAdapter {
  extract(file: File): Promise<{ pages: ExtractedPage[]; metadata?: Record<string, unknown> }>;
}

export interface PaddleOcrTransport {
  extract(file: File, options: { languages: string[]; rotations: number[]; preserveLayout: true }): Promise<RawExtractedDocument>;
}
export interface OcrSpaceOptions { pageCount?: number; startPage?: number; endPage?: number; isTable?: boolean; }
export interface OcrSpaceTransport { health(): Promise<OcrServerHealth>; extract(file: File, options?: OcrSpaceOptions): Promise<RawExtractedDocument>; }

export type OcrServerState = "ONLINE" | "OFFLINE" | "DEGRADED" | "NOT_CONFIGURED";
export interface OcrServerHealth { state: OcrServerState; provider?: string; version?: string; modelLoaded?: boolean; device?: string; language?: string; queueDepth?: number; maxConcurrentJobs?: number; maxFileBytes?: number; maxPdfPages?: number; }

export class HttpPaddleOcrTransport implements PaddleOcrTransport {
  constructor(private endpoint = "/api/ocr") {}
  async health(): Promise<OcrServerHealth> {
    try {
      const response = await fetch(`${this.endpoint}/health`, { cache: "no-store" });
      if (!response.ok) return { state: "OFFLINE" };
      return await response.json() as OcrServerHealth;
    } catch { return { state: "OFFLINE" }; }
  }
  async extract(file: File): Promise<RawExtractedDocument> {
    const body = new FormData();
    body.append("file", file, file.name);
    const response = await fetch(this.endpoint, { method: "POST", body });
    const payload = await response.json().catch(() => ({})) as RawExtractedDocument & { state?: OcrServerState; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `OCR server request failed (${response.status}).`);
    return payload;
  }
}

export class HttpOcrSpaceTransport implements OcrSpaceTransport {
  constructor(private endpoint = `${process.env.NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL ?? "http://127.0.0.1:47831"}/ocr-space`) {}
  async health(): Promise<OcrServerHealth> { try { const response = await fetch(`${this.endpoint}/health`, { cache: "no-store" }); return response.ok ? await response.json() as OcrServerHealth : { state: "OFFLINE", provider: "ocr_space" }; } catch { return { state: "OFFLINE", provider: "ocr_space" }; } }
  async extract(file: File, options: OcrSpaceOptions = {}) { const body = new FormData(); body.append("file", file, file.name); for (const [key, value] of Object.entries(options)) if (value !== undefined) body.append(key, String(value)); const response = await fetch(this.endpoint, { method: "POST", body }); const payload = await response.json().catch(() => ({})) as RawExtractedDocument & { error?: string; code?: string }; if (!response.ok) throw Object.assign(new Error(payload.error ?? `Cloud OCR request failed (${response.status}).`), { code: payload.code }); return payload; }
}

export async function optimizeImageForOcr(file: File, targetBytes: number) {
  if (file.size <= targetBytes) return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") throw Object.assign(new Error("Image optimization is unavailable in this browser."), { code: "OCR_IMAGE_OPTIMIZATION_UNAVAILABLE" });
  const bitmap = await createImageBitmap(file); let scale = Math.min(1, Math.sqrt(targetBytes / file.size) * 1.1); let quality = .86; let output: Blob | null = null;
  try { for (let attempt = 0; attempt < 6; attempt += 1) { const canvas = document.createElement("canvas"); canvas.width = Math.max(900, Math.round(bitmap.width * scale)); canvas.height = Math.max(900, Math.round(bitmap.height * scale)); const context = canvas.getContext("2d", { alpha: false }); if (!context) break; context.filter = "grayscale(100%) contrast(108%)"; context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); output = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)); canvas.width = 1; canvas.height = 1; if (output && output.size <= targetBytes) break; scale *= .82; quality = Math.max(.56, quality - .08); } } finally { bitmap.close(); }
  if (!output || output.size > targetBytes) throw Object.assign(new Error("The temporary OCR image could not be reduced below the provider limit without unsafe degradation."), { code: "OCR_IMAGE_TOO_LARGE" });
  return new File([output], `${file.name.replace(/\.[^.]+$/, "")}-ocr.jpg`, { type: "image/jpeg" });
}

export class OcrSpaceProvider implements ExtractionProvider {
  readonly id = "ocr_space"; readonly status = "READY" as const; private requests = new Map<string, OcrSpaceOptions>(); private autoEnabled = false; private running = new Set<string>();
  constructor(private store: BrowserFileStore, private transport: OcrSpaceTransport) {}
  enableOnce(fileId: string, options: OcrSpaceOptions = {}) { this.requests.set(fileId, options); }
  setAutoEnabled(enabled: boolean) { this.autoEnabled = enabled; }
  isRunning(fileId: string) { return this.running.has(fileId); }
  async canHandle(input: ExtractionInput) { return !this.running.has(input.fileId) && (this.autoEnabled || this.requests.has(input.fileId)) && (input.mimeType === "application/pdf" || /^image\/(jpeg|png)$/i.test(input.mimeType) || /\.(pdf|jpe?g|png)$/i.test(input.fileName)); }
  async extract(input: ExtractionInput) { const file = this.store.get(input.fileId); const options = this.requests.get(input.fileId) ?? {}; this.requests.delete(input.fileId); if (!file) throw new Error("Uploaded file is no longer available in this browser session."); if (this.running.has(input.fileId)) throw Object.assign(new Error("OCR is already processing this document."), { code: "OCR_ALREADY_RUNNING" }); this.running.add(input.fileId); const requestedAt = new Date().toISOString(); try { const health = await this.transport.health(); const target = Math.floor((health.maxFileBytes ?? 1024 * 1024) * .9); const derivative = /^image\//i.test(file.type) ? await optimizeImageForOcr(file, target) : file; const raw = await this.transport.extract(derivative, options); return { ...raw, metadata: { ...raw.metadata, provider: this.id, requestedAt, completedAt: new Date().toISOString(), status: "COMPLETE", charactersExtracted: (raw.text ?? "").length, temporaryDerivative: derivative !== file, originalBytes: file.size, ocrInputBytes: derivative.size } }; } finally { this.running.delete(input.fileId); } }
}

export class EmbeddedPdfTextProvider implements ExtractionProvider {
  readonly id = "embedded_pdf_text";
  readonly status;
  constructor(private store: BrowserFileStore, private adapter?: PdfTextAdapter) { this.status = adapter ? "READY" as const : "NOT_CONFIGURED" as const; }
  async canHandle(input: ExtractionInput) { return input.mimeType === "application/pdf" || /\.pdf$/i.test(input.fileName); }
  async extract(input: ExtractionInput): Promise<RawExtractedDocument> {
    const file = this.store.get(input.fileId);
    if (!file) throw new Error("Uploaded file is no longer available in this browser session.");
    if (!this.adapter) return { pages: [], confidence: 0, metadata: { provider: this.id, providerStatus: this.status, insufficientEmbeddedText: true } };
    const result = await this.adapter.extract(file);
    const text = result.pages.map((page) => page.text ?? "").join("\n").trim();
    const sufficient = text.length >= EMBEDDED_TEXT_MIN_CHARACTERS;
    return { text, pages: result.pages, confidence: sufficient ? .99 : .3, metadata: { ...result.metadata, provider: this.id, providerStatus: this.status, insufficientEmbeddedText: !sufficient } };
  }
}

export class PaddleOcrProvider implements ExtractionProvider {
  readonly id = "paddle_ocr";
  readonly status;
  constructor(private store: BrowserFileStore, private transport?: PaddleOcrTransport) { this.status = transport ? "READY" as const : "NOT_CONFIGURED" as const; }
  async canHandle(input: ExtractionInput) { return input.mimeType.startsWith("image/") || input.mimeType === "application/pdf" || /\.(png|jpe?g|webp|tiff?|pdf)$/i.test(input.fileName); }
  async extract(input: ExtractionInput): Promise<RawExtractedDocument> {
    const file = this.store.get(input.fileId);
    if (!file) throw new Error("Uploaded file is no longer available in this browser session.");
    if (!this.transport) return { pages: [], confidence: 0, metadata: { provider: this.id, providerStatus: this.status, reviewReason: "PaddleOCR local transport is not configured." } };
    const raw = await this.transport.extract(file, { languages: ["en", "ch"], rotations: [0, 90, 180, 270], preserveLayout: true });
    const pages = (raw.pages ?? []).map((page, index) => ({ ...page, page: page.page || index + 1, pageNumber: page.pageNumber ?? page.page ?? index + 1 }));
    const unresolvedRotation = pages.some((page) => page.rotation === undefined);
    return { ...raw, pages, text: raw.text ?? pages.map((page) => page.text ?? "").join("\n"), metadata: { ...raw.metadata, provider: this.id, providerStatus: this.status, rotationReviewRequired: unresolvedRotation } };
  }
}

export class OptionalAzureDocumentProvider implements ExtractionProvider {
  readonly id = "azure_document_intelligence";
  readonly status = "NOT_CONFIGURED" as const;
  async canHandle() { return false; }
  async extract(): Promise<RawExtractedDocument> { return { pages: [], confidence: 0, metadata: { provider: this.id, providerStatus: this.status } }; }
}

export class RoutingDocumentExtractor implements ExtractionProvider {
  readonly id = "extraction_router";
  readonly status = "READY" as const;
  constructor(private providers: ExtractionProvider[]) {}
  async canHandle(input: ExtractionInput) { for (const provider of this.providers) if (await provider.canHandle(input)) return true; return false; }
  async extract(input: ExtractionInput): Promise<RawExtractedDocument> {
    const attempts: string[] = [];
    const providerErrors: string[] = [];
    const providerErrorCodes: string[] = [];
    for (const provider of this.providers) {
      if (!(await provider.canHandle(input))) continue;
      attempts.push(provider.id);
      try {
        const raw = await provider.extract(input);
        const textQuality = (raw.text ?? "").trim().length;
        const embeddedInsufficient = provider.id === "embedded_pdf_text" && textQuality < EMBEDDED_TEXT_MIN_CHARACTERS;
        if (!embeddedInsufficient && (raw.confidence ?? 0) > 0) return { ...raw, metadata: { ...raw.metadata, providerAttempts: attempts } };
      } catch (error) {
        providerErrors.push(error instanceof Error ? error.message : "Provider unavailable");
        if (typeof error === "object" && error && "code" in error) providerErrorCodes.push(String(error.code));
        // Provider failures are isolated; the next provider may still succeed.
      }
    }
    return { pages: [], confidence: 0, metadata: { provider: this.id, providerAttempts: attempts, providerErrors, providerErrorCodes, status: "FAILED", reviewReason: providerErrors.some((item) => /offline|unavailable|fetch|network/i.test(item)) ? "OCR SERVER OFFLINE" : "No configured extraction provider produced usable text. Manual review remains available." } };
  }
}

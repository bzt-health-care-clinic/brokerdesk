const DEFAULT_URL = "https://api.ocr.space/parse/image";

export function ocrSpaceConfig(environment = process.env) {
  return { apiKey: environment.OCRSPACE_API_KEY?.trim() || "", apiUrl: environment.OCRSPACE_API_URL?.trim() || DEFAULT_URL, maxFileBytes: Number(environment.OCRSPACE_MAX_FILE_BYTES || 1024 * 1024), maxPdfPages: Number(environment.OCRSPACE_MAX_PDF_PAGES || 3), timeoutMs: Number(environment.OCRSPACE_TIMEOUT_MS || 30000) };
}

export function ocrSpaceHealth(environment = process.env) {
  const config = ocrSpaceConfig(environment); return { state: config.apiKey ? "ONLINE" : "NOT_CONFIGURED", provider: "ocr_space", mode: "Cloud Test Provider", maxFileBytes: config.maxFileBytes, maxPdfPages: config.maxPdfPages };
}

export function validateOcrSpaceInput(file, options = {}, environment = process.env) {
  const config = ocrSpaceConfig(environment); if (!config.apiKey) throw Object.assign(new Error("OCR.Space is not configured."), { status: 503, code: "OCR_NOT_CONFIGURED" });
  if (!/^(application\/pdf|image\/(jpeg|png))$/i.test(file.type) && !/\.(pdf|jpe?g|png)$/i.test(file.name)) throw Object.assign(new Error("Cloud OCR supports PDF, JPG/JPEG, and PNG test files."), { status: 415, code: "OCR_UNSUPPORTED_FILE" });
  if (file.size > config.maxFileBytes) throw Object.assign(new Error("Cloud OCR test limit exceeded. Use manual review or local OCR."), { status: 413, code: "OCR_CLOUD_LIMIT_EXCEEDED" });
  const pageCount = Number(options.pageCount || 0); const start = Number(options.startPage || 0); const end = Number(options.endPage || start);
  if (/pdf/i.test(file.type) && pageCount > config.maxPdfPages) {
    if (start && end && end - start + 1 <= config.maxPdfPages) throw Object.assign(new Error("This logical section is within the cloud limit, but local page rendering is unavailable. Use manual review or local OCR."), { status: 422, code: "OCR_SECTION_EXTRACTION_UNAVAILABLE" });
    throw Object.assign(new Error("Cloud OCR test limit exceeded. Use manual review or local OCR."), { status: 413, code: "OCR_CLOUD_LIMIT_EXCEEDED" });
  }
  return config;
}

export function normalizeOcrSpaceResponse(payload) {
  if (payload?.IsErroredOnProcessing) throw Object.assign(new Error((payload.ErrorMessage || payload.ErrorDetails || ["OCR provider processing error"]).flat().join(" ")), { status: 502, code: "OCR_PROVIDER_ERROR" });
  const results = Array.isArray(payload?.ParsedResults) ? payload.ParsedResults : []; const pages = results.map((result, index) => {
    const overlay = result.TextOverlay?.Lines ?? []; const blocks = overlay.flatMap((line) => (line.Words ?? []).map((word) => ({ text: String(word.WordText ?? ""), boundingBox: { x: Number(word.Left ?? 0), y: Number(word.Top ?? 0), width: Number(word.Width ?? 0), height: Number(word.Height ?? 0) } })));
    return { page: index + 1, pageNumber: index + 1, text: String(result.ParsedText ?? ""), rotation: typeof result.TextOrientation === "number" && [0, 90, 180, 270].includes(result.TextOrientation) ? result.TextOrientation : undefined, blocks };
  }); const text = pages.map((page) => page.text).join("\n").trim();
  if (!text) throw Object.assign(new Error("Cloud OCR returned no readable text. Manual review remains available."), { status: 422, code: "OCR_EMPTY_RESULT" });
  const normalizedText = text.normalize("NFKC").replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/[\t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { text, rawText: text, normalizedText, pages, metadata: { provider: "ocr_space", providerStatus: "ONLINE", requestSucceeded: true, processingStatus: payload.OCRExitCode, processingTimeMs: payload.ProcessingTimeInMilliseconds, charactersExtracted: text.length, pageCount: pages.length }, confidence: .8 };
}

export async function requestOcrSpace(file, options = {}, environment = process.env, fetcher = fetch) {
  const config = validateOcrSpaceInput(file, options, environment); const form = new FormData(); form.append("apikey", config.apiKey); form.append("file", file, file.name); form.append("OCREngine", "2"); form.append("language", "auto"); form.append("isOverlayRequired", "true"); form.append("detectOrientation", "true"); form.append("scale", "true"); if (options.isTable) form.append("isTable", "true");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try { const response = await fetcher(config.apiUrl, { method: "POST", body: form, signal: controller.signal }); if (!response.ok) throw Object.assign(new Error(response.status === 401 || response.status === 403 ? "Cloud OCR authentication failed." : `Cloud OCR request failed (${response.status}).`), { status: 502, code: response.status === 401 || response.status === 403 ? "OCR_AUTH_FAILED" : "OCR_HTTP_ERROR" }); const payload = await response.json().catch(() => { throw Object.assign(new Error("Cloud OCR returned invalid JSON."), { status: 502, code: "OCR_INVALID_JSON" }); }); return normalizeOcrSpaceResponse(payload); } catch (error) { if (error?.name === "AbortError") throw Object.assign(new Error("Cloud OCR request timed out. Manual review remains available."), { status: 504, code: "OCR_TIMEOUT" }); throw error; } finally { clearTimeout(timer); }
}

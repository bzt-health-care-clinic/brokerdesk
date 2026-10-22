import http from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { openDatabase, migrateSourceHashBaselines, migrateLogicalDocuments } from "./database.mjs";
import { resolveDataPaths } from "./paths.mjs";
import { LocalRepositories } from "./repositories.mjs";
import { SubmissionPilotService } from "./submission-service.mjs";
import { ocrSpaceHealth, requestOcrSpace } from "./ocr-space.mjs";
import { loadLocalEnvironment } from "./env-loader.mjs";
import { localAllowedOrigins } from "./origins.mjs";
import { BrokerReviewService } from "./broker-review-integration.mjs"; // STEP2_BROKER_REVIEW_IMPORT

loadLocalEnvironment();

const paths = resolveDataPaths();
const db = openDatabase(paths.database);
// One-time backfill of sourceHash integrity baselines for legacy document rows.
// Idempotent: only rows missing $.sourceHash are touched; afterwards it is a no-op.
migrateSourceHashBaselines(db, paths.base);
// One-time backfill of logical_documents rows for legacy documents. Idempotent:
// only documents with no logical_documents rows are touched; afterwards this is
// a no-op and listDocuments stays a pure read.
migrateLogicalDocuments(db);
const repositories = new LocalRepositories(db, paths);
const pilot = new SubmissionPilotService(db, paths, repositories);
const brokerReview = new BrokerReviewService(db, repositories); // STEP2_BROKER_REVIEW_SERVICE
const brokerOnly = process.env.BROKERDESK_MODE === "broker";
repositories.cleanTemp();
const host = "127.0.0.1";
const port = Number(process.env.BROKERDESK_LOCAL_API_PORT || 47831);
const allowedOrigins = localAllowedOrigins();

function headers(request, extra = {}) {
  const origin = request.headers.origin;
  return { "Cache-Control": "no-store", ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}), ...extra };
}
function sendJson(response, request, status, value) { const body = JSON.stringify(value); response.writeHead(status, headers(request, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body) })); response.end(body); }
async function readBody(request, limit = 50 * 1024 * 1024) { const chunks = []; let size = 0; for await (const chunk of request) { size += chunk.length; if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(chunk); } return Buffer.concat(chunks); }
async function readJson(request) { const body = await readBody(request, 10 * 1024 * 1024); return JSON.parse(body.toString("utf8") || "{}"); }
async function readForm(request) { const body = await readBody(request); const webRequest = new Request("http://local/form", { method: "POST", headers: { "content-type": request.headers["content-type"] || "" }, body }); return webRequest.formData(); }

export const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return sendJson(response, request, 403, { error: "Origin not allowed" });
  if (request.method === "OPTIONS") { response.writeHead(204, headers(request, { "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" })); return response.end(); }
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/health") return sendJson(response, request, 200, { status: "ok", mode: "local-single-user" });
    if (request.method === "GET" && url.pathname === "/bootstrap") {
      const cases = repositories.listCases("", false);
      const preferred = url.searchParams.get("caseId");
      const selectedId = cases.some((item) => item.id === preferred) ? preferred : cases[0]?.id;
      const selected = selectedId ? repositories.getCase(selectedId) : null;
      const documents = selectedId ? repositories.listDocuments(selectedId) : [];
      const notes = selectedId ? repositories.getNotes(selectedId) : {};
      return sendJson(response, request, 200, { cases, selected, documents, notes });
    }
    if (request.method === "GET" && url.pathname === "/ocr-space/health") return sendJson(response, request, 200, ocrSpaceHealth());
    if (request.method === "POST" && url.pathname === "/ocr-space") { const form = await readForm(request); const file = form.get("file"); if (!(file instanceof File)) throw Object.assign(new Error("File is required"), { status: 400, code: "OCR_INVALID_INPUT" }); try { const raw = await requestOcrSpace(file, { pageCount: form.get("pageCount"), startPage: form.get("startPage"), endPage: form.get("endPage"), isTable: form.get("isTable") === "true" }); return sendJson(response, request, 200, raw); } catch (error) { return sendJson(response, request, error.status || 502, { error: error.message, code: error.code || "OCR_PROVIDER_ERROR" }); } }
    // Pilot v0.3: still LOOPBACK only. LAN exposure requires HTTPS and
    // authenticated Auditor sessions in a later rollout.
    // STEP2_BROKER_REVIEW_ROUTE: local Broker draft; not a BDZIP approval.
    const reviewRoute = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/broker-review(?:\/(rebuild|fields|sections|remarks-preview))?$/);
    if (reviewRoute) {
      if (!brokerOnly) return sendJson(response, request, 403, { error: "Broker Review is only available in Broker mode." });
      const result = brokerReview.handle(reviewRoute[1], reviewRoute[2] || "",
        request.method, ["GET","HEAD"].includes(request.method) ? null : await readJson(request));
      return sendJson(response, request, result.status, result.body);
    }
    const preflight = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/preflight$/);
    if (preflight && request.method === "GET")
      return sendJson(response, request, 200, pilot.preflight(preflight[1]));
    const bundle = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/bdzip$/);
    if (bundle && request.method === "POST") {
      const { filename, archive } = pilot.exportCase(bundle[1], (await readJson(request)).broker);
      response.writeHead(200, headers(request, {
        "Content-Type": "application/zip", "Content-Length": archive.length,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Access-Control-Expose-Headers": "Content-Disposition",
      }));
      return response.end(archive);
    }
    const insuredCompare = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/insured-name-comparison$/);
    if (insuredCompare && request.method === "POST") return sendJson(response,request,200,
      repositories.saveNamedInsuredComparison(insuredCompare[1],await readJson(request)));
    const opcf43Target = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/opcf43-vehicle-target$/);
    if (opcf43Target && request.method === "POST") return sendJson(response,request,200,
      repositories.saveIntakeOpcf43Target(opcf43Target[1],await readJson(request)));
    const verifyIntakeProof = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/intake-proof$/);
    if (verifyIntakeProof && request.method === "POST") return sendJson(response,request,200,
      repositories.saveIntakeProof(verifyIntakeProof[1],await readJson(request)));
    const reviewDiscounts = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/discount-review$/);
    if (reviewDiscounts && request.method === "POST") return sendJson(response,request,200,
      repositories.saveIntakeDiscountReview(reviewDiscounts[1],await readJson(request)));
    const reviewWarningFacts = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/warning-facts$/);
    if (reviewWarningFacts && request.method === "POST") return sendJson(response,request,200,
      repositories.saveIntakeWarningFacts(reviewWarningFacts[1],await readJson(request)));
    const authorizeChange = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/change-authorization$/);
    if (authorizeChange && request.method === "POST")
      return sendJson(response, request, 200, repositories.saveTransactionAuthorization(authorizeChange[1], await readJson(request)));
    if (request.method === "POST" && url.pathname === "/submissions/import") {
      if (brokerOnly) return sendJson(response, request, 403, { error: "Only an Auditor workstation can import submissions." });
      const archive = await readBody(request, 50 * 1024 * 1024);
      const filename = url.searchParams.get("filename") || "submission.bdzip";
      return sendJson(response, request, 201, pilot.importArchive(archive, filename));
    }
    if (request.method === "GET" && url.pathname === "/inbox") {
      if (brokerOnly) return sendJson(response, request, 403, { error: "Inbox is not available in Broker mode." });
      return sendJson(response, request, 200, pilot.listInbox(url.searchParams.get("system")));
    }
    const inboxAction = url.pathname.match(/^\/inbox\/([A-Za-z0-9_-]+)\/(claim|release|renew|complete)$/);
    if (inboxAction && request.method === "POST") {
      if (brokerOnly) return sendJson(response, request, 403, { error: "Inbox actions require Auditor mode." });
      return sendJson(response, request, 200, pilot.updateTask(inboxAction[1], "AUDITOR-1", inboxAction[2]));
    }
    if (request.method === "GET" && url.pathname === "/cases") return sendJson(response, request, 200, repositories.listCases(url.searchParams.get("search") || "", url.searchParams.get("archived") === "true"));
    if (request.method === "POST" && url.pathname === "/cases") return sendJson(response, request, 201, repositories.upsertCase(await readJson(request), "CREATE_CASE"));
    const caseMatch = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)$/);
    if (caseMatch && request.method === "GET") { const item = repositories.getCase(caseMatch[1]); return item ? sendJson(response, request, 200, item) : sendJson(response, request, 404, { error: "Case not found" }); }
    if (caseMatch && request.method === "PUT") { const body = await readJson(request); if (body?.case?.case_id !== caseMatch[1]) return sendJson(response, request, 400, { error: "Case id in URL does not match case id in request body" }); return sendJson(response, request, 200, repositories.upsertCase(body)); }
    if (caseMatch && request.method === "PATCH") { const body = await readJson(request); if (body.action === "archive") { repositories.archiveCase(caseMatch[1]); return sendJson(response, request, 200, { ok: true }); } if (body.action === "rename") return sendJson(response, request, 200, repositories.renameCase(caseMatch[1], body.label)); }
    if (caseMatch && request.method === "DELETE") { repositories.deleteCase(caseMatch[1]); return sendJson(response, request, 200, { ok: true }); }
    const signedMatch = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/signed-verification$/);
    if (signedMatch && request.method === "POST") {
      const body = await readJson(request);
      return sendJson(response, request, 200, repositories.saveSignedCase(signedMatch[1], body.case, body.action, body.details));
    }
    const caseDocuments = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/documents$/);
    if (caseDocuments && request.method === "GET") return sendJson(response, request, 200, repositories.listDocuments(caseDocuments[1]));
    if (caseDocuments && request.method === "POST") { const form = await readForm(request); const file = form.get("file"); const record = JSON.parse(String(form.get("record") || "{}")); if (!(file instanceof File)) throw Object.assign(new Error("File is required"), { status: 400 }); const saved = repositories.saveDocument(caseDocuments[1], record, Buffer.from(await file.arrayBuffer()), file.name); return sendJson(response, request, 201, saved); }
    const caseNotes = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/notes$/);
    if (caseNotes && request.method === "GET") return sendJson(response, request, 200, repositories.getNotes(caseNotes[1]));
    if (caseNotes && request.method === "PUT") { const body = await readJson(request); repositories.saveNote(caseNotes[1], body.type, body.text); return sendJson(response, request, 200, { ok: true }); }
    const caseActions = url.pathname.match(/^\/cases\/([A-Za-z0-9_-]+)\/actions$/);
    if (caseActions && request.method === "POST") { const body = await readJson(request); repositories.recordAction(body.action, caseActions[1], body.documentId, body.details); return sendJson(response, request, 201, { ok: true }); }
    const documentMatch = url.pathname.match(/^\/documents\/([A-Za-z0-9_-]+)$/);
    if (documentMatch && request.method === "PUT") { const body = await readJson(request); const result = repositories.updateDocument(documentMatch[1], body.record); return result ? sendJson(response, request, 200, result) : sendJson(response, request, 404, { error: "Document not found" }); }
    if (documentMatch && request.method === "DELETE") { repositories.deleteDocument(documentMatch[1]); return sendJson(response, request, 200, { ok: true }); }
    const documentRename = url.pathname.match(/^\/documents\/([A-Za-z0-9_-]+)\/rename$/);
    if (documentRename && request.method === "POST") { const body = await readJson(request); const result = repositories.renameDocument(documentRename[1], body.filename); return result ? sendJson(response, request, 200, result) : sendJson(response, request, 404, { error: "Document not found" }); }
    const documentFile = url.pathname.match(/^\/documents\/([A-Za-z0-9_-]+)\/file$/);
    if (documentFile && request.method === "GET") { const item = repositories.documentPath(documentFile[1]); if (!item) return sendJson(response, request, 404, { error: "Document not found" }); const bytes = readFileSync(item.path); response.writeHead(200, headers(request, { "Content-Type": item.row.mime_type, "Content-Length": bytes.length, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(item.row.stored_filename)}` })); return response.end(bytes); }
    const documentReplace = url.pathname.match(/^\/documents\/([A-Za-z0-9_-]+)\/replace$/);
    if (documentReplace && request.method === "POST") { const old = repositories.getDocument(documentReplace[1]); if (!old) return sendJson(response, request, 404, { error: "Document not found" }); const form = await readForm(request); const file = form.get("file"); const record = JSON.parse(String(form.get("record") || "{}")); if (!(file instanceof File)) throw Object.assign(new Error("File is required"), { status: 400 }); repositories.saveDocument(old.case_id, record, Buffer.from(await file.arrayBuffer()), file.name, "REPLACE_DOCUMENT", old.id); return sendJson(response, request, 201, record); }
    if (request.method === "GET" && url.pathname === "/settings/storage") return sendJson(response, request, 200, repositories.stats());
    if (request.method === "POST" && url.pathname === "/settings/backup") return sendJson(response, request, 201, repositories.exportBackup());
    if (request.method === "POST" && url.pathname === "/settings/clean-temp") return sendJson(response, request, 200, repositories.cleanTemp());
    if (request.method === "POST" && url.pathname === "/settings/open-folder") { if (process.platform !== "win32") return sendJson(response, request, 409, { error: "Open Data Folder is available on Windows only." }); spawn("explorer.exe", [paths.base], { detached: true, windowsHide: true, stdio: "ignore" }).unref(); return sendJson(response, request, 200, { ok: true }); }
    return sendJson(response, request, 404, { error: "Not found" });
  } catch (error) { return sendJson(response, request, error.status || 500, { error: error instanceof Error ? error.message : "Local storage error", ...(Array.isArray(error.blockers) ? { blockers: error.blockers } : {}) }); }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`BrokerDesk cannot start because local port ${port} is already in use. Close the older BrokerDesk local server, or set BROKERDESK_LOCAL_API_PORT and NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL to matching values.`);
    process.exitCode = 1;
    db.close();
    return;
  }
  throw error;
});
server.listen(port, host, () => console.log(`BrokerDesk local storage ready on http://${host}:${port} · ${paths.base}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { server.close(); db.close(); process.exit(0); });

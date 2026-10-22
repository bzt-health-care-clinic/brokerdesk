import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { authoritativeIntake } from "./intake-bridge.mjs";
import { createBdzip, readBdzip } from "./bdzip.mjs";
import { BrokerReviewService } from "./broker-review-integration.mjs"; // STEP3_V04_IMPORT
import {
  REVIEWED_V04, prepareReviewedExport, validateArchiveReviewedSnapshot,
  freezeReviewedExportInTransaction, ensureAuditorReviewedSchema, prepareAuditorReviewedRecord,
  saveAuditorReviewedRecord, loadAuditorReviewedRecord
} from "./reviewed-keyin-stage3.mjs";
import { inside, safeId } from "./paths.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const bad = (message, status = 400, blockers) => Object.assign(new Error(message), {
  status, ...(blockers ? { blockers } : {}),
});
const safePart = value => String(value ?? "").trim().replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 55);
const isChange = item => ["auto_policy_change", "home_policy_change"].includes(item?.case_type);
const freshId = prefix => prefix + randomUUID().replaceAll("-", "");
// Must stay byte-for-byte equivalent to lib/active-evidence.ts sectionRevision.
// Remapped import section IDs change the identity hash: only rewrite matching,
// previously active source revisions, never revive stale extraction references.
const sourceSectionRevision = section => JSON.stringify([
  section.physicalFileId, section.id, section.documentType, section.startPage ?? 1,
  section.endPage ?? section.startPage ?? 1, section.subjectType ?? "",
  section.subjectId ?? "", section.subjectName ?? ""
]);
const normalizeTypes = item => {
  const types = item.policy_change?.transaction_types ?? [];
  const first = types.length ? types[0] : undefined;
  if (first) return [...new Set(types)];
  const text = String(item.policy_change?.requested_action ?? "").toLowerCase();
  if (/substitut|replac/.test(text)) return ["VEHICLE_SUBSTITUTION"];
  if (/add.*vehicle/.test(text)) return ["ADD_VEHICLE"];
  if (/cancell?/.test(text)) return ["CANCELLATION"];
  if (/name/.test(text)) return ["NAME_CHANGE"];
  return ["OTHER_POLICY_CHANGE"];
};
const json = value => Buffer.from(JSON.stringify(value, null, 2), "utf8");
const maxPreview = source => source.length > 120 ? source.slice(0, 117) + "..." : source;
/** Filename is advisory, never the authority for queue routing. */
function filenameRoutingWarning(manifest,item,filename) {
  const matched=basename(String(filename||"")).toLowerCase().match(/-([a-z0-9_]+)\.bdzip$/);
  if(!matched)return null;
  const indicated=matched[1];
  const permitted=new Set(["auto","home","cancellation","add_vehicle","delete_vehicle",
    "vehicle_substitution","add_driver","delete_driver","driver_reassignment","name_change",
    "address_change","vehicle_use_change","annual_km_change","commute_change",
    "coverage_change","deductible_change","lessor_change","lienholder_change",
    "payment_change","endorsement_change","opcf16_add","opcf16_remove","opcf16_reinstate",
    "opcf17_add","opcf17_remove","opcf17_reinstate","other_policy_change"]);
  if(!permitted.has(indicated))return null;
  const expected=manifest.system==="new-business"?
    item.case_type==="new_auto"?"auto":"home":
    String(manifest.primary_transaction_type||"").toLowerCase();
  if(!expected||indicated===expected)return null;
  return {code:"INTAKE_FILENAME_ROUTE_MISMATCH",
    message:"Attachment filename suggests "+indicated+" but verified Manifest/Case type is "+
      expected+"; routed by Manifest. Confirm Broker's intended transaction.",
    field:"filename"};
}

/**
 * This is a loopback pilot. Broker identities are self-reported and must be
 * allow-listed at import; that is not a cryptographic identity signature.
 * Never expose this class through a raw unauthenticated LAN HTTP listener.
 */
export class SubmissionPilotService {
  constructor(db, paths, repositories, options = {}) {
    this.db = db; this.paths = paths; this.repo = repositories;
    this.allowlist = new Set((options.allowedBrokerIds ?? process.env.BROKERDESK_PILOT_BROKER_IDS ??
      "PILOT-BROKER-1,PILOT-BROKER-2").split(",").map(value => value.trim()).filter(Boolean));
    this.pilotAuditor = options.pilotAuditor ?? "AUDITOR-1";
    this.reviewedV04 = options.reviewedV04 === true ||
      (options.reviewedV04 ?? process.env.BROKERDESK_REVIEWED_KEYIN_V04) === "1";
    this.brokerReview = new BrokerReviewService(db, repositories);
    ensureAuditorReviewedSchema(db);
  }
  preflight(caseId) {
    const item = this.repo.getCase(safeId(caseId));
    if (!item) throw bad("Case not found.", 404);
    const intake = authoritativeIntake(item, this.repo.listDocuments(item.case_id));
    if (!this.reviewedV04 || !intake.passed) return intake;
    const reviewStatus = this.brokerReview.read(item.case_id);
    if (reviewStatus.review && reviewStatus.ready &&
        reviewStatus.sourceIssues.length===0 && reviewStatus.fieldIssues.length===0)
      return intake;
    const reasons = [...reviewStatus.sourceIssues,
      ...reviewStatus.fieldIssues.map(x=>x.message),
      ...(reviewStatus.review?.sections??[])
        .filter(section=>section.status!=="CONFIRMED")
        .map(section=>section.id+": Broker has not confirmed this page."),
      ...(reviewStatus.review?[]:["Broker Review has not been created."])];
    if(!reasons.length)
      reasons.push("Broker Review confirmation is stale or incomplete; reopen the Review pages.");
    return {...intake,passed:false,blockers:[...intake.blockers,
      ...reasons.slice(0,30).map(message=>({code:"BROKER_KEYIN_REVIEW",message}))]};
  
  }
  exportCase(caseId, broker = {}) {
    const item = this.repo.getCase(safeId(caseId));
    if (!item) throw bad("Case not found.", 404);
    const brokerId = String(broker.id ?? "").trim(), brokerName = String(broker.name ?? "").trim();
    if (!/^[A-Za-z0-9_-]{3,60}$/.test(brokerId) || !brokerName || brokerName.length > 120)
      throw bad("Broker ID and name are required for the submission.");
    const clientCode = safePart(item.policy?.client_code);
    const company = safePart(item.policy?.company);
    if (!clientCode || !company) throw bad("Client code and insurance company are required before packaging.");
    if (!/^(new_auto|new_home|auto_policy_change|home_policy_change)$/.test(item.case_type))
      throw bad("Case type is not supported by the pilot.");
    const originals = this.repo.listDocuments(item.case_id);
    const files = [], sourceRecords = [];
    for (const record of originals) {
      const stored = this.repo.documentPath(record.id);
      if (!stored || stored.row.case_id !== item.case_id) throw bad("An uploaded source file is missing or belongs to a different Case.", 409);
      const bytes = readFileSync(stored.path), checksum = hash(bytes);
      if (!record.sourceHash || record.sourceHash !== checksum || record.staleExtraction)
        throw bad("Source file integrity changed: " + safeId(record.id), 409);
      const entryName = safePart(record.id) + "_" + safePart(basename(record.originalFileName || record.fileName).replace(/\./g, "_"));
      // Retain the original filename's extension separately, but never permit
      // Windows separators or path traversal inside a ZIP entry.
      const ext = String(basename(record.originalFileName || record.fileName).match(/\.[A-Za-z0-9]{1,7}$/)?.[0] ?? ".bin");
      const path = `documents/${entryName.slice(0, 150)}${ext}`;
      files.push({ path, bytes, document_id: record.id });
      sourceRecords.push({ ...record, package_file_path: path });
    }
    const preflight = authoritativeIntake(item, originals);
    if (!preflight.passed) throw bad("Intake has unresolved hard blockers; package was not generated.", 422, preflight.blockers);
    const submittedAt = now();
    let reviewedExport = null;
    if (this.reviewedV04) {
      const reviewStatus = this.brokerReview.read(item.case_id);
      if (!reviewStatus.review || !reviewStatus.ready ||
          reviewStatus.sourceIssues.length || reviewStatus.fieldIssues.length)
        throw bad("Broker must confirm every Key-in Review section before export.",422,
          [...reviewStatus.sourceIssues,...reviewStatus.fieldIssues.map(x=>x.message),
            ...(reviewStatus.review ? [] : ["Broker Review is missing."])].map(message=>({
              code:"REVIEWED_KEYIN",message
            })));
      reviewedExport = prepareReviewedExport(reviewStatus.review,
        item, sourceRecords, brokerId, submittedAt);
    }
    const system = isChange(item) ? "policy-change" : "new-business";
    const transactions = system === "policy-change" ? normalizeTypes(item) : [];
    const businessType = system === "policy-change" ? transactions[0].toLowerCase() :
      item.case_type === "new_auto" ? "auto" : "home";
    const date = now().slice(0, 10).replaceAll("-", "");
    const filename = `${clientCode}-${date}-${company}-${businessType}.bdzip`;
    const revision = this.db.prepare("SELECT COALESCE(MAX(revision),0)+1 AS next FROM outbound_submissions WHERE case_id=?").get(item.case_id).next;
    const packageId = randomUUID(), payloads = [
      { path: "case.json", bytes: json(item) },
      { path: "document-records.json", bytes: json(sourceRecords) },
      ...files,
      ...(reviewedExport ? [reviewedExport.entry] : []),
    ];
    const manifest = {
      package_version: reviewedExport ? REVIEWED_V04 : "0.3-pilot",
      package_id: packageId, source_case_id: item.case_id, revision,
      client_code: clientCode, company: item.policy.company, filename,
      broker: { id: brokerId, name: brokerName },
      submitted_at: submittedAt, app_version: "0.1.0", rule_engine_version: preflight.rule_engine_version,
      intake_profile_version: preflight.profile_version, system,
      primary_transaction_type: transactions[0] ?? null,
      transaction_types: transactions,
      files: payloads.map(file => ({ path: file.path, sha256: hash(file.bytes), bytes: file.bytes.length,
        ...(file.document_id ? { document_id: file.document_id } : {}) })),
      ...(reviewedExport ? { reviewed_keyin: reviewedExport.manifestReview } : {}),
      preflight: { passed: true, blockers: [], warnings: preflight.warnings },
      signed: { verified: Boolean(item.signed), verified_at: item.signed_verified_at ?? null,
        document_id: item.signed_document_id ?? null, logical_document_id: item.signed_logical_document_id ?? null },
      transaction_authorization: item.transaction_authorization ?? null,
      named_insured_comparison: item.named_insured_comparison ?? null,
      intake_support_evidence: item.intake_support_evidence ?? [],
      intake_opcf43_vehicle_target: item.intake_opcf43_vehicle_target ?? null,
      intake_discount_review: item.intake_discount_review ?? null,
      intake_warning_facts: item.intake_warning_facts ?? null,
    };
    const archive = createBdzip([...payloads, { path: "manifest.json", bytes: json(manifest) }]);
    // Review freeze, outbound record and audit are one atomic SQLite write.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (reviewedExport?.requiresFinalize)
        freezeReviewedExportInTransaction(this.db,reviewedExport,item.case_id,brokerId);
    }
    this.db.prepare("INSERT INTO outbound_submissions(package_id,case_id,revision,sha256,filename,created_at) VALUES(?,?,?,?,?,?)")
      .run(packageId, item.case_id, revision, hash(archive), filename, now());
    this.auditAs("BROKER_PACKAGE_EXPORTED", item.case_id, `BROKER:${brokerId}`,
      { packageId, revision, system, blockers: 0 });
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
    return { filename, archive, manifest };
  }
  auditAs(action, caseId, actor, details = {}) {
    this.db.prepare("INSERT INTO audit_events(case_id,document_id,actor,action,details_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(caseId, null, actor, action, JSON.stringify(details), now());
  }
  validateArchive(bytes) {
    const parts = readBdzip(bytes);
    if (!parts.has("manifest.json") || !parts.has("case.json") || !parts.has("document-records.json"))
      throw bad("Submission is missing manifest.json, case.json or document-records.json.");
    let manifest, item, records;
    try {
      manifest = JSON.parse(parts.get("manifest.json").toString("utf8"));
      item = JSON.parse(parts.get("case.json").toString("utf8"));
      records = JSON.parse(parts.get("document-records.json").toString("utf8"));
    } catch { throw bad("Malformed package JSON."); }
    if (!manifest || !item || !Array.isArray(records) ||
      !["0.3-pilot",REVIEWED_V04].includes(manifest.package_version) || !/^[A-Za-z0-9-]{15,60}$/.test(manifest.package_id ?? "") ||
      typeof manifest.source_case_id !== "string" || item.case_id !== manifest.source_case_id ||
      !["new-business", "policy-change"].includes(manifest.system) ||
      manifest.system !== (isChange(item) ? "policy-change" : "new-business") ||
      manifest.client_code !== safePart(item.policy?.client_code) || manifest.company !== item.policy?.company ||
      !Array.isArray(manifest.files) || manifest.files.length + 1 !== parts.size)
      throw bad("Manifest / Case fields or package contents do not agree.");
    if (typeof manifest.broker?.id !== "string" || !this.allowlist.has(manifest.broker.id))
      throw bad("Broker ID is not on the pilot allowlist; contact the Auditor.", 403);
    if (typeof manifest.broker.name !== "string" || !manifest.broker.name.trim())
      throw bad("Broker name is required.");
    if (manifest.system === "policy-change" && (
        JSON.stringify(manifest.transaction_types) !== JSON.stringify(normalizeTypes(item)) ||
        manifest.primary_transaction_type !== normalizeTypes(item)[0]))
      throw bad("Policy-change type does not match the Case.");
    if (manifest.signed?.verified !== Boolean(item.signed) ||
      (manifest.signed?.document_id ?? null) !== (item.signed_document_id ?? null))
      throw bad("Manifest signed state does not match the Case.");
    if (JSON.stringify(manifest.transaction_authorization ?? null) !== JSON.stringify(item.transaction_authorization ?? null))
      throw bad("Manifest authorization does not match the Case.");
    if(JSON.stringify(manifest.named_insured_comparison??null)!==JSON.stringify(item.named_insured_comparison??null))throw bad("Manifest insured names do not match the Case.");
    for (const field of ["intake_support_evidence","intake_opcf43_vehicle_target","intake_discount_review","intake_warning_facts"]) {
      const fallback = field==="intake_support_evidence" ? [] : null;
      if (JSON.stringify(manifest[field]??fallback)!==JSON.stringify(item[field]??fallback))
        throw bad("Manifest supporting evidence / discount / warning facts do not match the Case.");
    }
    const listed = new Set(); const byDoc = new Map();
    for (const file of manifest.files) {
      const path = String(file?.path ?? "");
      if (!parts.has(path) || path === "manifest.json" || listed.has(path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes !== parts.get(path).length)
        throw bad("Package file list is incomplete or has a wrong byte count: " + maxPreview(path));
      if (typeof file.sha256 !== "string" || hash(parts.get(path)) !== file.sha256)
        throw bad("SHA-256 mismatch for " + maxPreview(path));
      listed.add(path);
      if (path.startsWith("documents/")) {
        if (!file.document_id || byDoc.has(file.document_id)) throw bad("Document ID missing or repeated in manifest.");
        byDoc.set(file.document_id, path);
      }
    }
    if (listed.size !== parts.size - 1 || !listed.has("case.json") || !listed.has("document-records.json") ||
      byDoc.size !== records.length) throw bad("Package includes undeclared or missing files.");
    for (const record of records) {
      if (!record?.id || record.package_file_path !== byDoc.get(record.id) ||
        record.sourceHash !== hash(parts.get(record.package_file_path)))
        throw bad("Source document metadata or hash is inconsistent: " + safePart(record?.id));
      if (record.staleExtraction) throw bad("Stale extraction cannot be imported as current evidence.");
      record.currentSourceHash = record.sourceHash;
    }
    const reviewedSnapshot = validateArchiveReviewedSnapshot(parts,manifest,item,records);
    const profile = authoritativeIntake(item, records);
    if (!profile.passed) throw bad("Auditor-side intake found new or unresolved blockers; package rejected.", 422, profile.blockers);
    return { manifest, item, records, parts, profile, reviewedSnapshot, manifestHash: hash(parts.get("manifest.json")) };
  }
  /**
   * Import is synchronous on the loopback service: all source data and SHA-256
   * checks complete BEFORE any Case is written. Failed partial imports are
   * deleted and cannot appear as accepted inbox items.
   */
  importArchive(archive, originalFilename = "submission.bdzip") {
    const { manifest, item, records, parts, profile, reviewedSnapshot, manifestHash } = this.validateArchive(archive);
    const filenameWarning=filenameRoutingWarning(manifest,item,originalFilename);
    if(filenameWarning)profile.warnings=[...profile.warnings,filenameWarning];
    const existing = this.db.prepare("SELECT * FROM imported_packages WHERE package_id=?").get(manifest.package_id);
    if (existing) {
      if (existing.manifest_sha256 !== manifestHash) throw bad("Package ID was reused with different contents.", 409);
      return { imported: false, duplicate: true, package_id: manifest.package_id,
        case_id: existing.imported_case_id, system: existing.system };
    }
    const caseId = freshId("AUD"), mapping = new Map([[item.case_id, caseId]]);
    for (const record of records) {
      mapping.set(record.id, freshId("DOC"));
      for (const section of record.logicalDocuments ?? []) mapping.set(section.id, freshId("SEC"));
    }
    const reviewedRecord = reviewedSnapshot ? prepareAuditorReviewedRecord(reviewedSnapshot,mapping,caseId) : null;
    const mapReferences = value => {
      if (typeof value === "string") return mapping.get(value) ?? value;
      if (Array.isArray(value)) return value.map(mapReferences);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, mapReferences(v)]));
      return value;
    };
    const importedCase = mapReferences(item);
    importedCase.case_id = caseId;
    importedCase.status = "in_review";
    importedCase.submission_origin = {
      package_id: manifest.package_id, source_case_id: item.case_id, revision: manifest.revision,
      broker_id: manifest.broker.id, broker_name: manifest.broker.name, submitted_at: manifest.submitted_at,
    };
    const mappedRevisions = new Map();
    const storedRecords = records.map(record => {
      const mapped = mapReferences(record);
      delete mapped.package_file_path;
      const originalSections = new Map((record.logicalDocuments ?? []).map(section=>[section.id,section]));
      const newSections = new Map((mapped.logicalDocuments ?? []).map(section=>[section.id,section]));
      const remapParsedSource = (source, before) => {
        if (!before?.logicalDocumentId || !source?.logicalDocumentId) return source;
        const original=originalSections.get(before.logicalDocumentId);
        const translated=newSections.get(source.logicalDocumentId);
        if (!original || !translated) return source;
        const previous=sourceSectionRevision(original);
        if (before.sourceRevision && before.sourceRevision !== previous)
          return source; // Stale prior extraction stays stale, not revalidated.
        if (!before.sourceRevision) return source; // Legacy fallback still observes section timestamps.
        const current=sourceSectionRevision(translated);
        mappedRevisions.set(source.logicalDocumentId,current);
        return {...source,sourceRevision:current};
      };
      mapped.parsedSources=(mapped.parsedSources??[]).map((source,index)=>
        remapParsedSource(source,(record.parsedSources??[])[index]));
      if(mapped.parsed) mapped.parsed=remapParsedSource(mapped.parsed,record.parsed);
      return { mapped, originalPath: record.package_file_path };
    });
    for (const field of importedCase.field_sources ?? []) {
      for (const value of field.values ?? []) {
        if (value.logicalDocumentId && value.sourceRevision &&
            mappedRevisions.has(value.logicalDocumentId))
          value.sourceRevision=mappedRevisions.get(value.logicalDocumentId);
      }
    }
    const packagesDir = resolve(this.paths.base, "packages");
    mkdirSync(packagesDir, { recursive: true });
    const target = resolve(packagesDir, safeId(manifest.package_id) + ".bdzip");
    if (!inside(packagesDir, target)) throw bad("Unsafe package location.");
    const staging = join(this.paths.temp, freshId("TMP") + ".bdzip");
    if (existsSync(target)) throw bad("Package ID already has a stored archive but no completed import. Manual review required.", 409);
    let archiveStored = false;
    try {
      writeFileSync(staging, archive);
      this.repo.upsertCase({ case: importedCase }, "IMPORT_CASE", { trustedSignature: true });
      for (const {mapped, originalPath} of storedRecords) {
        this.repo.saveDocument(caseId, mapped, parts.get(originalPath),
          mapped.originalFileName || mapped.fileName || mapped.id + ".pdf");
      }
      const loaded = this.repo.getCase(caseId);
      if (loaded.signed && !this.repo.signedEvidenceStillValid(loaded)) throw bad("Imported signed application evidence could not be verified.");
      if (loaded.transaction_authorization && !this.repo.transactionAuthorizationStillValid(loaded))
        throw bad("Imported transaction authorization evidence could not be verified.");
      if(loaded.named_insured_comparison&&!this.repo.namedInsuredComparisonStillValid(loaded))throw bad("Imported insured-name comparison evidence could not be verified.");
      if (loaded.intake_opcf43_vehicle_target && !this.repo.intakeOpcf43TargetStillValid(loaded))
        throw bad("Imported OPCF 43 vehicle assignment could not be verified.");
      if ((loaded.intake_support_evidence??[]).some(proof=>!this.repo.intakeProofStillValid(loaded,proof)))
        throw bad("Imported supporting evidence reference failed SHA-256 / page validation.");
      renameSync(staging, target);
      archiveStored = true;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`INSERT INTO imported_packages(package_id,manifest_sha256,source_case_id,imported_case_id,revision,system,broker_id,broker_name,submitted_at,imported_at,manifest_json,original_filename)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(manifest.package_id,manifestHash,item.case_id,caseId,manifest.revision,
          manifest.system,manifest.broker.id,manifest.broker.name,manifest.submitted_at,now(),
          JSON.stringify(manifest),basename(originalFilename).slice(0,180));
        if (reviewedRecord) saveAuditorReviewedRecord(this.db,manifest.package_id,caseId,reviewedRecord);
        this.db.prepare("INSERT INTO inbox_tasks(package_id,status,effective_date,warnings_json,updated_at) VALUES(?,?,?,?,?)")
          .run(manifest.package_id,"pending",String(item.policy_change?.change_effective_date ||
            item.policy_change?.requested_effective_date || item.policy?.effective_date || ""),
            JSON.stringify(profile.warnings),now());
        this.auditAs("PACKAGE_IMPORTED",caseId,`AUDITOR:${this.pilotAuditor}`,
          { package_id: manifest.package_id, broker_id: manifest.broker.id,
            submitted_at: manifest.submitted_at, profile: profile.profile_version, blockers: 0, warnings: profile.warnings });
        this.db.exec("COMMIT");
      } catch(e) {this.db.exec("ROLLBACK");throw e;}
      return { imported:true, duplicate:false, package_id:manifest.package_id,
        case_id:caseId, system:manifest.system, preflight:profile };
    } catch(error) {
      try { this.repo.deleteCase(caseId); } catch {}
      try { rmSync(staging,{force:true}); } catch {}
      if (archiveStored) try { rmSync(target,{force:true}); } catch {}
      throw error;
    }
  }
  readReviewedKeyin(caseId) { return loadAuditorReviewedRecord(this.db,safeId(caseId)); }
  listInbox(system) {
    if (system && !["new-business","policy-change"].includes(system)) throw bad("Unknown inbox channel.");
    return this.db.prepare(`SELECT p.package_id AS package_id,p.source_case_id,p.imported_case_id AS case_id,p.revision,
      p.system,p.broker_id,p.broker_name,p.submitted_at,p.imported_at,c.label,c.insured_name,c.carrier,
      t.status,t.assignee,t.lease_until,t.effective_date,t.warnings_json,t.updated_at
      FROM imported_packages p JOIN inbox_tasks t ON t.package_id=p.package_id
      JOIN cases c ON c.id=p.imported_case_id
      WHERE (? IS NULL OR p.system=?)
      ORDER BY CASE t.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        CASE WHEN t.effective_date<>'' AND date(t.effective_date)<=date('now','+3 days') THEN 0 ELSE 1 END,
        p.submitted_at ASC,p.package_id ASC`).all(system ?? null,system ?? null)
      .map(row=>({...row,warnings:JSON.parse(row.warnings_json||"[]"),warnings_json:undefined}));
  }
  assertAuditor(actor) {
    if (actor !== this.pilotAuditor) throw bad("Only the first local pilot Auditor is enabled.", 403);
    const row = this.db.prepare("SELECT enabled FROM pilot_auditors WHERE id=?").get(actor);
    if (!row?.enabled) throw bad("Auditor is not enabled.",403);
  }
  updateTask(packageId, actor, action) {
    packageId = safeId(packageId); this.assertAuditor(actor);
    if (!["claim","release","renew","complete"].includes(action)) throw bad("Unsupported task action.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM inbox_tasks WHERE package_id=?").get(packageId);
      if (!row) throw bad("Inbox task not found.",404);
      const stamp=now(), expires=new Date(Date.now()+30*60*1000).toISOString();
      const active=row.assignee && row.lease_until && row.lease_until>stamp;
      if (action==="claim") {
        if (row.status==="completed") throw bad("This Case is already completed.",409);
        if (active && row.assignee!==actor) throw bad("Another Auditor has an active claim.",409);
        this.db.prepare("UPDATE inbox_tasks SET status='in_progress',assignee=?,lease_until=?,claim_version=claim_version+1,updated_at=? WHERE package_id=?")
          .run(actor,expires,stamp,packageId);
      } else {
        if (row.status!=="in_progress" || row.assignee!==actor || !active)
          throw bad("The active task lease is not held by this Auditor.",409);
        if (action==="renew") this.db.prepare("UPDATE inbox_tasks SET lease_until=?,updated_at=? WHERE package_id=?")
          .run(expires,stamp,packageId);
        if (action==="release") this.db.prepare("UPDATE inbox_tasks SET status='pending',assignee=NULL,lease_until=NULL,updated_at=? WHERE package_id=?")
          .run(stamp,packageId);
        if (action==="complete") this.db.prepare("UPDATE inbox_tasks SET status='completed',lease_until=NULL,updated_at=? WHERE package_id=?")
          .run(stamp,packageId);
      }
      const imported=this.db.prepare("SELECT imported_case_id FROM imported_packages WHERE package_id=?").get(packageId);
      this.auditAs("INBOX_"+action.toUpperCase(),imported.imported_case_id,`AUDITOR:${actor}`,{package_id:packageId});
      const result=this.db.prepare("SELECT * FROM inbox_tasks WHERE package_id=?").get(packageId);
      this.db.exec("COMMIT");
      return result;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
}

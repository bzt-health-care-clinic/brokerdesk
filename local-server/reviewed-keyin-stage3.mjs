/**
 * Step 3 v0.4: Broker-verified BDZIP bridge and immutable Auditor display.
 * SHA-256 protects accidental modifications, NOT Broker identity authenticity.
 * Imported Case/document IDs are mapped for display only; the original
 * broker-confirmed snapshot and its hash remain immutable.
 */
import { createHash } from "node:crypto";
import { finalizeBrokerReview, sha256json } from "../lib/broker-keyin-review.mjs";
import {
  REVIEWED_KEYIN_PACKAGE_PATH, REVIEWED_KEYIN_PACKAGE_VERSION,
  reviewedKeyinPayload, validateReviewedKeyinPackage,
  remapReviewedKeyinForAuditor, auditorKeyinSheet
} from "./reviewed-keyin-package.mjs";

export const REVIEWED_V04 = REVIEWED_KEYIN_PACKAGE_VERSION;
const checksum = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = (message, status=422, blockers=[message]) =>
  Object.assign(new Error(message), {status, blockers: blockers.map(x=>
    typeof x==="string"?{code:"REVIEWED_KEYIN",message:x}:x)});

export function prepareReviewedExport(review, item, records, brokerId, submittedAt) {
  if (!review) throw fail("Broker Review has not been created.");
  if (typeof brokerId!=="string" || !brokerId.trim())
    throw fail("Broker ID is required.");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(String(submittedAt||"")))
    throw fail("Invalid submission timestamp.");

  let snapshot, requiresFinalize = false;
  if (review.review_status === "DRAFT") {
    const finalized = finalizeBrokerReview(review, {
      brokerId, submittedAt, expectedRevision: review.revision
    });
    // Keep byte-identical to BrokerKeyinReviewStore.finalize(): the persisted
    // final revision, not the unsaved preliminary snapshot, enters the archive.
    snapshot = {...finalized, revision: review.revision + 1};
    snapshot.snapshot_sha256 = sha256json({...snapshot, snapshot_sha256:undefined});
    requiresFinalize = true;
  } else if (review.review_status === "BROKER_CONFIRMED") {
    if (review.finalized_by !== brokerId)
      throw fail("This review was finalized by a different Broker ID.");
    snapshot = review;
  } else {
    throw fail("Unknown Broker Review status.");
  }
  const entry = reviewedKeyinPayload(snapshot, item, records, submittedAt);
  return {
    entry,
    snapshot,
    requiresFinalize,
    draftRevision: review.revision,
    manifestReview: {
      path: REVIEWED_KEYIN_PACKAGE_PATH,
      sha256: checksum(entry.bytes),
      snapshot_sha256: snapshot.snapshot_sha256,
      schema_version: snapshot.schema_version,
      catalog_version: snapshot.catalog_version,
      field_count: snapshot.fields.length,
      finalized_by: snapshot.finalized_by
    }
  };
}

/** The caller MUST own BEGIN IMMEDIATE / COMMIT. Exporting a package and
 * freezing its Broker review is one SQLite transaction, so an outbound insert
 * or audit failure cannot leave an unshipped but permanently finalized draft.
 * No nested transaction: BrokerKeyinReviewStore.finalize() opens its own. */
export function freezeReviewedExportInTransaction(db, prepared, caseId, brokerId) {
  if (!prepared?.requiresFinalize) return false;
  const snapshot=prepared.snapshot;
  if (!snapshot || snapshot.source_case_id!==caseId ||
      snapshot.finalized_by!==brokerId ||
      snapshot.revision!==prepared.draftRevision+1 ||
      sha256json({...snapshot,snapshot_sha256:undefined})!==snapshot.snapshot_sha256)
    throw fail("Final Broker Review does not match the prepared package.",409);
  const previous=db.prepare("SELECT revision,status,review_json FROM keyin_reviews WHERE case_id=?").get(caseId);
  if (!previous || previous.revision!==prepared.draftRevision || previous.status!=="DRAFT")
    throw fail("Broker Review revision/status changed before package freeze.",409);
  const old=JSON.parse(previous.review_json);
  if (old.revision!==previous.revision || old.review_status!=="DRAFT" ||
      old.source_case_id!==caseId)
    throw fail("Persisted Broker Review draft is inconsistent.",409);
  // Verify that the planned final snapshot was derived from THIS persisted
  // revision, rather than trusting a stale in-memory prepared export.
  const current=JSON.parse(JSON.stringify(snapshot));
  delete current.snapshot_sha256;
  delete current.finalized_at;
  delete current.finalized_by;
  current.review_status="DRAFT";
  current.revision=prepared.draftRevision;
  if (sha256json(current)!==sha256json(old))
    throw fail("Broker Review changed since the prepared snapshot.",409);
  const update=db.prepare(`UPDATE keyin_reviews
    SET revision=?,status=?,review_json=?,updated_at=?
    WHERE case_id=? AND revision=? AND status='DRAFT'`).run(
    snapshot.revision,snapshot.review_status,JSON.stringify(snapshot),snapshot.updated_at,
    caseId,prepared.draftRevision);
  if (update.changes!==1)throw fail("Concurrent Broker Review finalization detected.",409);
  db.prepare(`INSERT INTO audit_events(case_id,document_id,actor,action,details_json,created_at)
    VALUES(?,?,?,?,?,?)`).run(caseId,null,brokerId,"BROKER_REVIEW_FINALIZED",
    JSON.stringify({revision:snapshot.revision,snapshotHash:snapshot.snapshot_sha256}),new Date().toISOString());
  return true;
}

/** Validate the OPTIONAL v0.3 legacy path and STRICT v0.4 reviewed path. */
export function validateArchiveReviewedSnapshot(parts, manifest, item, records) {
  const isV04 = manifest.package_version === REVIEWED_V04;
  if (!isV04) {
    if (manifest.package_version !== "0.3-pilot")
      throw fail("Unsupported package version.");
    if (parts.has(REVIEWED_KEYIN_PACKAGE_PATH) || manifest.reviewed_keyin)
      throw fail("A v0.3 package cannot contain a reviewed-keyin snapshot.");
    return null;
  }
  const bytes = parts.get(REVIEWED_KEYIN_PACKAGE_PATH);
  const declared = manifest.reviewed_keyin;
  if (!bytes || !declared || declared.path !== REVIEWED_KEYIN_PACKAGE_PATH)
    throw fail("Reviewed v0.4 package requires reviewed-keyin.json.");
  if (declared.sha256 !== checksum(bytes))
    throw fail("Reviewed snapshot byte hash differs from Manifest.");
  let snapshot;
  try { snapshot = JSON.parse(bytes.toString("utf8")); }
  catch { throw fail("Malformed reviewed-keyin.json."); }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot))
    throw fail("Reviewed snapshot must be an object.");
  if (declared.snapshot_sha256 !== snapshot.snapshot_sha256 ||
      declared.schema_version !== snapshot.schema_version ||
      declared.catalog_version !== snapshot.catalog_version ||
      declared.field_count !== snapshot.fields?.length ||
      declared.finalized_by !== snapshot.finalized_by ||
      snapshot.finalized_by !== manifest.broker?.id)
    throw fail("Manifest Broker/snapshot version or totals do not agree.");
  const issues = validateReviewedKeyinPackage(
    snapshot, item, records, manifest.submitted_at
  );
  if (issues.length) throw fail("Broker Review is not valid for this package.", 422, issues);
  return snapshot;
}

/**
 * Durable imported worksheet. Must be invoked INSIDE the transaction that
 * inserts imported_packages and inbox_tasks, after the imported Case exists.
 */
export function ensureAuditorReviewedSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS imported_reviewed_keyin (
    package_id TEXT PRIMARY KEY REFERENCES imported_packages(package_id) ON DELETE CASCADE,
    imported_case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    source_case_id TEXT NOT NULL,
    broker_id TEXT NOT NULL,
    snapshot_sha256 TEXT NOT NULL,
    original_snapshot_json TEXT NOT NULL,
    auditor_view_json TEXT NOT NULL,
    worksheet_json TEXT NOT NULL,
    worksheet_sha256 TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_imported_reviewed_keyin_case
    ON imported_reviewed_keyin(imported_case_id);`);
}

export function prepareAuditorReviewedRecord(snapshot, mapping, expectedCaseId) {
  if (!(mapping instanceof Map) || mapping.get(snapshot.source_case_id)!==expectedCaseId)
    throw fail("Reviewed Case could not be mapped to imported Case ID.");
  for (const source of snapshot.source_files??[])
    if (!mapping.has(source.id))
      throw fail("Reviewed source document ID could not be mapped.");
  for (const field of snapshot.fields??[]) {
    for (const evidence of field.evidence??[]) {
      if (!mapping.has(evidence.documentId) ||
          (evidence.logicalDocumentId && !mapping.has(evidence.logicalDocumentId)))
        throw fail(`Reviewed evidence ID could not be mapped: ${field.id}`);
    }
  }
  const mapped = remapReviewedKeyinForAuditor(snapshot,mapping);
  const worksheet = auditorKeyinSheet({
    ...mapped.display_view,
    original_snapshot_sha256: mapped.original_snapshot_sha256
  });
  // Display Driver name first, followed by the actual assigned role.
  // Do not invent absent Occasional/Excluded rows or reassign identities.
  const driverNames = new Map(mapped.display_view.fields
    .filter(f=>/^driver:.+\.name$/.test(f.id))
    .map(f=>[f.id.slice("driver:".length,-".name".length),String(f.value??"")]));
  const displayRole = {
    PRINCIPAL:"Principal",SECONDARY:"Secondary",OCCASIONAL:"Occasional",
    NOT_INCLUDED_IN_RATING:"Not Included in Rating",EXCLUDED:"Excluded"
  };
  for (const section of worksheet.sections) {
    for (const row of section.rows) {
      if (!row.id.endsWith(".driverAssignments") || !Array.isArray(row.originalValue))
        continue;
      row.value = row.originalValue.map(assignment=>{
        const label=driverNames.get(assignment.driverId) || assignment.driverId;
        return `${label} — ${displayRole[assignment.role]??assignment.role}`;
      }).join("; ") || "Not provided";
    }
  }
  if (worksheet.brokerReview!=="BROKER_CONFIRMED")
    throw fail("Imported worksheet is not Broker-confirmed.");
  return {
    sourceCaseId: snapshot.source_case_id,
    brokerId: snapshot.finalized_by,
    hash: mapped.original_snapshot_sha256,
    original: snapshot, view:mapped.display_view, worksheet
  };
}

export function saveAuditorReviewedRecord(db, packageId, caseId, prepared) {
  db.prepare(`INSERT INTO imported_reviewed_keyin(
    package_id,imported_case_id,source_case_id,broker_id,snapshot_sha256,
    original_snapshot_json,auditor_view_json,worksheet_json,worksheet_sha256,imported_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    packageId,caseId,prepared.sourceCaseId,prepared.brokerId,prepared.hash,
    JSON.stringify(prepared.original),JSON.stringify(prepared.view),
    JSON.stringify(prepared.worksheet),sha256json(prepared.worksheet),new Date().toISOString()
  );
}

export function loadAuditorReviewedRecord(db, importedCaseId) {
  const row=db.prepare(`SELECT r.broker_id, r.snapshot_sha256,
     r.worksheet_json,r.worksheet_sha256,r.original_snapshot_json, r.package_id
     FROM imported_reviewed_keyin r WHERE r.imported_case_id=?`).get(importedCaseId);
  if (!row) throw fail("This Case has no imported Broker-reviewed Key-in sheet (legacy package).",404);
  const snapshot=JSON.parse(row.original_snapshot_json);
  const sheet=JSON.parse(row.worksheet_json);
  if (sheet.sourceReviewHash !== row.snapshot_sha256 ||
      snapshot.snapshot_sha256 !== row.snapshot_sha256 ||
      sha256json({...snapshot,snapshot_sha256:undefined})!==row.snapshot_sha256 ||
      sheet.brokerReview!=="BROKER_CONFIRMED" ||
      sha256json(sheet)!==row.worksheet_sha256)
    throw fail("Stored Broker-reviewed worksheet is inconsistent.",409);
  return {
    packageId:row.package_id,
    brokerId:row.broker_id,
    finalizedAt:snapshot.finalized_at,
    reviewedHash:row.snapshot_sha256,
    sheet
  };
}

/**
 * Local SQLite persistence for reviewed Broker Key-in drafts.
 * Requires existing BrokerDesk tables `cases` and `audit_events`.
 * Uses one atomic JSON document per Case so a confirmed section and its exact
 * field values cannot be stored in different SQLite transactions.
 */
import {
  createBrokerReview, editBrokerReviewField, confirmBrokerReviewSection,
  updateBrokerReviewSources, finalizeBrokerReview, sha256json
} from "../lib/broker-keyin-review.mjs";

export function ensureBrokerReviewSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS keyin_reviews (
      case_id TEXT PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK(revision>=1),
      status TEXT NOT NULL CHECK(status IN ('DRAFT','BROKER_CONFIRMED')),
      review_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}
function audit(db,caseId,actor,action,details) {
  db.prepare("INSERT INTO audit_events(case_id,document_id,actor,action,details_json,created_at) VALUES(?,?,?,?,?,?)")
    .run(caseId,null,actor,action,JSON.stringify(details),new Date().toISOString());
}
function conflict(message) {
  const error=new Error(message);error.status=409;return error;
}
export class BrokerKeyinReviewStore {
  constructor(db) { this.db=db; ensureBrokerReviewSchema(db); }
  read(caseId) {
    const row=this.db.prepare("SELECT review_json FROM keyin_reviews WHERE case_id=?").get(caseId);
    return row ? JSON.parse(row.review_json) : null;
  }
  create(caseData, options, actor) {
    if (!actor?.trim()) throw new Error("Broker actor is required.");
    const review=createBrokerReview(caseData,options);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.read(caseData.case_id)) throw conflict("Review already exists.");
      this.db.prepare("INSERT INTO keyin_reviews(case_id,revision,status,review_json,updated_at) VALUES(?,?,?,?,?)")
        .run(caseData.case_id,review.revision,review.review_status,JSON.stringify(review),review.updated_at);
      audit(this.db,caseData.case_id,actor,"BROKER_REVIEW_CREATED",
        {revision:review.revision,catalogVersion:review.catalog_version});
      this.db.exec("COMMIT");
      return review;
    } catch(error) { this.db.exec("ROLLBACK");throw error; }
  }
  mutate(caseId,actor,expectedRevision,action,operation) {
    if (!actor?.trim()) throw new Error("Broker actor is required.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous=this.read(caseId);
      if (!previous) {const e=new Error("Review not found.");e.status=404;throw e;}
      if (previous.revision!==expectedRevision)
        throw conflict(`Review version changed: expected ${expectedRevision}, current ${previous.revision}.`);
      if (previous.review_status==="BROKER_CONFIRMED")
        throw conflict("Finalized review is immutable; create a new Case revision to edit.");
      const next=operation(previous);
      if (next===previous) {this.db.exec("COMMIT");return next;}
      const updated=this.db.prepare(
        "UPDATE keyin_reviews SET revision=?,status=?,review_json=?,updated_at=? WHERE case_id=? AND revision=?")
        .run(next.revision,next.review_status,JSON.stringify(next),next.updated_at,caseId,previous.revision);
      if (updated.changes!==1)throw conflict("Review was updated concurrently.");
      // No PII, bank details or raw claim values in the audit_event payload.
      audit(this.db,caseId,actor,action,{fromRevision:previous.revision,toRevision:next.revision});
      this.db.exec("COMMIT");
      return next;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
  edit(caseId,fieldId,value,{actor,expectedRevision,origin,evidence}={}) {
    return this.mutate(caseId,actor,expectedRevision,"BROKER_FIELD_EDITED",
      review=>editBrokerReviewField(review,fieldId,value,
        {actor,expectedRevision,origin,evidence}));
  }
  confirm(caseId,sectionId,{actor,expectedRevision,referenceDate}={}) {
    return this.mutate(caseId,actor,expectedRevision,"BROKER_SECTION_CONFIRMED",
      review=>confirmBrokerReviewSection(review,sectionId,
        {actor,expectedRevision,referenceDate}));
  }
  sourcesChanged(caseId,sourceFiles,{actor,expectedRevision}={}) {
    return this.mutate(caseId,actor,expectedRevision,"BROKER_REVIEW_SOURCE_CHANGED",
      review=>updateBrokerReviewSources(review,sourceFiles,{expectedRevision}));
  }
  finalize(caseId,{actor,expectedRevision,submittedAt}={}) {
    if (!actor?.trim())throw new Error("Broker actor is required.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const draft=this.read(caseId);
      if (!draft)throw new Error("Review not found.");
      if (draft.revision!==expectedRevision)throw conflict("Review revision mismatch.");
      if (draft.review_status==="BROKER_CONFIRMED")
        throw conflict("Review already finalized.");
      const snapshot=finalizeBrokerReview(draft,{brokerId:actor,expectedRevision,submittedAt});
      const next={...snapshot,revision:draft.revision+1};
      next.snapshot_sha256=sha256json({...next,snapshot_sha256:undefined});
      const changed=this.db.prepare(
        "UPDATE keyin_reviews SET revision=?,status=?,review_json=?,updated_at=? WHERE case_id=? AND revision=?")
        .run(next.revision,next.review_status,JSON.stringify(next),next.updated_at,
          caseId,draft.revision);
      if (changed.changes!==1)throw conflict("Review was updated concurrently.");
      audit(this.db,caseId,actor,"BROKER_REVIEW_FINALIZED",
        {revision:next.revision,snapshotHash:next.snapshot_sha256});
      this.db.exec("COMMIT");
      return next;
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }
}
/** This module is intentionally not imported by browser/client code. */

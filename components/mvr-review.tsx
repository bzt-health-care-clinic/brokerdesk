import type { Driver, FieldSource } from "../lib/insurance-types";

const labels: [string, string, keyof Driver][] = [
  ["requestDate", "Requested", "mvr_requested"], ["releaseDate", "Released", "mvr_release_date"], ["replyDate", "Reply", "mvr_reply_date"], ["receivedDate", "Received", "mvr_received"],
  ["issueDate", "MVR issue date (not G progression)", "mvr_issue_date"], ["licenceClass", "Licence class", "licence_class"], ["expiryDate", "Licence expiry", "licence_expiry"],
  ["licenceStatus", "Licence status", "licence_status"], ["conditions", "Conditions", "licence_conditions"], ["demeritPoints", "MVR demerit points", "mvr_demerit_points"],
];
function shown(value: unknown) { return value == null || value === "" ? "UNKNOWN" : Array.isArray(value) ? value.length ? value.join("; ") : "None explicitly reported" : String(value); }
export function MvrReview({ driver, fields }: { driver: Driver; fields: FieldSource[] }) {
  const sources = fields.filter(f => f.subjectType === "DRIVER" && f.subjectId === driver.id);
  return <div className="telematics-block"><h3>MVR source review</h3><dl className="key-grid">{labels.map(([field, label, property]) => {
    const source = sources.find(f => f.canonicalField === field);
    return <div className="key-row" key={field}><dt>{label}</dt><dd>{source?.status === "conflict" ? "CONFLICT — review sources" : shown(driver[property])}{source && <details><summary>Source / decision</summary><p>{source.evidenceReview ? "Supporting evidence changed; review retained decision." : source.status}</p><p>Effective source value: {shown(source.resolved_value)}</p>{source.values.map((v, i) => <p key={i}>{shown(v.value)} · {v.evidence?.map(e => `${e.physicalFileName ?? v.documentId ?? "Document"}, PDF page ${e.page ?? "unknown"}`).join("; ")} · Section {v.logicalDocumentId ?? "whole file"}</p>)}</details>}</dd></div>;
  })}</dl><h4>MVR convictions</h4>{driver.mvr_convictions === undefined ? <p>UNKNOWN — no supported conviction list.</p> : !driver.mvr_convictions.length ? <p>No convictions explicitly reported by this source.</p> : <div className="table-scroll"><table><thead><tr><th>Description</th><th>Offence date</th><th>Conviction date</th><th>Severity</th><th>Points</th></tr></thead><tbody>{driver.mvr_convictions.map((c, i) => <tr key={i}><td>{c.description || "UNKNOWN"}</td><td>{c.offence_date || "UNKNOWN"}</td><td>{c.conviction_date || "UNKNOWN"}</td><td>{c.severity || "UNKNOWN"}</td><td>{c.demerit_points ?? "UNKNOWN"}</td></tr>)}</tbody></table></div>}{sources.filter(f => f.canonicalField === "convictions").map(f => <details key={f.field}><summary>Conviction evidence</summary>{f.values.map((v, i) => <p key={i}>{v.documentId} · Section {v.logicalDocumentId ?? "whole file"} · PDF pages {v.evidence?.map(e => e.page ?? "unknown").join(", ")}</p>)}</details>)}</div>;
}

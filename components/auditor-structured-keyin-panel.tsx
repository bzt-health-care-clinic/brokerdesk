"use client";

import { useMemo, useState } from "react";
import type { ReviewedKeyinResponse } from "@/lib/auditor-reviewed-client";
import {
  buildStructuredAuditorSheet,
  structuredGroupText,
  structuredSectionText,
  structuredSheetText
} from "@/lib/auditor-structured-sheet.mjs";

/**
 * Read-only, presentation-only worksheet for an imported v0.4 BDZIP.
 * No confirm/approve actions: the Broker already signed off on this snapshot.
 */
export function AuditorStructuredKeyinPanel({ review }: { review: ReviewedKeyinResponse }) {
  const view = useMemo(() => buildStructuredAuditorSheet(review.sheet), [review.sheet]);
  const [copied, setCopied] = useState("");

  async function copy(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied("unavailable");
    }
  }

  return (
    <div className="auditor-worksheet" aria-label="Broker-confirmed structured Auditor key-in worksheet">
      <header className="auditor-worksheet-head">
        <div>
          <p className="eyebrow">Auditor · Broker-confirmed Key-in</p>
          <h2>Ready-to-use Key-in Data</h2>
          <p>
            Broker {review.brokerId} confirmed this snapshot. Values are grouped for
            insurer Key-in; no second field-by-field confirmation is required.
          </p>
          <small>
            Confirmed {review.finalizedAt?.slice(0, 16)} · Package {review.packageId}
          </small>
        </div>
        <button
          type="button"
          onClick={() => void copy("whole-sheet", structuredSheetText(view))}
        >
          {copied === "whole-sheet" ? "Copied" : "Copy all"}
        </button>
      </header>

      <div className="auditor-worksheet-stats">
        <span><strong>{view.sections.length}</strong> Key-in sections</span>
        <span><strong>{view.sections.reduce((total, section) =>
          total + section.groups.length, 0)}</strong> Subject / detail groups</span>
      </div>

      {view.sections.map(section => (
        <section
          className="auditor-worksheet-section"
          aria-label={section.title}
          key={section.id}
        >
          <header className="auditor-worksheet-head">
            <h3>{section.title}</h3>
            <button
              type="button"
              onClick={() => void copy(`section:${section.id}`, structuredSectionText(section))}
            >
              {copied === `section:${section.id}` ? "Copied" : "Copy section"}
            </button>
          </header>
          {section.groups.map(group => (
            <article key={group.id} className="auditor-worksheet-entity">
              <header className="auditor-worksheet-head">
                <h4>{group.title}</h4>
                <button
                  type="button"
                  onClick={() => void copy(`group:${group.id}`, structuredGroupText(group))}
                >
                  {copied === `group:${group.id}` ? "Copied" : "Copy group"}
                </button>
              </header>

              <div className="auditor-worksheet-rows">
                {group.rows.map(row => (
                  <div className="auditor-worksheet-row status-confirmed" key={row.id}>
                    <div className="auditor-worksheet-main">
                      <strong>{row.label}</strong>
                      <span className="auditor-worksheet-value" style={{ whiteSpace: "pre-wrap" }}>
                        {row.value}
                      </span>
                      <small>Source evidence: {row.evidencePresent ? "Yes" : "No (Broker entered/confirmed)"}</small>
                    </div>
                    <button
                      type="button"
                      aria-label={`Copy ${row.label}`}
                      onClick={() => void copy(`row:${row.id}`, row.value)}
                    >
                      {copied === `row:${row.id}` ? "Copied" : "Copy"}
                    </button>
                  </div>
                ))}
              </div>

              {group.tables.map(table => (
                <div key={table.id} style={{ overflowX: "auto", marginTop: "0.75rem" }}>
                  <h5>{table.title}</h5>
                  <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                      <tr>
                        {table.columns.map((col, index) => (
                          <th scope="col" key={`${table.id}:col:${index}`}
                              style={{ padding: "0.5rem", borderBottom: "1px solid currentColor" }}>
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {table.rows.map(record => (
                        <tr key={record.id}>
                          {record.values.map((value, index) => (
                            <td key={`${record.id}:${index}`}
                                style={{ padding: "0.5rem", verticalAlign: "top" }}>
                              {value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </article>
          ))}
        </section>
      ))}
      <p className="auditor-worksheet-disclaimer">
        Broker-confirmed submission snapshot. This presentation does not alter
        the source documents, reviewed values, or evidence. It is not an independent
        assessment of the original documents.
      </p>
    </div>
  );
}

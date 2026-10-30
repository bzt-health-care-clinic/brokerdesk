# BrokerDesk Step 5A — Real-sample Key-in coverage measurement (local only)

Baseline application commit: `08e0a6d1176d15dee1d6576967ffa9f481ab0f5c`

This Step 5A track is a **separate measurement exercise**. It is not the staff's ordinary manual new-business Key-in and is not a substitute for underwriting review. The Step 5B Windows / Node 24 and browser regressions are already verified on the Pilot baseline. This branch builds the next measurement instrument; it does not claim that private customer PDFs were run.

## What is measured

The eleven required measurement domains are VIN, Ownership, Driver Assignment, MVR count, DASH count, Quote #, Effective Date, Coverage, OPCF, mixed-PDF logical/physical source mapping, and correct Needs Review behavior. For each independently checked field, the tool separates:

- `AUTO_CORRECT_PROVEN`: an exact match to human-reviewed source truth, `EXTRACTED` origin, and matching original-file SHA-256 / document ID / physical page / active logical section; MVR/DASH counts additionally need a matching Step 5B-07 source count ledger with exact count/page and full-report attestation.
- `AUTO_CORRECT_UNPROVEN`: a matching extracted value without all required evidence binding. **Not counted as automated coverage.**
- `BROKER_CORRECTED`: a matching manually corrected value. **Never counted as automated extraction.**
- `INCORRECT`, `MISSING`, `CONFLICT`, `FALSE_CLEAN`, `UNVERIFIED`: failures or unresolved findings.
- `REVIEW_REQUIRED`: source meaning is unknown and the item remains unconfirmed/flagged; not an automated match.
- `NOT_APPLICABLE`: excluded from the denominator, but does not fulfill a mandatory domain.

The reported *automated source-known coverage* denominator contains only independently checked `PRESENT` or `EXPLICIT_ZERO` facts; an `UNKNOWN` / Needs Review safety test is counted separately and cannot artificially lower or inflate the automated extraction rate.

An empty conviction/claim array is **not** full-report zero-count proof. A Pulled Date page is **not** a count declaration page. A six-year-only claim count cannot be presented as a full-report count. An absent source is never converted into a confident “No”.

## Privacy boundary

Run on the isolated computer, with the original PDF, actual `reviewed-keyin.json` snapshot, and human-created ground truth **remaining on that machine**. The private manifest contains actual field identifiers and expected values and **MUST NOT** be uploaded to GitHub, ChatGPT, shared folders, CI, cloud drives, or email. It is only local working data. Do not commit `step5a-private/` or any source PDFs.

The program computes SHA-256 directly from the original PDF bytes. It compares hashes and pages with the actual snapshot evidence locally, then discards the raw byte buffers. The report contains only category names, status counts, aggregate percentages, the declared application commit, and fixed non-identifying state codes. No names, VINs, addresses, licence numbers, quotes, claim numbers, document IDs, source hashes, paths, or individual rows are written into the report. Source comparison is still **operator-attested**, not independently certified parser accuracy.

## Windows isolated computer: minimum operations

1. Bring only the Step 5A toolkit and the current approved BrokerDesk Pilot application to the isolated computer using approved offline transfer. Keep all private originals there. A computer with **only PDFs and no current BrokerDesk application** cannot measure the new parser or Key-in output. That case remains `NO_REAL_SAMPLES`.
2. Open the current application locally, import the real sample case and compare Key-in with the original PDF page by page. Export or locally extract the `reviewed-keyin.json` **from the current v0.4 reviewed snapshot**; do not use a legacy v0.3 worksheet for current accuracy evidence. Record original PDF paths and logical report sections in `step5a-private/step5a-local-manifest.json`. Use the example structure below as a guide. All IDs and true values stay in the private manifest on the isolated machine.
3. Copy the toolkit ZIP into Downloads, right-click and extract. Open PowerShell **in the extracted toolkit folder** and run:

```powershell
node --version
Test-Path .\RUN-STEP5A.ps1
Test-Path .\step5a-private\step5a-local-manifest.json
powershell -NoProfile -ExecutionPolicy Bypass -File .\RUN-STEP5A.ps1
```

The PowerShell launcher uses `$PSScriptRoot`; it does not require the previous incorrect `tests\step5a.test.mjs` path. Node 24 is recommended; no npm install or network access is needed by this measurement kit.

The sanitized output is `step5a-results/step5a-redacted-report.json`. **Inspect it before sharing.** Share only that redacted report, never the private manifest, `reviewed-keyin.json`, BDZIP, or PDFs. A missing/incorrect source will fail rather than silently mark an unchecked field as passed.

Exit codes: `0` = measurements produced, **NOT formal business approval**; `1` = invalid/unreadable local inputs; `2` = synthetic or zero-real-sample measurement; `3` = incomplete real coverage or unresolved failures. Do not turn exit code `0` into a production go-live decision.

## Private manifest shape (example only — not a real result)

Create the following file **only on the isolated computer** at `step5a-private/step5a-local-manifest.json`:

```json
{
  "schema_version": "step5a-private-v1",
  "dataset": "REAL_PRIVATE",
  "target_commit": "08e0a6d1176d15dee1d6576967ffa9f481ab0f5c",
  "samples": [
    {
      "sample_id": "S01",
      "case_type": "new_auto",
      "review_file": "reviewed-keyin.json",
      "records": [
        {
          "id": "COPY_DOCUMENT_ID_FROM_REVIEW_SOURCE_FILES",
          "source_file": "source-document.pdf",
          "logical_documents": [
            {
              "id": "COPY_SECTION_ID_FROM_LOCAL_SOURCE_RECORD",
              "documentType": "OWNERSHIP",
              "presenceStatus": "FOUND",
              "startPage": 1,
              "endPage": 1
            }
          ]
        }
      ],
      "checks": [
        {
          "category": "VIN",
          "fieldId": "vehicle:COPY_ENTITY_ID.vin",
          "groundTruth": "PRESENT",
          "expectedValue": "COPY_ACTUAL_VIN_FROM_ORIGINAL_PDF_LOCALLY",
          "documentId": "COPY_DOCUMENT_ID_FROM_REVIEW_SOURCE_FILES",
          "physicalPage": 1,
          "logicalDocumentId": "COPY_SECTION_ID_FROM_LOCAL_SOURCE_RECORD",
          "originalChecked": true
        }
      ]
    }
  ]
}
```

Paths such as `reviewed-keyin.json` and `source-document.pdf` are relative to the private manifest; full local paths are supported. This example is **not executable acceptance evidence** until every placeholder is replaced and independent source comparison has been performed. If the source record contains a mixed package, list all logical sections with their actual IDs, types and physical page intervals. For MVR/DASH counts, `fieldId` must be the actual `report:mvr:...summary` or `report:dash:...summary` field, `expectedCount` a non-negative integer, `groundTruth` `EXPLICIT_ZERO` for zero or `PRESENT` for a positive count, and `countDeclaration` exactly `EXPLICIT_FULL_REPORT`. The count-page evidence must match the actual Step 5B-07 ledger; never invent a page number. For an unresolved source, use `groundTruth: "UNKNOWN"` and preserve Needs Review; do not supply an invented answer.

## Acceptance and non-acceptance

GitHub CI on this Step 5A branch may prove only that the **measurement code** and synthetic safeguards work. It cannot prove real private PDF accuracy. The safe status before any real measurement is `NO_REAL_SAMPLES`, not PASS. A report with real measurements and all eleven domains covered can become `REAL_MEASURED_AWAITING_BUSINESS_THRESHOLDS_AND_SIGNOFF` only if all rows are checked without unresolved errors. The office still needs to approve a business accuracy threshold and sign off on representative real sample coverage before any production-use claim. Synthetic cases, fabricated truth, or manually corrected records cannot satisfy the real-parser accuracy gate.

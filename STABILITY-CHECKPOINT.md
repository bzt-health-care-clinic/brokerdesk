# Stability repair checkpoint — comprehensive continuation

## 2026-10-16 continuation (sanitized checkout only)

- Phase 1 IN PROGRESS. PDF.js extraction now retains `hasEOL` row boundaries; bounded inline/next-line label parsing supports the synthetic quote, MVR and DASH fixture layouts. Focused real-PDF.js text test PASS: distinct MVR identities, DASH [1–3]/[4–6], quote effective date and claim rows. Browser/Accept-all verification is NOT RUN after this edit. Vinext's originating `window is not defined` module is still UNKNOWN; the Run 4 overlay stack only identifies its reporter.
- Acceptance harness popup waits now use context `page` events with rejection attached before the click. Focused harness-state test and syntax PASS. C/D real-browser outcomes remain NOT RUN after this edit.
- Phase 2 targeted four checks PASS locally under Node 24 with synthetic fixtures: `tests/phase2-regression.ts`, `tests/phase3-regression.ts`, `tests/ocr-space.ts`, `tests/stability-audit.ts`. The checks now preserve source conflicts; supply synthetic active-evidence references; cover uniquely matched versus blank-case Ownership without inventing a vehicle; and distinguish withdrawn active values from retained history/manual decisions. Full regression remains NOT RUN. See `KNOWN-FAILURES.md` for precise limitations.
- TypeScript `--noEmit --incremental false` PASS after the PDF/acceptance edits (before later Phase 2 edits; rerun required). Batch 2B and Batch 3 IN PROGRESS / NOT VERIFIED. No hosted Actions runs, commit, push, live OCR or public deployment in this continuation.
- Local Vite startup requires an execution permission beyond the restricted process sandbox because Vite's Windows real-path helper hits `spawn EPERM`; a loopback Vinext server started under the approved escalation. Playwright Chromium is installing into task-local temporary storage for a focused synthetic browser reproduction.

## Historical checkpoint (superseded status; retain for provenance)

# Stability repair checkpoint — Batch 2A

2026-10-15. Batches 1 and 2A implemented. Batch 2B and Batch 3 remain pending. No live cases/files or OCR provider were used for verification. The workspace has no accessible Git metadata.

## Batch 2A completed

### A–E acceptance implementation — IMPLEMENTED_NOT_RUN

- Implemented the original five scenarios in tests/acceptance/scenarios.mjs; entrypoint `node tests/browser-acceptance.mjs` runs existing preflight then serial A–E, zero retries. Failed preflight reports BLOCKED, not acceptance pass.
- tests/acceptance/runtime.mjs runs the real frontend/backend with per-scenario disposable SQLite/files and fresh browser contexts. A/D replace the real backend process against the same directory. Browser actions perform all application mutations; backend/SQLite reads only assert outcomes.
- External provider only is stubbed using loopback OCR.Space-format multipart responses, real rendered JPEG dimensions and explicitly converted authoring coordinates. Test-only provider-network-guard.mjs rejects external backend fetch. LIVE_OCR disabled, zero calls. No production UI/parser/PDF.js/reconciliation changes.
- Updated manual Windows workflow to preflight → A–E → selected reports/artifacts, bounded timeouts and three-day retention. No repository creation, push, hosted trigger or environment retry.
- Available checks: five test module syntax checks PASS; repository TypeScript noEmit/incremental-false PASS. These do not execute Playwright or validate runtime selectors. Browser scenarios A–E all IMPLEMENTED_NOT_RUN; no screenshots/traces/browser pass claimed.
- Full coverage/limits: tests/acceptance/README.md. Machine implementation status: tests/acceptance-reports/2026-10-15/implementation-status.json. Earlier BLOCKED report preserved unchanged.
- Execution prerequisite remains an authorized clean hosted checkout with Vite/Chromium permissions. Missing UI association/resolution paths will be explicit failed usability checks, not bypassed by injected case data. Batch 1/2A prior automated status unchanged; Batch 2B/3 pending.

### Acceptance origin/hosted readiness follow-up — prepared, NOT executed

- Fixed separate-port 403 with server-only BROKERDESK_LOCAL_FRONTEND_ORIGIN, exact loopback matching and unchanged normal 5173 defaults. GET and OPTIONS reject unapproved origins. Backend still binds 127.0.0.1.
- tests/local-origins.mjs PASS against disposable backend; harness syntax PASS. No Vite/Chromium retry, OCR, customer data or full regression.
- No accessible Git repository/remote; private visibility UNKNOWN; push/Actions authorization NOT CONFIRMED.
- Prepared .github/workflows/browser-acceptance-readiness.yml, manual Windows Chromium serial smoke only, bounded timeouts and three-day allowlisted artifacts. NOT RUN. Existing harness does not implement full A–E acceptance; no claim of PDF/browser persistence verification.
- BROWSER_EXECUTED remains unverified; STUBBED_OCR and LIVE_OCR NOT_RUN. Earlier blocked evidence retained. See tests/acceptance-reports/2026-10-15/hosted-readiness.md.
- Next external prerequisite is an explicitly authorized GitHub/Actions destination; do not publish or trigger without authorization. Batch 1/2A automated-test status unchanged; Batch 2B/3 pending.

### Browser acceptance follow-up — 2026-10-15: BLOCKED

- Supplied synthetic pack extracted to tests/fixtures/browser-acceptance-20261015/BrokerDesk_Synthetic_Test_Pack; task, README and expected manifest read.
- Real backend started and restarted on loopback port 47841 with disposable tests/.acceptance-20261015/data; empty database remained empty. This is not browser/case/note persistence verification.
- Existing Vite/vinext startup on separate port 5183 failed with spawn EPERM during configuration loading. No supported process-execution escalation exists in this session; no security bypass or repeat of the denied launch attempted.
- Project Playwright/Puppeteer unavailable; bundled Playwright import failed; connector Chrome unavailable. In-app browser does not establish the required fresh-profile acceptance environment.
- Separate-port backend request reproduced HTTP 403 because the origin allowlist only permits frontend port 5173. Recorded, not bypassed or changed.
- Scenarios A–E BLOCKED; screenshots, browser traces, PDF.js execution and real-document workflow NOT RUN. STUBBED_OCR and LIVE_OCR NOT_RUN, zero requests. Test servers stopped; customer data untouched.
- Added syntax-checked tests/browser-acceptance-preflight.mjs for bounded reproducible capability/smoke checking; not a complete A–E suite and not executed after the denial.
- Detailed report, machine results and failure excerpt: tests/acceptance-reports/2026-10-15/. No production behavior changes. Batch 2B and Batch 3 remain pending.
- Resume needs an approved execution environment with this worktree/dependencies, permitted Vite child processes and isolated Chromium; then address the test-origin configuration and exercise A–E in the real UI.

- Conservative DASH/MVR section boundaries use report/subject identity, report dates, printed sequence, restarts and continuation evidence. Supported multipage reports remain grouped; conflicting identities split; uncertainty stays proposed/NEEDS_REVIEW. Manual sections remain authoritative.
- Report subjects use existing explicit IDs or unique supported identifiers, never array position or name-only fallback. Historical claim operators are separate from the report subject. Original physical pages and logical IDs remain attached to evidence.
- MVR requested/release/reply/received dates, issue date, class, expiry, status, conditions, demerits and convictions reach subject-specific review data and the Driver UI. Offence and conviction dates remain separate; missing values remain unknown. Issue date does not set licence progression.
- DASH historical claims survive zero-recent summaries, including mixed JSON/text detail formats. Source records retain party roles, unknown fault, amounts, expenses, status and original evidence. Conservative duplicate warnings never merge or sum records. Content-stable row IDs survive reordered claims; source withdrawal uses the existing reconciliation ledger and preserves manual decisions with review flags.
- One shared assessment uses the intended policy/change effective date across claim review, summary and related QA. Missing/invalid dates leave period classification undetermined. Lookback and inclusive boundary remain configurable.
- Nullable logical_documents.document_subtype migration, storage and hydration preserve explicit subtypes through reopen, editing, local reparse and Smart Rename. Migration backfills only explicitly stored JSON subtypes; absent values stay unspecified.
- Parser version 4 and section-analysis version 1 refresh affected report results locally from saved text/positioned blocks. Non-report sources and manual section authority are preserved; successful OCR is not regenerated.

## Batch 2A final verification — 2026-10-15

- PASS: tests/stability-batch2a.ts (boundaries, subject mapping, MVR rendered review, historical claims, shared assessment date, source withdrawal, subtype migration/reopen and saved-evidence refresh).
- PASS: tests/stability-batch1.ts, tests/document-package.ts, tests/package-analysis.ts, tests/local-reparse.ts.
- PASS: TypeScript --noEmit --incremental false. One final combined compatibility run and one project TypeScript check.
- Local refresh test rejects network requests and verifies zero calls. Synthetic fixtures and disposable SQLite only.
- NOT RUN: full regression, production build, real browser interaction, actual user-environment restart and live OCR. No live OCR quota consumed.

## Batch 2A files changed

- New: lib/report-boundaries.ts, lib/report-details.ts, lib/claim-records.ts, lib/claim-assessment.ts, components/mvr-review.tsx, tests/stability-batch2a.ts.
- Updated: lib/package-analysis.ts, lib/document-ingestion.ts, lib/local-reparse.ts, lib/reconciliation.ts, lib/insurance-types.ts, lib/extraction-types.ts, lib/rule-engine.ts.
- Updated: app/page.tsx, components/ingestion-panel.tsx, local-server/database.mjs, local-server/repositories.mjs, tests/package-analysis.ts, STABILITY-CHECKPOINT.md.

## Batch 2A remaining limitations

- No known outstanding implementation item from this batch's supported synthetic cases. Real-world report layouts are not universally parsed: unsupported/ambiguous boundaries or detail formats require broker review rather than guessed facts.
- Possible duplicate claims remain separate source records, not a deduplicated accident count. Legacy subjectless/manual data requires explicit review where provenance is insufficient.
- Browser interaction and a restart against the user's installed data remain unverified. Database reopen/migration and MVR component rendering were exercised in isolated tests only.

## Batch 1

- Case-contained, line-of-business/subject-scoped source fields. Stable IDs are added to existing subjects and persisted with case JSON. Exact unique licence/VIN identifiers or explicit section associations are required; names alone never assign facts. Manage sections can select a specific existing subject. Unassigned evidence remains visible to QA.
- Canonical spelling aliases preserve original evidence keys; property insured-since and continuous insured-since remain distinct.
- Section revisions bind parsed facts to physical file, logical section, type, page range and subject. Section edits/deletions withdraw old parsed sources, archive them and locally reparse saved text. Deleted ranges are excluded from automatic rediscovery. Siblings and original files remain intact.
- CTSAC/diploma validation requires active source references; cached withdrawn objects are retained as history, not qualifying evidence. Recorded membership decisions survive with changed-support review flags.
- Field resolutions/corrections retain actor/time/history and changed-support review flags. Unrelated client-confirmed facts and explicit case completion statuses are preserved.
- New lease/mortgage values are unknown rather than false/zero. Missing negative facts show UNKNOWN/NOT CONFIRMED. Existing false/zero values are retained; uncertain provenance is flagged. Explicit confirmation metadata can distinguish legitimate None.
- SQLite adds nullable logical_documents.subject_id using an idempotent additive migration. No documentSubtype migration was included.

## Verification actually executed

- tests/stability-batch1.ts: PASS; nine requirement groups, including two subjects, same-subject conflicts, canonical keys, section type/page/subject changes, withdrawal, manual history, unknown display, SQLite reopen and physical deletion. Local metadata reparsing runs with network calls rejected and made zero calls.
- tests/document-package.ts: PASS.
- tests/package-analysis.ts: PASS with Node --experimental-transform-types (initial strip-only invocation could not load parameter properties).
- tests/local-reparse.ts: PASS. Updated the manual-resolution lookup for subject-scoped canonical fields after the old unscoped assertion failed.
- TypeScript: PASS, one project check (noEmit, incremental false).
- No full regression, production build, live OCR or real browser UI verification.

## Files changed

- lib/active-evidence.ts, lib/field-keys.ts, lib/fact-display.ts (new)
- lib/reconciliation.ts, lib/insurance-types.ts, lib/extraction-types.ts
- lib/case-factories.ts, lib/document-ingestion.ts, lib/local-reparse.ts, lib/package-analysis.ts
- lib/phase3-rules.ts, lib/rule-engine.ts
- local-server/database.mjs, local-server/repositories.mjs
- components/ingestion-panel.tsx, app/page.tsx
- tests/stability-batch1.ts (new), tests/local-reparse.ts
- STABILITY-CHECKPOINT.md (this file)

## Remaining limitations

- Legacy subjectless values cannot safely be assigned to a driver/vehicle from a name alone. They need broker association/review; legacy scalar values are not indiscriminately deleted.
- Ownership evidence is now stored per associated vehicle; complete per-vehicle business-rule/content validation remains Batch 2. The legacy aggregate Ownership view is not automatically populated from an arbitrary vehicle.
- Unknown-value confirmations use explicit provenance metadata. A comprehensive confirmation editor is outside this batch.
- Multiple competing CTSAC applications/diplomas remain review-required rather than arbitrarily selecting one. Broader discount source checks remain in Batch 2.
- Browser interaction and actual user-environment restart remain unverified; persistence was verified using a reopened disposable SQLite database.

## Batch 2B — DO NOT IMPLEMENT YET

- Validate Ownership content per relevant vehicle, not presence/matching blanks.
- Reconcile HAB mortgage, risk address and separate history dates.
- Finish active-source checks for discount evidence after Batch 1.
- Expose already-modeled HAB details. KEEP PAYMENT LAST.

## Batch 3 — DO NOT IMPLEMENT YET

- Detect final-intent/transaction-selection conflicts without converting explicitly confirmed separate Add/Delete transactions.
- Required UW cannot be bypassed by contradictory NOT_REQUIRED. Backdating alone must not introduce a universal approval requirement.
- Explicit KEYED/INCOMPLETE badge takes precedence over validation-not-started.
- Add a dedicated name-change transaction if absent.

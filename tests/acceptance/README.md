# Synthetic A–E browser acceptance

Implementation status: **IMPLEMENTED_NOT_RUN** for A, B, C, D and E. Only syntax and the repository TypeScript check have run in the restricted authoring session. Runtime assertions/selectors still require their first real execution; no screenshot/trace/pass exists from this implementation.

Command in an authorized clean checkout with repository dependencies and the workflow-pinned Playwright/Chromium installed:

```text
node tests/browser-acceptance.mjs
```

This serial Playwright API runner has one browser, a fresh context per scenario, zero retries, a 15-minute watchdog and per-action/poll limits. It runs the existing preflight first. Nonzero preflight produces BLOCKED for A–E, never acceptance pass. Existing 403 protection is configured with the exact frontend origin http://127.0.0.1:5183; API is 47841 and test provider is 47842, all loopback. No existing service/normal data directory is reused.

## Original scenario coverage

| Scenario | Implemented checks |
| --- | --- |
| A — Case lifecycle and persistence | Empty state; selector noncreation; single blank factory result; older-case edit/list stability; note reload; actual backend PID replacement with same disposable DB; final-case deletion and empty reload. No blocker bypass or forced KEYED state. |
| B — Searchable PDF, two drivers, report boundaries | UI chooser upload of 01/03/04; physical byte hashes; embedded extraction/zero provider requests; separate MVR and three-page DASH ranges; explicit UI association where subjects exist; per-driver dates/points/convictions in normalized persistence and review UI; historical/party-role evidence; shared effective date in claims and summary. Missing subject-creation UI is a failed usability check, not API/JSON seeding. |
| C — Actual PDF worker, scan and mixed package | Scan upload/Open; worker event and real rendered JPEG received by provider; 12 real pages with only page 4 OCR; original byte retention/provenance/report sections; unsigned validity; local reparse/reload/case switch quota protection; declared provider failure stays in card. |
| D — Active evidence, manual sections and rename | Edit via dialogs; retained manual classification/association after reparse; attempt manual resolution through existing QA controls; delete section and check active source withdrawal/sibling preservation; retain manual decision and changed-support flag where linked; UI rename/Open and actual backend restart/physical bytes. Absent resolution UI is reported as failed, not silently skipped. |
| E — UI errors, controls and known pending findings | Script/console/worker/request failure capture for all scenarios; chooser image upload distinct from DOM PDF drop; desktop/narrow bottom-control reachability/unused-bottom-space check/screenshots; HAB/PC fixture observations only, marked pending rather than accepted. |

All application writes are through UI. Backend GETs and read-only SQLite queries are assertions only. No imports of production parser/reconciliation into the tests, no expected JSON written into case state. Fixture hashes are verified before running. Extraction failures are categorized separately from workflow failures; unsupported layouts do not get silently marked accurate.

## OCR and safety

Only OCR.Space's external HTTP boundary is stubbed. The real app uploads/rendering, local API validation, multipart transport, response normalization, parser, reconciliation and SQLite run unchanged. The loopback stub accepts only named synthetic scan inputs, rejects full PDFs, and scales declared authoring PDF-point boxes to the actual JPEG/PNG dimensions. It produces a clearly declared synthetic provider response, not live OCR evidence. Backend fetch is restricted by a test-only preload to that endpoint. Browser external requests are blocked. No production injection/default changes.

LIVE_OCR is always NOT_RUN (zero), not merely dependent on missing credentials. The child gets a whitelisted environment and dummy test token. Application .env files cause refusal before startup. Fresh data is under ignored tests/.acceptance-runs/ae-*/data-A through data-E; these directories are never artifacts. Each scenario starts from empty SQLite; A/D restart the actual backend process against unchanged test storage (not an OS restart).

## Outputs and hosted sequence

Existing manual workflow: .github/workflows/browser-acceptance-readiness.yml. Windows 2022/Node 24, locked app dependencies, temporary Chromium tooling derived from locked Next's optional Playwright peer baseline. Sequence: preflight → A–E → always collect explicit reports/logs/screenshots/traces. No automatic triggers, matrix or retries. Job 35 minutes, suite step 18 minutes, short three-day artifacts.

suite-*/artifacts contains machine results, Markdown/HTML report and actual per-scenario screenshots/traces; ae-*/artifacts contains logs and E screenshots. Screenshots/traces are only generated after real browser execution. Results record BROWSER_EXECUTED, STUBBED_OCR, LIVE_OCR, request counts, runner OS, per-check failures and backend PIDs. HTML escapes report text. No whole-repository, DB, uploaded-document, backup or environment-file artifacts.

Earlier blocked evidence remains in tests/acceptance-reports/2026-10-15. No repository/push/service authorization is implied. Execution still needs an authorized clean hosted checkout with permitted Vite/Chromium execution. No Windows usability or real-client accuracy claim until corresponding actual evidence exists. Batch 2B/3 remain pending.

# Acceptance unblocking — prepared, not executed

## 403 diagnosis and repair

Observed request: GET /bootstrap, Origin `http://127.0.0.1:5183`, target `http://127.0.0.1:47841/bootstrap`, Host `127.0.0.1:47841`. Host follows the fetch URL; it was not separately captured in the earlier log.

The server checked `origin && !allowedOrigins.has(origin)` and returned 403 before route dispatch. It accepted only `http://127.0.0.1:5173` and `http://localhost:5173`. The harness configured the API URL and frontend port, but had no server allowed-origin configuration. This was not an OCR request/failure.

Added server-only `BROKERDESK_LOCAL_FRONTEND_ORIGIN`: one exact canonical HTTP(S) loopback origin, appended to unchanged normal defaults. Wildcards, credentials, paths and LAN/public hosts are rejected. The listener remains 127.0.0.1. OPTIONS now uses the same rejection condition as ordinary requests. The harness derives the launch port, navigation URL, origin check and backend setting from one frontendOrigin constant.

## Verification actually executed

- `node tests/local-origins.mjs`: PASS, actual HTTP GET/OPTIONS to disposable SQLite backend; configured 5183 succeeds, both existing 5173 origins succeed, wrong port/public origin rejected with no CORS allow header. Invalid/wildcard/LAN configuration rejected.
- `node --check tests/browser-acceptance-preflight.mjs`: PASS.
- No local Vite/Chromium retry, full regression, customer data access or OCR request.

## Hosted availability

- GitHub remote present: NO accessible repository/remote metadata; git rev-parse reports not a git repository.
- Private visibility: UNKNOWN.
- Existing acceptance workflow: NO before this change.
- Authorized ability to push/trigger Actions: NOT CONFIRMED. No remote URLs/credentials printed; no repository created or pushed.

## Prepared workflow and limits

`.github/workflows/browser-acceptance-readiness.yml`: manual workflow_dispatch only, Windows 2022 runner, Node 24 (compatible with repository engines and existing local runtime), npm ci from lockfile, one Chromium/context, serial execution, zero retries. Job 20 minutes, smoke 3 minutes; collection gets remaining time. Three-day artifact retention, explicit output-file allowlist, no data directories/environment/whole-repository upload. No secrets referenced. Existing blocked report remains unchanged.

The lockfile does not install Playwright. Workflow derives the exact baseline 1.51.1 from locked Next's optional @playwright/test peer range, installs that version temporarily without modifying the lockfile, and installs only Chromium. This preparation has not been executed or validated on Actions. No browser dependency installed locally.

The existing harness is only capability/smoke, NOT scenarios A–E. Workflow does not claim PDF rendering/parser/reconciliation/persistence acceptance: those browser scenarios still need implementation against an observed running UI. Synthetic fixtures are present, but the smoke does not upload them. No fake business-data injection or stubbing was added. STUBBED_OCR=NOT_RUN; LIVE_OCR=NOT_RUN, zero calls. BROWSER_EXECUTED is set only after actual Chromium launch; actual runner platform/release is recorded. Screenshots/traces exist only when browser execution reaches capture. No HTML reporter is installed; JSON is collected. The fresh disposable database and browser context are never customer data.

Single external prerequisite: an explicitly authorized GitHub repository/Actions destination for this code and synthetic pack (visibility verified before any publication). No push/trigger authorization is inferred. After authorization, publish/review the readiness workflow, run it, then complete A–E; a smoke pass alone is not acceptance. Batch 2B/3 remain pending.

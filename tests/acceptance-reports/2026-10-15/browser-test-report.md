# Browser acceptance after Batch 2A — BLOCKED

Date: 2026-10-15. Windows local execution. No browser acceptance pass is claimed.

## Revision and inputs

Worktree: `<sanitized-project>`.
`git rev-parse HEAD` returned “not a git repository”; no commit revision available.
Read CODEX_TEST_TASK.txt, README.md, expected/expected-results.json and STABILITY-CHECKPOINT.md.
ZIP extracted without overwriting existing files into `tests/fixtures/browser-acceptance-20261015/BrokerDesk_Synthetic_Test_Pack`.
Fixture manifest is ground truth only; no expected fields were injected into application data.

## Actual preflight results

| Check | Result | Evidence |
| --- | --- | --- |
| Backend launch | PASS | `/health` HTTP 200; `/cases` HTTP 200 `[]` |
| Vite/vinext launch | BLOCKED | `spawn EPERM` during config loading, Vite `optimizeSafeRealPathSync` |
| Browser tooling | BLOCKED | No Playwright/Puppeteer project dependency; bundled Playwright import failed; browser connector reports Chrome unavailable |
| Available browser surfaces | Limited | In-app browser and MCP Apps only; fresh isolated profile not established |
| Separate frontend origin | FAILED | Backend `/bootstrap` with Origin `http://127.0.0.1:5183` returned HTTP 403 `Origin not allowed` |
| Backend process restart | PASS, empty DB only | Stopped test backend, launched a new process using same test directory, `/health` 200 and `/cases` `[]` |
| New preflight entrypoint syntax | PASS | `node --check tests/browser-acceptance-preflight.mjs` |

The backend's allowlist currently only accepts frontend port 5173. That port was not used because it could be the broker's normal app. No CORS protections were disabled or bypassed. Once execution is available, a narrowly configurable loopback test origin is also needed.

## Commands actually executed

Backend (twice, with a stop between launches):
```powershell
$env:BROKERDESK_DATA_DIR = Join-Path $PWD 'tests/.acceptance-20261015/data'
$env:BROKERDESK_LOCAL_API_PORT = '47841'
$env:OCRSPACE_API_KEY = ''
$env:OCRSPACE_API_URL = 'http://127.0.0.1:47842/disabled'
node local-server/server.mjs
```

Frontend (once):
```powershell
$env:BROKERDESK_FAST_LOCAL = 'true'
$env:NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL = 'http://127.0.0.1:47841'
$env:OCRSPACE_API_KEY = ''
node scripts/run-framework.mjs dev --port 5183 --hostname 127.0.0.1
```

The normal local startup wrapper launches these two existing entrypoints; they were launched separately to control ports and restart. Vite configuration was unchanged. Failed frontend output is summarized in `preflight-failure.log`; it is an excerpt, not a full trace.

## Acceptance scenarios

- A lifecycle/manual data persistence: BLOCKED. Empty backend restart is not a case/note/browser persistence test.
- B searchable PDFs/driver attribution/report boundaries: BLOCKED. No PDFs uploaded or PDF.js executed.
- C scan/mixed package: BLOCKED. No rendering, external stub or real OCR executed.
- D sections/evidence/rename: BLOCKED. No application data modified through UI.
- E desktop/narrow layouts/error capture: BLOCKED. No app screenshots or Playwright trace could be captured. No native file-picker or DOM drag/drop validation.
- HAB/Policy Change pending baseline: NOT_RUN.

## Modes and isolation

- REAL_BROWSER_LOCAL: BLOCKED, not PASSED.
- STUBBED_OCR: NOT_RUN, zero requests.
- LIVE_OCR: NOT_RUN, zero requests. Optional live testing was skipped because browser execution was blocked.
- Empty process key overrode `.env.local`; provider URL was forced to an unused loopback endpoint. Backend health confirmed NOT_CONFIGURED. No secrets printed and no customer database/files read.
- Data retained only under `tests/.acceptance-20261015/data`; test servers stopped. Actual backend process restart performed; no OS restart.

## Runnable continuation and minimum capability

`node tests/browser-acceptance-preflight.mjs` is a bounded capability/smoke entrypoint: separate ports, new disposable directory, external browser requests blocked, no OCR, fresh Playwright context, logs/results and screenshot/trace if the app becomes reachable. It is syntax-checked only, deliberately not rerun after the identical process denial. It is NOT a completed A–E acceptance suite.

Minimum execution capability: an approved host/session able to launch this worktree's Vite child processes and an isolated Chromium/Playwright browser. Current tool permissions expose filesystem/network grants, not a process-execution grant; requesting broader file/network access would not fix this EPERM. No sandbox bypass, repeated denied launch, dependency installation or assumed cloud transfer attempted.

After that capability exists: address the separate-port loopback origin configuration, run preflight, then implement/run A–E against observed UI. No production logic fixes were made on the basis of unexecuted browser tests. Batch 2B and Batch 3 remain pending.

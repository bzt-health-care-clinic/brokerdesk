# BrokerDesk synthetic acceptance inputs

This pack contains 7 PDF files and 1 PNG, an expected-results manifest, authoring
ground truth for the scan, and a task for a repository-capable coding agent.
No actual customer documents, real signatures, API keys, or official report
artwork are included. All names, identifiers, amounts and dates are invented
fixture data. The files are not valid insurance or identification documents.

## What has actually been verified here

- All 26 PDF pages across the seven PDFs were rendered for visual inspection.
- PDF text bounds were checked for page overflow.
- `02_ownership_scan.pdf` is one raster-only page: no extractable text layer.
- `05_mixed_auto_package.pdf` has 12 pages; page 4 alone is raster-only.
- `02_ownership_scan.png` is smaller than the configured 1 MiB test limit.
- SHA-256 and byte/page counts are in `expected/expected-results.json`.

BROKERDESK HAS NOT BEEN RUN AGAINST THESE FILES HERE. This package is input and
assertion material, not evidence that the application passed tests.

## Files

| Input | Purpose |
| --- | --- |
| 01_auto_quote_text.pdf | Selectable text; two driver identities; basic quote |
| 02_ownership_scan.pdf | Bilingual raster-only layout with instruction traps |
| 02_ownership_scan.png | Same scan as a small standalone PNG |
| 03_mvr_two_drivers_text.pdf | Two separate one-page driver reports |
| 04_dash_two_reports_text.pdf | Two consecutive three-page reports; older claim and party roles |
| 05_mixed_auto_package.pdf | Quote, unsigned application, Bill of Sale, scan, DASH, MVR in one PDF |
| 06_hab_mortgage_and_dates_text.pdf | Mortgage present and three intentionally different dates |
| 07_policy_change_requests_text.pdf | Payment/cancellation requests and explicitly separate vehicle operations |

## Mixed package map (physical PDF page numbers)

1: Auto quote
2: Auto application, intentionally unsigned
3: Bill of Sale
4: Ownership scan
5-7: DASH, ALPHA / report SYN-DASH-A
8-10: DASH, BETA / report SYN-DASH-B
11: MVR, ALPHA
12: MVR, BETA

## Ground-truth caution

`ownership_ground_truth.json` describes what was printed when the synthetic
page was authored. Its coordinates are top-left PDF points. It is NOT actual
OCR output and has no OCR confidence scores. A test adapter must convert units
explicitly if it uses this to produce a declared stub response. Never call that
a live OCR test, and never inject expected results directly into application
state during an end-to-end test.

Licence/VIN-shaped values are deliberately constructed. No claim is made that
they identify real people or vehicles. The two VIN strings have a computed
check digit only to avoid an unrelated checksum failure during syntax tests.

## Scope limits

These samples test pipelines, attribution, boundaries, evidence lifecycle and
UI persistence. They are NOT representative official carrier/Ministry templates
and do not establish real Ontario document accuracy or underwriting eligibility.
Do not special-case their text in production. An unsupported layout with a clear
review requirement is different from silently assigning the wrong person/value.

HAB and Policy Change inputs include pending Batch 2B/3 baseline cases; their
presence does not mean those batches are implemented. Only use a six-year claim
lookback as an explicit test parameter, not a new universal carrier rule.

## Agent use

Give the repository-capable coding agent this entire ZIP and tell it to read
`CODEX_TEST_TASK.txt` first. It must read its actual current repository scripts
and adapt browser selectors to that UI; this pack does not contain a fabricated
ready-to-run Playwright script for unseen source code.

Use disposable storage. Real application/backend/PDF.js/SQLite must run.
Only external OCR may be stubbed in an explicitly labelled offline test mode.
Live OCR is capped at three requests, synthetic inputs only, using an existing
server-side secret and authorized network access. Do not install PaddleOCR.

Official reference documentation:
- https://playwright.dev/docs/test-webserver
- https://playwright.dev/docs/input
- https://playwright.dev/docs/test-use-options
- https://help.openai.com/en/articles/20001545-using-codex-cloud
- https://ocr.space/ocrapi

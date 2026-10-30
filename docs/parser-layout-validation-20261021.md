# Geometric insurance parsing: development regression, 2026-10-21

## Implemented

The native PDF.js route now retains top-left cell coordinates and original physical page numbers instead of discarding the layout. Applied Rating value-above-label tables use bounded column alignment, wrapped-label handling and strict typed values. A known table with unavailable geometry does not fall back to guessing the next line. Unknown signed-application grids withhold header-like values instead of treating field labels as client data.

Auto vehicle and driver observations remain independent entity groups. Excluded vehicles stay visible but cannot contribute rated vehicle facts. Property observations and previous-policy history stay separate from current-policy data. Case entries are not silently overwritten. A factory zero/false without confirmation cannot hide a reliable extracted value in the Auditor worksheet.

Ontario MVR parsing separates parallel columns, uses DMY dates, preserves the raw class/conditions evidence, and recognizes decorated conviction counts. Only an explicit zero with no contradictory detail yields an empty conviction list. Positive counts must agree with extracted detail rows. Offence and conviction dates remain distinct; aggregate points do not invent per-offence severity.

DASH detail records retain their own policy, vehicle, driver, first/third-party perspective, amounts and fault evidence. A recent-period zero never erases historical records. A redacted claim number stays missing; an ordinal is not substituted as its identifier. Unidentified or ambiguous party association remains UNKNOWN.

Every accepted field retains document/section/entity identity and physical page evidence. Low-confidence, invalid or conflicting cells are withheld with a review warning. Parsing never sets a signature-verification or manual-confirmation flag. `Daily km` remains a literal daily-distance observation, not an assumed one-way commute.

## Reproducible development measurements

The baseline application source is commit `38200ea7d9537561a6f230717132caa68c4882cc`. Baseline and revised parsers were run against identical native text from the application's locked PDF.js 5.4.624 engine. Reference values and physical pages were manually checked against the original page images. The reference set is fixed before the final scoring run. Values normalized only by the known template date order, numeric formatting and licence punctuation are equivalent.

| Selected source | Reference fields | Baseline correct / wrong / missing | Revised correct / wrong / missing | Correct value with correct physical page |
| --- | ---: | --- | --- | ---: |
| Applied Auto quote | 20 | 1 / 9 / 10 | 20 / 0 / 0 | 20 |
| Applied Home quote | 30 | 0 / 12 / 18 | 30 / 0 / 0 | 30 |
| Ontario MVR | 13 | 0 / 3 / 10 | 13 / 0 / 0 | 13 |

**63/63 describes only this selected, in-sample development reference set. It is not an overall accuracy estimate, an independent holdout result, an OCR accuracy score or production approval.** No unmeasured field is counted as correct. These exact same-engine numbers supersede earlier approximate regex-only checks; the denominators are not interchangeable.

The production package-analysis and worksheet code was also exercised locally using original PDF bytes with the same native text adapter. One 31-page DASH remained a single report with 13 separate previous-policy records and 16 retained claim-detail observations. A 33-page combined Auto package retained separate vehicle/driver groups, two distinct DASH reports and two distinct MVRs. Two excluded vehicle rows did not populate the rated-car facts. Five image-only pages in that combined file were explicitly unprocessed because external OCR was disabled.

## Tests and operational limits

`tests/layout-parsers.mjs` is entirely synthetic and covers geometry, blank and invalid cells, uncertainty, separate subjects, exclusions, first/third-party fault, missing/redacted identifiers, source pages, changed hashes, old text-only caches and mixed-document parser upgrades. The submission test also checks grouped evidence and remapped source IDs through BDZIP export/import. The existing role-split, signed-evidence and browser scenarios remain required; none is skipped by this change.

Customer PDFs, images, extracted values and private measurement scripts were not committed or uploaded to GitHub/CI. Only synthetic fixtures, source code and this aggregate report belong in the repository. No external OCR request was made for the private development run.

Live OCR on photographed/scanned documents, other insurers' layouts, independent unseen samples, full extraction of unsupported signed-application grids, and physical two-computer deployment remain separate acceptance work. Re-extract old native-text-only attachments to obtain coordinates; their obsolete structured answers must not be trusted just because cached text exists. A successful parse does not authorize automatic insurer key-in or verify signatures.

# Layout parser verification - 2026-10-22

Status: development branch only; not production or deployment approval.

## Implementation

The Applied Auto/Home readers consume top-left PDF text coordinates and pair a value with its own label below it. Wrapped labels and blank cells are retained as layout constraints. Entity headings bound each vehicle, driver and property group, including multiple groups on one page. Excluded vehicles remain visible observations but cannot overwrite rated vehicle data. Coverage, declared operators, claims, convictions and lapses stay inside the appropriate source group.

CGI Ontario MVR recognition uses a template fingerprint, not a title alone. DMY report dates are explicit. Zero convictions require an unambiguous high-confidence zero count and no unresolved or contradictory detail rows. Missing and low-confidence histories are not clean histories.

DASH readers preserve historical policy and claim detail rows, including multiple reports on one page. First/third-party assignment requires the appropriate exact licence match against that report's header. Missing, masked, ambiguous and conflicting identity does not receive inferred fault. Different report perspectives are retained rather than silently combined or summed. Each claim retains its own report-subject identity during reconciliation.

Parser version 7 refreshes supported cached source sections. Typed source values preserve the original document, physical page, logical section, entity and bounding-box evidence. Withheld values remain visible as review items. Neither geometric extraction nor a high-confidence OCR result is a manual signature or underwriting approval.

The same review also fixed an existing Policy Change identity bug: two absent IDs must not count as a driver match. An invalid explicit ID cannot fall back to a different person's name.

## Local private-file verification

Private originals and expected values were kept outside the repository. They were not sent to CI or an external OCR service. The test used the exact locked PDF.js 5.4.624 package, the actual pdfLayoutPage conversion, the actual parsers, and the actual analyzePdfPackage / parseSections / buildAuditorWorksheet code. This was not a reimplementation of the parser regexes.

A selected manually verified field subset had these results:

| Source group | Checked values | Matching values | Matching page and box |
| --- | ---: | ---: | ---: |
| Applied Auto vehicle | 18 | 18 | 18 |
| Applied Auto driver | 17 | 17 | 17 |
| Applied Home property | 36 | 36 | 36 |
| MVR | 13 | 13 | 13 |
| Total selected subset | 84 | 84 | 84 |

Twelve additional private structural checks passed, covering retained DASH detail records, first/third-party identity, masked identifiers, exclusion isolation, empty values, and separated claim/lapse facts. These are targeted checks, not an overall accuracy estimate. They do not measure every key-in field, every insurer, or live OCR.

The private package harness used explicitly reviewed whole-source sections for four standalone known document types. It did not manually correct any extracted field values. Combined/signature packets used their actual automatic section decisions. All external OCR calls were disabled. Source-page links were checked in the resulting worksheets.

## Known limits

- Scanned or garbled-text pages still require configured OCR or manual review; they are not counted as successful native extraction.
- The tested unfamiliar signed Auto/Home application grids are not fully supported. They safely remain missing/review-required; Quote data does not verify a signed application's selections.
- No end-to-end real-client Windows installation, email transfer, cloud OCR, or production underwriting approval is claimed.
- Private samples are a development set, not an independent held-out generalization set. Broader insurer/layout coverage remains necessary.

## Repository regressions

All fixtures committed to GitHub are invented. Windows CI runs the full project TypeScript check, package/signature integrity, existing document regressions and browser role tests, plus:

```
node --experimental-transform-types tests/layout-parsers.mjs
node --experimental-transform-types tests/layout-boundary-safety.mjs
node --experimental-transform-types tests/auditor-role-split.mjs
node --experimental-transform-types tests/policy-change.ts
node --experimental-transform-types tests/stability-batch2a.ts
```

The boundary suite covers same-page multi-driver and multi-vehicle records, repeated loss/lapse/conviction rows, incomplete names, low-confidence and contradictory MVR zero counts, multiple DASH claims/policies/reports, unassigned identities, property-address mismatch, and missing Policy Change identifiers. Existing assertions and intake/signature gates are not bypassed.

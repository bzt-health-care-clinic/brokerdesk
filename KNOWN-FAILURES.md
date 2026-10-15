# Known failures — initial unverified development snapshot

This file records the four targeted regression failures observed in the sanitized copy. These are application/test-integrity findings, not privacy findings. No test was skipped, weakened, or edited to produce a passing result.

| Test | Expected → actual in sanitized copy | Original-project execution | Cause status and next investigation |
|---|---|---|---|
| `tests/phase2-regression.ts` (CASE-A) | First rule `OWNER_MISMATCH` → `SOURCE_CONFLICT` | NOT RUN: original test entry imports extensionless TypeScript modules that the available Node runner cannot resolve. | Suspected test expectation/order issue. Original CASE-A contains a conflicting registered-owner field source; `runRules` emits source conflicts before business-rule alerts. In a compatible environment, run the original test and verify both alerts and intended ordering. Preserve the conflict alert. |
| `tests/phase3-regression.ts` (P3-3) | `VALIDATED` → `MISSING_DOCUMENTS` | NOT RUN: original fixture imports a TypeScript interface as a runtime value and has extensionless imports; available runner cannot execute it. | Suspected fixture setup mismatch. The current rule requires non-empty `group_discount.activeEvidence.application` and `.diploma`; this fixture supplies cached application/diploma objects but no active-evidence references. Verify in the supported runner, then repair the fixture with valid synthetic evidence references if appropriate. Do not weaken the active-evidence rule. |
| `tests/ocr-space.ts` (ownership reconciliation) | registered owner `Delta Example` → empty string | REPRODUCED in the untouched original project in the previous validation attempt. | Cause remains suspected, not fully established. The test starts from a blank case with no vehicle; reconciliation associates ownership fields by a unique VIN/subject and the blank case has no matching vehicle. Follow up with (A) a pre-existing vehicle uniquely matched to the ownership VIN and (B) no vehicle. In B, preserve extracted owner/vehicle facts as reviewable or unassigned/proposed evidence; do not invent an association or equate owner with named insured. |
| `tests/stability-audit.ts` (document removal) | `field_sources.length` 0 → 2 | REPRODUCED in the untouched original project in the previous validation attempt. | Cause remains suspected, not fully established. The test expects total case field sources to become zero even though its remaining-record input is empty and source entries are not tied to removable evidence. Follow up by distinguishing active evidence from retained historical/manual records; do not blindly require a total count of zero. |

## Environment and execution limits

- Sanitized-copy executions of the four targeted checks observed all four failures; Phase 2 and Phase 3 stopped at their first failed assertion.
- Original Phase 2 and Phase 3 tests were NOT RUN successfully because of import/type-runner setup limitations. Do not describe those as confirmed original-project failures.
- TypeScript was BLOCKED in this restricted session: the sanitized copy does not contain dependencies, and type definitions could not be resolved from the available external dependency tree.
- `package.json` requires Node.js `>=22.13.0`; the manual GitHub Actions workflow selects Node.js 24 and runs `npm ci` using `package-lock.json` (lockfile version 3). A package-manager version is not pinned in `package.json`; the workflow uses the npm version bundled with its Node setup. A separate `pnpm-lock.yaml` and workspace file are also present, so the repository does not declare one exclusive package manager.
- Browser acceptance was NOT RUN. No dependency installation/startup, live OCR, paid service, Batch 2B, or Batch 3 was run.
- The hosted manual workflow must install the locked dependencies before running TypeScript or browser checks.

## Snapshot status

Private initial development snapshot only. Not verified for browser acceptance, production, or real policy work. Keep all four regression statuses visible until investigated in a supported clean environment.

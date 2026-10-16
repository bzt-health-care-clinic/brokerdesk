# BrokerDesk split submission: v1.0 intake acceptance addendum
**Source of requirements:** BrokerDesk 分体式提交流 Spec (v1.0, 2026-10-16), supplied by the user. This document is a *requirements baseline*, not a claim that each rule is implemented.

## Pilot rollout and authority
- Start with **one active Auditor** and **one or two pilot Brokers**. Reserve but disable Auditor 2. Later rollout may include five Brokers / two Auditors.
- Broker local intake -> zero-blocker package -> Broker manually attaches `.bdzip` to email -> Auditor downloads and imports -> authoritative Auditor-side rules -> independent new-business/remarket and policy-change queues -> manual carrier submission.
- Auditor 1 hosts the canonical SQLite database. A separate LAN-authenticated service with HTTPS is required **before** Auditor 2 can access a shared queue. Never expose the existing unauthenticated loopback API to LAN.
- Preserve local-first storage. Broker names/licenses/emails roster is deferred until rollout; initial pilot IDs are test-only.
- `{clientcode}-{yyyymmdd}-{company}-{business_type}.bdzip`; new business `auto`/`home`, policy change `PolicyChangeTransactionType.toLowerCase()`. Distinguish a same-name new revision using `package_id`, `source_case_id`, `revision`. Use manifest `system` for queue routing and warn if filename implies a different type; reject inconsistent manifest-vs-case data.
- Import always validates physical file SHA-256 and bytes, Broker ID, source document references and performs **fresh Auditor-rule evaluation**. Do not trust the package's `preflight.passed` status. Duplicate package should not create duplicate Case.

## BLOCKER (all applicable requirements must be satisfied before Broker package or Auditor acceptance)
1. New Auto: every rated vehicle must have an active, correctly matched Ownership document, uniquely tied to VIN and the vehicle. One ownership checklist tick cannot satisfy multiple vehicles.
2. Add Vehicle / Vehicle Substitution: the specific newly added/replacement vehicle must have its own active VIN-matched Ownership. Unchanged vehicles do not need fresh Ownership on this basis.
3. Manually verified signed evidence must link to a real active physical file and, if applicable, exact logical section, with matching SHA-256. New Business: signed application; Policy Change: transaction-specific client authorization.
4. All `required` checklist documents must actually be present, based on the active physical evidence, not a broker-editable received flag alone.
5. All unresolved HIGH findings from existing underwriting engines and intake-specific checks are blockers, including VIN/Ownership/named insured/co-insured/lessor conflicts; Economical/Definity group/CTSAC missing evidence or identity conflict; zero driver on new Auto. Note: current `COINSURED_REVIEW` is MEDIUM, so a *specific objectively established identity mismatch* needs its own intake BLOCKER without turning every medium into a blocker.
6. Economical/Definity group discount explicitly confirmed as selected or not selected, never `NOT_CONFIRMED`. No such intake gate for other carriers.
7. New Business: named insured(s) on **signed application must match quoted named insured(s)**, including number of named insureds. A single-applicant application vs joint-name quote blocks packaging. Source names must come from auditable active documents or a structured, evidence-linked manual comparison; absence of reliable names cannot silently pass.
8. Policy Change with joint named insureds: verify authorization from **both distinct policyholders**; can be two signatures on one document. Link signer identity and confirmation to the active document/page/section; text extraction showing the words "Signature" or "Yes No" is NOT a signature proof.
9. Selected OPCF 43: active Bill of Sale OR Lease Agreement evidence must be retained. Apply only when OPCF 43 is actually selected/requested as appropriate, not to every policy.
10. Requested/signed endorsements requiring client authorization (OPCF 28A, 49, 19, 13C): retain active signed endorsement/support document linked to the corresponding endorsement. Determine need by the actual selected endorsement/transaction, not an arbitrary mention in PDF text.
11. Cancellation: active signed written cancellation request is mandatory, and joint named policies require both distinct policyholders' signatures.
12. Claimed discount: evidence for each *actually selected* driver training, student, winter tires, anti-theft or retiree discount. Do not require evidence when the discount is not applied. Do not treat an unrelated document's filename as sufficient; bind active source to vehicle/driver/person where applicable.

## WARN (package allowed; show yellow flags in Auditor inbox)
- A vehicle **15 years or older** with selected physical damage coverage but without relevant vehicle photos or safety inspection evidence. Need effective-date/year and coverage to evaluate; missing structured data must not be guessed.
- Quote older than **30 days and not bound**, except **Max: 60 days**. Need reliable quote issuance date, planned bind date/current date, carrier and bind status. Do not assume a missing quote date means the quote is old.

Warnings are included in manifest `preflight.warnings` and *recomputed by the Auditor*; they do not block generation/import. They appear visibly on the corresponding inbox item.

## EXCLUDED from new intake checks (per user)
- Carrier eligibility/decline rules: driver experience, claims, demerit points, vehicle price/type. Do not add duplicate quote eligibility screening.
- UW referral pending, other Medium/Low findings as general intake gates.
- MVR received date as a stand-alone intake issue (if MVR actually present). Existing engine may emit `MVR_RECEIVED_DATE_MISSING` HIGH: intake must explicitly suppress this **specific** item, not silently weaken any unrelated HIGH finding.
- Landlord package, solid-fuel/oil-tank questionnaires, high-value appraisal, and live weather-event bind prohibition (no live data).

## Historical gap inventory (before v1.0 implementation; retained for traceability)
- **Implemented in Draft PR #3, pending Chromium acceptance:** local Broker/Auditor modes, versioned new-business/policy-change intake profiles, package ZIP+SHA256 export/import, full document bytes, single-Auditor inbox, dual channels, second Auditor disabled, atomic claim, initial signatures and per-VIN Ownership checks.
- **Not yet implemented**: #7 name-set comparison using application vs quote; #8 and #11 two separate signer attestations; #9 and #10 OPCF-specific supporting source/signature gates; #12 claimed-discount-to-proof mappings; both WARN rules and yellow queue display.
- Existing v0.3 profile may emit an MVR date HIGH, contrary to this spec. Targeted regression is required.
- Existing database's document-signature evidence ownership and intake identity fields must be modeled explicitly; raw OCR text must never auto-set signed or signed persons.
- The pilot Broker allowlist is a self-reported ID and is NOT PKI/nonrepudiation. Official broker roster deferred.

## Small-batch implementation order
**Batch 0 (this document):** baseline requirements and gap inventory only. No business rule is represented as complete.
**Batch 1:** fix explicitly excluded MVR-date gate; implement #7 application-vs-quote named-insured set gate and synthetic one-vs-two names tests, including missing/ambiguous evidence.
**Batch 2:** implement signer-person, active document, page, and hash-linked transaction authorization (#8, #11) with joint cancellation regression and invalidation on evidence edits.
**Batch 3:** link OPCF 43 Bill of Sale/Lease evidence and specified signed OPCF endorsements (#9, #10); synthetic false-positive and per-vehicle tests.
**Batch 4:** explicit discount selections and matched proof (#12), warning ages/quotes including Max 60-day exception and yellow Inbox UI.
**Batch 5:** independent Windows TypeScript/pilot E2E, signed integrity, A–E Chromium and package import/browser smoke at the same HEAD commit. Confirm backup + broker/Auditor manual workflow before real client pilot.
**Later separate security rollout:** authenticated LAN access and enable Auditor 2 only after explicit authorization and tests.

## Privacy and QA
Synthetic fixtures only in GitHub/CI. No real client files, IDs, signatures, policy numbers, void cheques, original quote PDFs, or local databases in source control or test artifacts.

## Implemented v1.0 evidence workflow (Draft PR #3)

The historical gaps above record the state **before** the implementation batches. The following is the implementation trace. **Do not interpret code completion or synthetic CI as real-client pilot authorization.**

| Rule | Broker/Auditor implementation |
| --- | --- |
| #1–#6 | Per-vehicle active VIN/Ownership source, actual required evidence, existing HIGH/selection gates, and source SHA-256 recheck |
| #7 | Broker-entered named-insured sets from signed Application and Quote, bound to the original active files/sections/hashes, compared to Case identity and count |
| #8 and #11 | Separate manually checked policyholder-signature attestations, signer identity, exact page/section and file SHA-256; Cancellation requires active written request |
| #9 | Only structurally selected OPCF 43 requires Bill of Sale or Lease Agreement; the evidence is linked to an explicit current vehicle |
| #10 | Structurally selected OPCF 28A, 49, 19 and 13C each require an active, manually verified signed OPCF/Policy Change section and signer/page |
| #12 | Broker reviews discounts actually applied (driver training, student, winter tires, anti-theft, retirement) and binds each selected claim to an active named driver/vehicle and proof. Unselected discounts need no document |
| WARN | For explicitly selected Physical Damage on a 15+ year vehicle, flag missing linked photo/inspection. For a reliably dated, unbound quote older than 30 days (Max 60), flag age. Both remain non-blocking |
| Routing and display | Broker .bdzip manifest contains preflight WARNs. Auditor independently recomputes all rules, stores its own warnings and displays them in yellow on the authoritative inbox. A misleading attachment filename is an advisory WARN; routing follows the verified Manifest/Case |

Manual confirmation creates an audited, server-owned evidence record; it is not a declaration that OCR found a signature. Confirmation references are validated again against the saved physical bytes, current logical section, page range, declared signer/subject and source SHA-256. Ordinary Case JSON saves cannot manufacture or replace these records. When a document is deleted/replaced/reclassified, invalid references are removed and the required document blocks intake again.

**Synthetic regression inventory:** TypeScript; tests/submission-pilot.mjs (export, import, original source bytes, manifest SHA-256, duplicate handling, filename/queue warning, original signature integrity); tests/intake-v1-support.mjs (unselected/selected OPCFs, wrong target, duplicate source across subjects, signed page, stale source, selected/unselected discounts and 5 proof types, date and Max boundaries, old-vehicle photo evidence, forged Case JSON); signed-server-integrity and existing document underwriting regressions; Windows A–E actual Chromium and Auditor inbox smoke.

### Required separate manual pilot sign-off (not fulfilled by synthetic CI)

- Confirm local backup/restore, canonical SQLite path and ability to reopen retained attachments before trial.
- Broker 1/2: create real test Cases, classify original quote/application/endorsement/discount evidence, verify names and signers, confirm calculated warnings, generate .bdzip only with zero blockers and attach manually to email.
- Auditor 1: download actual attached package, import, verify fresh-rule and SHA checks, correct New Business/Policy Change routing and warning visibility, duplicate handling, claim/release/complete, and manually submit to the insurer only after review.
- Confirm rejected packages create no authoritative Case or task, and document editing invalidates the correct attestations.
- Do not use a second Auditor or expose the loopback server to LAN without the separate authenticated HTTPS design. Formal Broker IDs and real pilot approvals remain outside this code batch.

All GitHub tests remain fully synthetic and must never store customer-identifying documents, source PDFs or local SQLite databases.

## Post-v1 review fixes: names, manual OCR hints, OPCF 43 assignment

- **Name comparison semantics:** Broker preflight and Node persistence both tokenize NFKC uppercase names, ignore punctuation/word order for comparison only, preserve original spelling, prohibit duplicate people and still enforce counts and token identity. A missing co_insured array on a legacy single-name Case is treated as empty; malformed non-arrays remain invalid.
- **OCR name suggestions:** When a Broker selects an active Application/Quote section, show parsed namedInsured/coInsured names for that exact file. Each suggestion has a **填入** button, which appends to the corresponding input and does not auto-approve or save evidence. Brokers can edit, and must still inspect the source PDF and manually confirm.
- **Policy-level OPCF 43 / multiple cars:** The Broker must explicitly save the specific receiving vehicle to a server-owned, VIN-bound field. Until then, no Bill of Sale/Lease evidence on any car can clear the OPCF 43 blocker. An A-car proof cannot satisfy the B-car assignment. Vehicle/VIN edits invalidate the target. A Policy Change endorsement carrying an explicit vehicle requires its exact vehicle as before.
- **Minor consistency:** Discount proof vehicle/driver keys are matched case-insensitively and canonicalized server-side. Quote-age warnings say **will be** when evaluated against a future planned bind date; the thresholds are unchanged.
- **Existing boundaries retained by design:** discount proof checks only explicitly selected claims and does not infer discounts from retirement or tire flags alone. Quote and old-car warnings use reliably recorded quote/physical-damage facts; unknown facts do not cause guessed yellow warnings.

Regression coverage: tests/intake-name-matching.mjs and tests/intake-v1-support.mjs, included in the Windows pilot submission workflow. The Draft PR is not authorization to use real client records before manual pilot sign-off.

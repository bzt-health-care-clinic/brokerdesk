# BrokerDesk v0.4 — Broker file intake vs Auditor key-in worksheet

Draft PR #3 only. This change does not approve a Windows rollout or enable LAN access.

## Role boundaries

**Broker mode** (npm run broker:local): identify the insured, insurer, case type, relevant policy/quote ID and effective date; record and confirm transaction type, named policyholders and rated/changed vehicle VINs; upload and classify original documents; check Ownership identity, correct active sections, client authorization signatures, selected endorsement/discount evidence and missing documents; export preflight-cleared .bdzip. Broker does **not** need to complete driver licensing, prior policy, coverage comparison, claims rating or payment key-in screens. The detailed QA review, Notes generator and Key-in summary are hidden in Broker mode. The file-only gate excludes downstream portal/rating findings such as premium discrepancies, missing driver records/MVR receipt dates and insurer portal coverage differences; it **does not** exclude SHA-256, VIN/Ownership, signed evidence, selected OPCF, discount proof, cross-file identity or document/source conflicts.

**Auditor mode** (npm run local): manually import the Broker attachment into the authoritative local queue, independently verify package SHA-256 and Broker intake rules, Take Case, and open the **Worksheet** tab. The worksheet is the default Auditor view. Original tabs remain available for correction, coverage/prior/driver/property editing, and QA. Do not mark the case complete until necessary portal/key-in fields are reviewed.

## Auditor Key-in worksheet

The worksheet uses the imported Case **and the active parsed source sections**, not arbitrary raw filename matches and not Broker preflight status. It displays individual fields in structured order with a status:

- SOURCE EXTRACTED — VERIFY: active source OCR/embedded text was recognized; review before key-in.
- CASE ENTRY — NO SOURCE: a value exists in Case but has no current linked source; review manually.
- NOT FOUND / CONFIRM: no usable value; never show fabricated "No" or empty claims history as confirmed.
- SOURCE CONFLICT: two sources or Case and active source disagree. Preserve original values.
- MANUALLY RESOLVED: an evidence-linked field has an explicit manual resolution.

Every available source displays file name, document type, logical section, page when extracted, confidence and a direct Open original file link. A filter shows Missing/Conflict/Unverified first; Search and Copy worksheet facilitate portal key-in.

**New Auto:** policy/quote, prior insurance, driver with MVR dates, rated vehicles with Ownership/VIN/use/km, claims, coverages/OPCF, discounts, payment last. **New Home:** policy/quote, prior property Insured Since/continuity, occupancy/structure/exterior, detailed risk attributes, mortgage/loss payee, coverages and payment. **Policy Change:** policy identity, effective date, transaction instructions, itemized prior vs new values, document-parsed old/new VIN, annual km, commute, address and coverages; changed vehicles/drivers; UW/backdate information; payment last. Home Policy Change is now available as a case creation type.

Values that cannot safely be assigned to a driver or vehicle remain visible in the Additional extracted document fields section, not silently attributed to the wrong person/car.

## Extraction policy

The Broker upload flow attempts embedded PDF text and optional configured OCR; parsed source metadata travels in the protected .bdzip. The Auditor's local document repository checks parser versions and reparses saved, reusable text with the v5 parser on load. The Auditor reconciles current active sources into Case before showing Worksheet.

This is **not** guaranteed OCR for every proprietary carrier PDF or scan. A scanned source without configured OCR, a rejected section, or ambiguous person/vehicle association is shown as Unparsed/Missing and must be manually inspected or rerun via Document panel. No cloud OCR is invoked merely by viewing a worksheet. The system does not auto-submit to insurer portals.

## Acceptance

- tests/auditor-role-split.mjs: source-driven Auto/Home/Policy Change worksheet, missing/conflict links, parsers and Broker vs Auditor completion checks.
- tests/pilot-browser.mjs: ZIP import, take/open case, Auditor worksheet appears with correct role, case and sources.
- tests/broker-role-browser.mjs: Broker mode hides Auditor worksheet/key-in controls; identity fields survive local autosave; Home Policy Change can be created.
- Existing A–E, package signature, VIN/Ownership, importer SHA-256, OPCF, discount and document regression suites must all remain green at the same HEAD.

Manual-pilot limits: use authorized test documents outside GitHub to check carrier-specific formats, per-VIN/per-driver association, permitted OCR provider/limits, imported Case reopen, backup/restore and one Broker→Auditor manual email transfer. The second Auditor, HTTPS/LAN and official Broker identities remain a separate rollout.

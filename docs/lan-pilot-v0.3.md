# BrokerDesk v0.3 local broker/auditor pilot

## Scope and activation
This branch is an **unreleased pilot**. Initial setup is **one Auditor computer**
and **one or two Broker computers**. The second Auditor is stored as a disabled
identity in SQLite; LAN remote access is NOT enabled by this branch.

Minimum Node.js: **24**. The previous standard BrokerDesk stays on 127.0.0.1.
This version does NOT turn the existing single-user HTTP API into a public/LAN
server. Never port-forward TCP/47831 or the frontend to other computers.

Each Broker installs their own copy on their own Windows PC:
`npm run broker:local`, then opens `http://127.0.0.1:5173`.
The Auditor launches `npm run local` on the designated authoritative Auditor
PC, then opens `http://127.0.0.1:5173/inbox`.

The selected working role is set at launch and does not alter case files. For
pilots, each PC must use its own local `BROKERDESK_DATA_DIR`. **Do not share a
SQLite file on an SMB/OneDrive/Dropbox/Google Drive folder.**

## Broker
1. Enter insurance details, original source files, and Manual Signed Application
   verification (new business) or transaction authorization (policy change).
2. Broker Preflight checks all reused High rules and selected v1-specific gates,
   including real per-vehicle Ownership/VIN, required evidence, signing,
   Economical/Definity group selection, and policy-change changed-vehicle
   ownership.
3. Specify Pilot Broker ID and name. Trial IDs: `PILOT-BROKER-1`,
   `PILOT-BROKER-2`. These are NOT production identities or licenses.
4. Generate Submission Package. This is a native, bounded ZIP with the
   `.bdzip` suffix and the agreed filename
   `clientcode-YYYYMMDD-company-business_type.bdzip`.
5. Attach the downloaded ZIP to an email **manually**; no auto-email or
   auto-insurer submission exists.

Package contains manifest.json, case.json, document-records.json and unchanged
original document bytes. The manifest records every SHA-256 and byte count,
the Broker identity, unique package UUID and revision, case type, submit time,
transaction types, signoff references, engine/profile version and preflight.

## Auditor
1. Download the original email attachment. At `/inbox`, choose Import BDZIP.
2. The local server verifies ZIP paths, size/entry counts, CRC, every SHA-256,
   source record IDs, case/manifest consistency and the Pilot Broker allowlist.
3. The Auditor's Node 24 engine **reruns the current shared intake logic**.
   Broker-provided preflight passed is not used as authority.
4. The Case is copied into the Auditor's local repository under a fresh Case ID.
   Physical/source section IDs are remapped and the signature authorization is
   verified again against the saved bytes.
5. Inbox tasks are separated by new-business (Remarket) and policy-change.
   A repeated package ID and identical manifest is identified as a duplicate;
   corrected/new revisions stay distinguishable.
6. AUDITOR-1 can Take Case, Release, or Mark Completed. Assignment uses an
   SQLite immediate transaction and 30-minute lease. Completing is a **manual**
   declaration; BrokerDesk never submits to the insurer.

The Auditor can configure alternative pilot Broker IDs through
`BROKERDESK_PILOT_BROKER_IDS` as a comma-separated list before launch.
The formal 5-Broker license/email roster is deferred until rollout; however,
an unknown pilot ID is rejected now.

## Deliberately NOT complete
- No second Auditor login is enabled yet.
- No LAN listener, HTTPS certificate, identity provider, Windows toast,
  Outlook auto-attachment, PKI signature, or shared live sync.
- Audit “signature verified” is a **manual attestation tied to evidence**, not
  cryptographic proof of client signature authenticity.
- SHA-256 detects damage/substitution relative to the manifest, not a dishonest
  Broker creating a new forged manifest.
- Ordinary email may cross the mail provider's cloud, notwithstanding the
  local-only BrokerDesk database. Follow the brokerage's permitted method for
  transferring identity, banking, MVR, and claim documents.
- Windows + Chromium automated A–E and synthetic v0.3 package regressions are
  required before the pilot can be approved for real client processing.

## Acceptance gates
- Missing signed evidence or any High rules prevents package generation.
- New Auto ownership is proved separately for each rated VIN.
- For add/substitution only the specific changed vehicle is checked, never all
  unrelated vehicles by default.
- Policy Change authorization is checked separately from Signed Application.
- Invalid path, duplicate ZIP entry, inflated archive, checksum mismatch or
  missing file: reject BEFORE creating the queue item.
- Unknown Broker ID: reject; package ID collision with new content: reject;
  identical package: duplicate response with no additional Case.
- New Business and Policy Change import into different queues.
- SQLite transaction controls task claim; AUDITOR-2 remains disabled.
- No original client document or workbook goes into GitHub/CI.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, ChevronDown, CircleAlert, Clipboard, FileCheck2, FileJson, FileWarning, FolderOpen, HardDrive, LoaderCircle, Plus, Search, Settings, ShieldCheck, Trash2, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { IngestionPanel } from "@/components/ingestion-panel";
import { UploadedDocumentRecord } from "@/lib/extraction-types";
import { Alert, DEFAULT_RULE_CONFIG, FieldSource, FieldSourceName, InsuranceCase, PolicyChangeItem, PolicyChangeTransactionType } from "@/lib/insurance-types";
import { createBlankAutoCase } from "@/lib/case-factories";
import { createBlankCaseForType, NewCaseType } from "@/lib/new-case";
import { assessClaims, type ClaimAssessment } from "@/lib/claim-assessment";
import { MvrReview } from "@/components/mvr-review";
import { confirmedDriverFromProposal, proposedDrivers, type ProposedDriver } from "@/lib/proposed-drivers";
import { deriveStatus, resolveField, runRules } from "@/lib/rule-engine";
import { reviewUploadedDocuments } from "@/lib/document-underwriting";
import { estimateBrokerFee } from "@/lib/monthly-payment";
import { reconcileDocumentsIntoCase, removeDocumentFromCase } from "@/lib/reconciliation";
import { getCanonicalInstitution, InstitutionRole } from "@/lib/institution-directory";
import { carrierRuleFor } from "@/lib/carrier-rules";
import { evaluateGroupDiscount, runPhase3Rules } from "@/lib/phase3-rules";
import { CaseSummary, localRepositories, StorageStats } from "@/lib/local-repositories";
import { validationHasStarted } from "@/lib/validation-workflow";
import { openDocumentPicker } from "@/lib/file-picker";
import { completionActionLabel, markCaseComplete, markCaseIncomplete } from "@/lib/case-completion";
import { applySignedEvidenceWithdrawn, applySignedUnverified, applySignedVerified, isLegacyChecklistSignedId, isSignedEvidenceStillValid } from "@/lib/signed-verification";
import { clampDocumentPanelWidth, DOCUMENT_PANEL_DEFAULT } from "@/lib/panel-width";
import { createDefaultPolicyChangeState, isPolicyChange, normalizePolicyChangeTransactions, POLICY_CHANGE_TRANSACTIONS, policyChangeCanComplete, transactionSummary } from "@/lib/policy-change";
import { confirmedNone, knownBoolean, mortgageDisplay, vehicleTenure } from "@/lib/fact-display";
import { nextCaseAfterRemoval } from "@/lib/case-selection";

const titleCase = (value: string) => value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
const money = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);
const same = (a: string | null, b: string | null) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

function KeyValue({ label, value, strong = false, source }: { label: string; value: React.ReactNode; strong?: boolean; source?: FieldSource }) {
  return <div className="key-row"><dt>{label}{source && <Sheet><SheetTrigger asChild><button className="source-link">Source</button></SheetTrigger><SheetContent><SheetHeader><SheetTitle>{label}</SheetTitle><SheetDescription>What each document actually said. Original values remain auditable.</SheetDescription></SheetHeader><div className="source-drawer"><div className="drawer-resolved"><span>Resolved</span><strong>{String(source.resolved_value ?? value ?? "Unresolved conflict")}</strong><small>{source.status === "resolved" ? `Resolved manually by ${source.resolved_by_user ?? "Local User"}` : titleCase(source.status)}</small></div>{source.values.map((entry) => <article key={`${entry.source}-${String(entry.value)}`}><p>{titleCase(entry.source)}</p><strong>{String(entry.value ?? "Missing")}</strong><div><span>Confidence {entry.confidence == null ? "—" : `${Math.round(entry.confidence * 100)}%`}</span>{entry.evidence?.[0]?.physicalFileName && <span>{entry.evidence[0].physicalFileName}</span>}{entry.evidence?.[0]?.page && <span>Page {entry.evidence[0].page}</span>}{entry.evidence?.[0]?.provider && <span>{titleCase(entry.evidence[0].provider)}</span>}{entry.documentId && <a href={localRepositories.documents.openUrl(entry.documentId)} target="_blank" rel="noreferrer">Open source</a>}</div>{entry.evidence?.[0]?.text && <blockquote>{entry.evidence[0].text}</blockquote>}</article>)}</div></SheetContent></Sheet>}</dt><dd className={strong ? "strong" : ""}>{value || "—"}</dd></div>;
}

const sourceField = (data: InsuranceCase, ...names: string[]) => data.field_sources.find((field) => names.includes(field.field));
const canonicalParty = (role: InstitutionRole, party: { name: string; address: string } | null | undefined) => party ? getCanonicalInstitution(role, party.name) ?? { name: party.name, address: party.address, alternateAddresses: [] } : null;

function Section({ title, eyebrow, children }: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return <section className="data-section">{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2>{children}</section>;
}

function SourceValues({ values }: { values: { source: string; value: unknown }[] }) {
  if (!values?.length) return null;
  return <div className="source-values">{values.map((item, index) => <div key={`${item.source}-${index}`}><span>{titleCase(item.source)}</span><strong>{typeof item.value === "object" ? JSON.stringify(item.value) : String(item.value ?? "Missing")}</strong></div>)}</div>;
}

export default function Home() {
  const [caseData, setCaseData] = useState<InsuranceCase>(() => createBlankAutoCase());
  const [jsonText, setJsonText] = useState(() => "");
  const [importError, setImportError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");
  const [noteType, setNoteType] = useState("portal");
  const [noteLimit, setNoteLimit] = useState(DEFAULT_RULE_CONFIG.portalNoteMaxCharacters);
  const [note, setNote] = useState("");
  const [caseNotes, setCaseNotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [search, setSearch] = useState("");
  const [ingestedDocuments, setIngestedDocuments] = useState<UploadedDocumentRecord[]>([]);
  const [savedCases, setSavedCases] = useState<CaseSummary[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [caseSearch, setCaseSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedNewCaseType, setSelectedNewCaseType] = useState<NewCaseType>("AUTO");
  const [creatingCase, setCreatingCase] = useState(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed" | "loading">("loading");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [storageMessage, setStorageMessage] = useState("");
  const readyRef = useRef(false);
  const loadingCaseRef = useRef(false);
  const skipNextAutosaveRef = useRef(false);
  const skipNextNoteAutosaveRef = useRef(false);
  const creatingCaseRef = useRef(false);
  const previousStatusRef = useRef(caseData.status);
  const documentUploadRef = useRef<HTMLInputElement>(null);
  const centerPanelRef = useRef<HTMLElement>(null);
  const [documentsPanelWidth, setDocumentsPanelWidth] = useState(DOCUMENT_PANEL_DEFAULT);
  const [signedDocChoice, setSignedDocChoice] = useState<string | undefined>(undefined);
  const [manualEvidenceField, setManualEvidenceField] = useState("");

  useEffect(() => { setDocumentsPanelWidth(clampDocumentPanelWidth(Number(window.localStorage.getItem("brokerdesk.documentsPanelWidth")) || DOCUMENT_PANEL_DEFAULT)); }, []);
  useEffect(() => { setSignedDocChoice(undefined); }, [selectedCaseId]);

  function beginDocumentsResize(event: React.PointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 1250) return;
    event.preventDefault();
    const startX = event.clientX; const startWidth = documentsPanelWidth; let finalWidth = startWidth;
    document.body.classList.add("resizing-documents-panel");
    const move = (moveEvent: PointerEvent) => { finalWidth = clampDocumentPanelWidth(startWidth + moveEvent.clientX - startX); setDocumentsPanelWidth(finalWidth); };
    const finish = () => { document.body.classList.remove("resizing-documents-panel"); document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", finish); window.localStorage.setItem("brokerdesk.documentsPanelWidth", String(finalWidth)); };
    document.addEventListener("pointermove", move); document.addEventListener("pointerup", finish, { once: true });
  }

  const claims = useMemo(() => assessClaims(caseData, DEFAULT_RULE_CONFIG), [caseData]);
  const groupReview = useMemo(() => evaluateGroupDiscount(caseData), [caseData]);
  const validationStarted = validationHasStarted(caseData);
  const documentRisk = useMemo(() => reviewUploadedDocuments(caseData, ingestedDocuments), [caseData, ingestedDocuments]);
  const alerts = useMemo(() => validationHasStarted(caseData) ? [...runRules(caseData, DEFAULT_RULE_CONFIG, claims), ...runPhase3Rules(caseData), ...documentRisk.alerts] : [], [caseData, claims, documentRisk]);
  const baseStatus = deriveStatus(caseData, alerts);
  const status = caseData.status === "keyed" || caseData.status === "incomplete" ? caseData.status : !validationStarted ? "new" : caseData.group_discount?.selected && groupReview.validation.status !== "VALIDATED" ? (groupReview.validation.status === "MISSING_DOCUMENTS" ? "missing_documents" : "needs_confirmation") : baseStatus;
  const manualDecisionCandidates = caseData.field_sources.filter((entry) => entry.values.length > 0);
  const activeManualEvidenceField = manualDecisionCandidates.some((entry) => entry.field === manualEvidenceField)
    ? manualEvidenceField : manualDecisionCandidates[0]?.field ?? "";
  const activeAlerts = alerts.filter((item) => !item.resolved);
  const critical = activeAlerts.filter((item) => item.severity === "high");
  const confirm = activeAlerts.filter((item) => item.severity !== "high");
  const isHab = Boolean(caseData.habitational_risk);
  const visibleDocs = caseData.documents.filter((doc) => doc.name.toLowerCase().includes(search.toLowerCase()));
  // "Signed application verified" must reference the actual uploaded PDF (or one of its
  // logical sections), not the document checklist: caseData.documents holds checklist
  // items with checklist ids, while ingestedDocuments holds the real uploaded files
  // with real document ids. Verified 2026-10-16.
  const signedEvidenceOptions = useMemo(() => {
    const options: { value: string; label: string; documentId: string; logicalDocumentId?: string; documentType: string; startPage?: number; endPage?: number }[] = [];
    for (const record of ingestedDocuments) {
      const isApplication = record.documentType === "AUTO_APPLICATION" || record.documentType === "HAB_APPLICATION";
      const withdrawn = record.withdrawnSectionRanges ?? [];
      const overlapsWithdrawn = (start?: number, end?: number) =>
        withdrawn.some((range) => (start ?? 1) <= range.endPage && (end ?? start ?? 1) >= range.startPage);
      const allSections = record.logicalDocuments ?? [];
      const sections = allSections.filter((section) =>
        (section.documentType === "AUTO_APPLICATION" || section.documentType === "HAB_APPLICATION") &&
        section.presenceStatus === "FOUND" &&
        !overlapsWithdrawn(section.startPage, section.endPage));
      if (sections.length > 0) {
        for (const section of sections) {
          options.push({
            value: `${record.id}:${section.id}`,
            label: `${record.fileName || record.originalFileName || record.id} — ${section.title}`,
            documentId: record.id,
            logicalDocumentId: section.id,
            documentType: section.documentType,
            startPage: section.startPage,
            endPage: section.endPage,
          });
        }
      } else if (isApplication && allSections.length === 0) {
        // File-level fallback only when the file was never segmented: if it was
        // re-segmented and no section qualifies anymore, offer nothing rather
        // than a stale whole-file option.
        options.push({ value: record.id, label: record.fileName || record.originalFileName || record.id, documentId: record.id, documentType: record.documentType });
      }
    }
    return options;
  }, [ingestedDocuments]);
  const signedEvidenceChoice = signedEvidenceOptions.find((option) => option.value === signedDocChoice) ?? signedEvidenceOptions[0];

  async function refreshCaseList(query = caseSearch, archived = showArchived) {
    const items = await localRepositories.cases.list(query, archived);
    setSavedCases(items);
    return items;
  }

  async function applyLoadedCase(selected: InsuranceCase, records: UploadedDocumentRecord[], notes: Record<string, string>) {
    skipNextAutosaveRef.current = true;
    skipNextNoteAutosaveRef.current = true;
    const staleRecords = records.filter((record) => record.staleExtraction);
    let hydrated = reconcileDocumentsIntoCase(selected, records);
    // v7: a signed confirmation whose evidence no longer resolves against the
    // uploaded files cannot stay trusted. This covers v5 legacy confirmations
    // (checklist ids, which can never match a real file) and evidence that
    // changed while the app was closed. Revoked once here: after revocation
    // signed=false, so it never re-triggers.
    let legacyEvidenceReason: string | undefined;
    if (hydrated.signed) {
      const validity = isSignedEvidenceStillValid(records, hydrated);
      if (!validity.valid) {
        legacyEvidenceReason =
          validity.reason === "file-missing" && isLegacyChecklistSignedId(hydrated)
            ? "legacy-checklist-id"
            : validity.reason;
        hydrated = applySignedUnverified(hydrated).next;
      }
    }
    if (staleRecords.length || JSON.stringify(hydrated) !== JSON.stringify(selected)) await localRepositories.cases.save(hydrated);
    if (legacyEvidenceReason) {
      await localRepositories.cases.recordAction(hydrated.case_id, "SIGNED_EVIDENCE_INVALID", {
        reason: legacyEvidenceReason,
        documentId: selected.signed_document_id ?? null,
        logicalDocumentId: selected.signed_logical_document_id ?? null,
      });
    }
    window.localStorage.setItem("brokerdesk.lastCaseId", hydrated.case_id);
    setCaseData(hydrated); setSelectedCaseId(hydrated.case_id); setJsonText(JSON.stringify(hydrated, null, 2)); setIngestedDocuments(records); setCaseNotes(notes); setNote(notes[noteType] ?? ""); setActiveTab(isPolicyChange(hydrated) ? "change" : "overview"); previousStatusRef.current = hydrated.status; readyRef.current = true; setSaveState("saved"); requestAnimationFrame(() => centerPanelRef.current?.scrollTo({ top: 0 }));
  }

  async function openSavedCase(id: string) {
    loadingCaseRef.current = true;
    skipNextAutosaveRef.current = true;
    skipNextNoteAutosaveRef.current = true;
    setSaveState("loading");
    try {
      const [selected, records, notes] = await Promise.all([localRepositories.cases.get(id), localRepositories.documents.list(id), localRepositories.notes.get(id)]);
      await applyLoadedCase(selected, records, notes);
    } finally { loadingCaseRef.current = false; }
  }

  useEffect(() => { void (async () => { try { loadingCaseRef.current = true; const snapshot = await localRepositories.bootstrap.load(window.localStorage.getItem("brokerdesk.lastCaseId")); setSavedCases(snapshot.cases); if (snapshot.selected) await applyLoadedCase(snapshot.selected, snapshot.documents, snapshot.notes); else { readyRef.current = false; setSelectedCaseId(null); setSaveState("saved"); } } catch { setSaveState("failed"); } finally { loadingCaseRef.current = false; } })(); }, []);

  useEffect(() => { if (!selectedCaseId || !readyRef.current) return; if (skipNextAutosaveRef.current) { skipNextAutosaveRef.current = false; return; } if (loadingCaseRef.current) return; setSaveState("saving"); const timer = window.setTimeout(async () => { try { const persisted = { ...caseData, status }; await localRepositories.cases.save(persisted); if (previousStatusRef.current !== status && status === "ready_to_key_in") await localRepositories.cases.recordAction(caseData.case_id, "MARK_READY"); previousStatusRef.current = status; await refreshCaseList(); setSaveState("saved"); } catch { setSaveState("failed"); } }, 700); return () => window.clearTimeout(timer); }, [caseData, status, selectedCaseId]);

  useEffect(() => { if (!selectedCaseId || !readyRef.current) return; if (skipNextNoteAutosaveRef.current) { skipNextNoteAutosaveRef.current = false; return; } if (loadingCaseRef.current) return; const timer = window.setTimeout(() => { void localRepositories.notes.save(caseData.case_id, noteType, note).then(() => setCaseNotes((current) => ({ ...current, [noteType]: note }))).catch(() => setSaveState("failed")); }, 700); return () => window.clearTimeout(timer); }, [note, noteType, caseData.case_id, selectedCaseId]);

  useEffect(() => { if (!readyRef.current) return; const timer = window.setTimeout(() => { void refreshCaseList(caseSearch, showArchived).catch(() => setSaveState("failed")); }, 200); return () => window.clearTimeout(timer); }, [caseSearch, showArchived]);

  function loadCase(id: string) {
    void openSavedCase(id);
  }

  async function newCase() {
    if (creatingCaseRef.current) return;
    creatingCaseRef.current = true; setCreatingCase(true);
    try {
      const created = await localRepositories.cases.create(createBlankCaseForType(selectedNewCaseType));
      await refreshCaseList("", false);
      await openSavedCase(created.case_id);
    } finally {
      creatingCaseRef.current = false; setCreatingCase(false);
    }
  }

  function importJson() {
    try {
      const parsed = JSON.parse(jsonText) as InsuranceCase;
      if (!parsed.case_id || !parsed.case_type || !parsed.policy || !Array.isArray(parsed.documents)) throw new Error("Case ID, case type, policy, and documents are required.");
      // v7: an imported case cannot carry a trusted signed confirmation — the
      // evidence chain cannot be verified at import time. Strip it and audit;
      // the broker re-verifies through the normal control afterwards.
      let imported = parsed;
      if (parsed.signed) {
        imported = applySignedUnverified(parsed).next;
        void localRepositories.cases.recordAction(imported.case_id, "IMPORT_SIGNED_CLEARED", {
          reason: "signed confirmations require re-verification after import",
        });
      }
      setCaseData(imported);
      setSelectedCaseId(imported.case_id); readyRef.current = true;
      setImportError("");
      setImportOpen(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Invalid JSON");
    }
  }

  function changeDocumentCategory(id: string, category: string) {
    setCaseData((current) => ({ ...current, documents: current.documents.map((doc) => doc.id === id ? { ...doc, category: category as typeof doc.category } : doc) }));
  }

  function resolveAlert(fieldName: string | undefined, sourceName?: FieldSourceName) {
    if (!fieldName) return;
    const field = caseData.field_sources.find((item) => item.field === fieldName);
    if (!field) return;
    let value = field.values.find((item) => item.source === sourceName)?.value;
    if (!sourceName) value = window.prompt("Enter the confirmed correct value:", String(field.resolved_value ?? ""));
    if (value === null || value === undefined || value === "") return;
    setCaseData((current) => resolveField(current, field.field, value, sourceName ? `Selected ${titleCase(sourceName)}` : "Local User-entered value", "Local User"));
    void localRepositories.cases.recordAction(caseData.case_id, "RESOLVE_CONFLICT", { field: field.field, source: sourceName ?? "manual", value });
  }

  function generateNote() {
    const vehicle = caseData.vehicles[0];
    const discrepancy = caseData.premium.portal_annual != null && caseData.premium.quoted_annual != null ? `Portal ${money(caseData.premium.portal_annual)} vs signed quote ${money(caseData.premium.quoted_annual)}.` : "";
    const options: Record<string, string> = {
      portal: caseData.policy_change ? `Hi U/W, as insured requested, ${caseData.policy_change.requested_action.toLowerCase()} for ${caseData.policy_change.vehicle_or_property}${caseData.policy_change.vin ? ` VIN ${caseData.policy_change.vin}` : ""} eff. ${caseData.policy.effective_date}: ${caseData.policy_change.add.join(", ")}.` : `Hi U/W, new business ${caseData.policy.quote_number}, eff. ${caseData.policy.effective_date}${vehicle ? `, ${vehicle.year} ${vehicle.make} ${vehicle.model} VIN ${vehicle.vin}` : ""}. Please review ${activeAlerts[0]?.message.toLowerCase() ?? "as submitted"}`,
      uw: `New business quote ${caseData.policy.quote_number}. ${discrepancy} ${critical[0]?.message ?? "Please review and advise."}`,
      audit: `Issue: ${activeAlerts[0]?.message ?? "No outstanding issue"} Action: broker review completed. Final state: ${titleCase(status)}.`,
      policy: caseData.policy_change ? `${caseData.policy_change.requested_action}. Add: ${caseData.policy_change.add.join(", ")}. Remove: ${caseData.policy_change.remove.join(", ") || "none"}. Keep: ${caseData.policy_change.keep.join(", ")}.` : "No policy change request is loaded.",
    };
    let text = options[noteType];
    if (noteType === "portal" && text.length > noteLimit) {
      const essential = `${caseData.policy.effective_date}${vehicle ? ` ${vehicle.year} ${vehicle.make} ${vehicle.model} VIN ${vehicle.vin}` : ""}: ${caseData.policy_change?.requested_action ?? activeAlerts[0]?.code ?? "review"}.`;
      text = essential.length <= noteLimit ? essential : `${essential.slice(0, Math.max(0, noteLimit - 1))}…`;
    }
    setNote(text);
  }

  async function copyNote() {
    await navigator.clipboard.writeText(note);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /**
   * Shared save-then-audit flow for signed-verification state changes
   * (verify / unverify / evidence withdrawn). The case is saved first and the
   * audit event is written only after the save succeeds. If the audit write
   * fails, the DB write is rolled back on a best-effort basis so the page and
   * the database cannot silently diverge; the broker always gets an explicit
   * message about what happened.
   */
  // One server transaction persists the signature state and its audit event.
  // Ordinary autosaves cannot change signed fields.
  async function saveCaseThenAudit(
    next: InsuranceCase,
    previous: InsuranceCase,
    action: string,
    details: Record<string, unknown>,
  ): Promise<boolean> {
    setSaveState("saving");
    try {
      const persisted = await localRepositories.cases.signedTransition(next, action, details);
      setCaseData(persisted);
      previousStatusRef.current = persisted.status;
      await refreshCaseList().catch(() => undefined);
      setSaveState("saved");
      return true;
    } catch (error) {
      // The server rejects the transaction atomically. Never guess its state
      // from an optimistic checkbox; reload its authoritative record.
      try {
        const actual = await localRepositories.cases.get(next.case_id);
        setCaseData(actual);
        previousStatusRef.current = actual.status;
      } catch { setCaseData(previous); }
      setSaveState("failed");
      window.alert(error instanceof Error ? error.message : "Signature verification failed. Please retry.");
      return false;
    }
  }

  async function updateIngestedDocuments(records: UploadedDocumentRecord[]) {
    setIngestedDocuments(records);
    const removedIds = ingestedDocuments.filter((record) => !records.some((candidate) => candidate.id === record.id)).map((record) => record.id);
    let next = caseData;
    for (const removedId of removedIds) next = removeDocumentFromCase(next, removedId, records);
    next = reconcileDocumentsIntoCase(next, records);
    // If the uploaded file backing a signed confirmation was deleted, the
    // confirmation is no longer trustworthy: clear it (and drop a keyed case back
    // to incomplete) and audit the change. Persisted immediately, not via autosave.
    const withdrawal = applySignedEvidenceWithdrawn(next, removedIds);
    next = withdrawal.next;
    let revoked = withdrawal.withdrawn;
    let revokeReason: string | undefined = withdrawal.withdrawn ? "file-deleted" : undefined;
    let statusChanged = withdrawal.statusChanged;
    // v7: a physical-file deletion is not the only way evidence dies. If a
    // section was re-classified, its pages changed, or it was withdrawn inside
    // the same PDF, the file id is unchanged but the confirmation must still go.
    if (next.signed && !revoked) {
      const validity = isSignedEvidenceStillValid(records, next);
      if (!validity.valid) {
        const revokedChange = applySignedUnverified(next);
        next = revokedChange.next;
        statusChanged = revokedChange.statusChanged;
        revoked = true;
        revokeReason = validity.reason;
      }
    }
    setCaseData(next);
    if (!revoked) return;
    const previous = caseData;
    await saveCaseThenAudit(next, previous, "SIGNED_EVIDENCE_WITHDRAWN", {
      documentId: previous.signed_document_id ?? null,
      logicalDocumentId: previous.signed_logical_document_id ?? null,
      reason: revokeReason,
      ...(statusChanged ? { statusChanged } : {}),
    });
  }

  function confirmProposedDriver(proposal: ProposedDriver) {
    if (!window.confirm(`Confirm ${proposal.name} (${proposal.licenceNumber}) as a driver in this case? This does not set named insured, principal use, or a vehicle.`)) return;
    setCaseData(current => {
      const available = proposedDrivers(ingestedDocuments, current.drivers).some(candidate => candidate.documentId === proposal.documentId && candidate.logicalDocumentId === proposal.logicalDocumentId && candidate.licenceNumber === proposal.licenceNumber);
      if (!available) return current;
      return reconcileDocumentsIntoCase({ ...current, drivers: [...current.drivers, confirmedDriverFromProposal(proposal)] }, ingestedDocuments);
    });
    void localRepositories.cases.recordAction(caseData.case_id, "DRIVER_CONFIRMED_FROM_MVR", { documentId: proposal.documentId, logicalDocumentId: proposal.logicalDocumentId });
  }

  function setGroupSelected(selected: boolean) {
    setCaseData((current) => ({ ...current, group_discount: { ...current.group_discount, selected, selectionConfirmed: true, association: "CTSAC", status: selected ? "MISSING_DOCUMENTS" : "NOT_SELECTED" } }));
  }

  function confirmMembership() {
    const reason = window.prompt("Record the confirmation source / reason:", "Membership confirmation received by broker");
    if (!reason) return;
    setCaseData((current) => ({ ...current, group_discount: { ...current.group_discount!, membershipDecision: undefined, ctsac_application: { ...current.group_discount?.ctsac_application, internal_status: "approved" }, status: "NEEDS_REVIEW" }, broker_overrides: [...(current.broker_overrides ?? []), { alert_code: "CTSAC_STATUS_UNCONFIRMED", reason, confirmed_by: "Local User", confirmed_at: new Date().toISOString() }] }));
    void localRepositories.cases.recordAction(caseData.case_id, "OVERRIDE_BLOCKER", { alertCode: "CTSAC_STATUS_UNCONFIRMED", reason });
  }

  function overrideAlert(alertCode: Alert["code"]) {
    const reason = window.prompt("Override reason (required and audit logged):", "");
    if (!reason?.trim()) return;
    const confirmed = window.confirm("Confirm this broker override. The alert, reason, user, and timestamp will remain in the audit trail.");
    if (!confirmed) return;
    setCaseData((current) => ({
      ...current,
      alerts: current.alerts.map((alert) => alert.code === alertCode ? { ...alert, resolved: true, resolution: `Broker override: ${reason.trim()}` } : alert),
      broker_overrides: [...(current.broker_overrides ?? []), { alert_code: alertCode, reason: reason.trim(), confirmed_by: "Local User", confirmed_at: new Date().toISOString(), evidence_fingerprint: documentRisk.fingerprints[alertCode] }],
    }));
    void localRepositories.cases.recordAction(caseData.case_id, "OVERRIDE_BLOCKER", { alertCode, reason: reason.trim() });
  }

  async function renameCase() { const label = window.prompt("Case name:", caseData.label); if (!label?.trim()) return; const renamed = await localRepositories.cases.rename(caseData.case_id, label.trim()); setCaseData(renamed); await refreshCaseList(); }
  function clearSelectedCase() { readyRef.current = false; window.localStorage.removeItem("brokerdesk.lastCaseId"); setSelectedCaseId(null); setIngestedDocuments([]); setCaseNotes({}); setNote(""); setActiveTab("overview"); }
  async function archiveCase() { if (!window.confirm(`Archive ${caseData.label}?`)) return; const id = caseData.case_id; clearSelectedCase(); await localRepositories.cases.archive(id); const items = await refreshCaseList("", false); const next = nextCaseAfterRemoval(items); if (next) await openSavedCase(next); else setSaveState("saved"); }
  async function deleteCase() { if (!window.confirm(`Permanently delete ${caseData.label} and all locally stored documents? This cannot be undone.`)) return; const id = caseData.case_id; clearSelectedCase(); await localRepositories.cases.delete(id); const items = await refreshCaseList("", false); const next = nextCaseAfterRemoval(items); if (next) await openSavedCase(next); else setSaveState("saved"); }
  async function persistCompletionState(next: InsuranceCase, action: "MARK_COMPLETE" | "MARK_INCOMPLETE") {
    const previous = caseData;
    setCaseData(next); setSaveState("saving");
    try {
      await localRepositories.cases.save(next);
      await localRepositories.cases.recordAction(next.case_id, action, { previousStatus: previous.status, newStatus: next.status });
      previousStatusRef.current = next.status;
      await refreshCaseList();
      setSaveState("saved");
    } catch {
      setCaseData(previous); setSaveState("failed");
    }
  }
  // "Signed application verified" is a manual broker action only. Verified 2026-10-16:
  // nothing in reconciliation, OCR or document ingestion ever sets signed=true
  // on its own — the broker ticks the box after visually verifying the signed
  // document. JSON import actively strips any signed confirmation (v7) since the
  // evidence chain cannot be verified at import time. State transitions live in
  // lib/signed-verification.ts (pure and unit-tested). Persistence and audit are
  // sequential with best-effort compensation: the case is saved first and the
  // audit event is written only after the save succeeds; if the audit write
  // fails, the DB change is rolled back when possible and the broker is told
  // exactly what happened instead of a silent divergence.
  async function toggleSignedVerified(verified: boolean) {
    const previous = caseData;
    if (verified) {
      // Evidence is mandatory: without a real uploaded file/section there is
      // nothing to verify against. The checkbox is disabled when there are no
      // options, but guard anyway.
      if (!signedEvidenceChoice) {
        window.alert("Upload a signed application file first, then verify it.");
        return;
      }
      const verifiedAt = new Date().toISOString();
      const result = applySignedVerified(
        caseData,
        {
          documentId: signedEvidenceChoice.documentId,
          logicalDocumentId: signedEvidenceChoice.logicalDocumentId,
          documentType: signedEvidenceChoice.documentType,
          startPage: signedEvidenceChoice.startPage,
          endPage: signedEvidenceChoice.endPage,
        },
        verifiedAt,
      );
      if (!result.ok) {
        window.alert("Select the signed application file first, then verify it.");
        return;
      }
      const next = result.next;
      await saveCaseThenAudit(next, previous, "SIGNED_VERIFIED", {
        documentId: next.signed_document_id ?? null,
        logicalDocumentId: next.signed_logical_document_id ?? null,
        verifiedAt,
      });
      return;
    }
    const { next, statusChanged } = applySignedUnverified(caseData);
    const ok = await saveCaseThenAudit(next, previous, "SIGNED_UNVERIFIED", statusChanged ? { statusChanged } : {});
    if (ok) setSignedDocChoice(undefined);
  }
  async function markComplete() {
    if (isPolicyChange(caseData) && !policyChangeCanComplete(caseData)) { window.alert("This policy change still has a blocker or pending underwriting approval."); return; }
    if (!isPolicyChange(caseData)) {
      // New business has no policyChangeCanComplete gate. deriveStatus treats an
      // unsigned application and a pending UW referral as blockers outside the alert
      // system, so the gate must check them independently: a clean High alert list
      // alone is not enough to mark KEYED. Each check gets its own message.
      if (!caseData.signed) { window.alert("Application is not signed. Confirm signing before marking complete."); return; }
      if (caseData.uw_referral_pending) { window.alert("Underwriting referral is still pending. Wait for the UW decision before marking complete."); return; }
      // A carrier group discount whose selection was never confirmed is only a medium
      // alert, but completing with an undecided discount would mis-state the premium.
      // evaluateGroupDiscount returns NOT_CONFIRMED only when the carrier has a group
      // discount rule, so no extra carrier check is needed. NOT_APPLICABLE and
      // NOT_SELECTED do not block.
      if (groupReview.validation.status === "NOT_CONFIRMED") { window.alert("Group discount selection is not confirmed. Confirm whether the group discount is selected before marking complete."); return; }
      // Block on the same complete rule set the QA panel shows (runRules + runPhase3Rules),
      // computed unconditionally so the gate holds even before "Start key-in" was pressed.
      // This covers phase-3 highs such as missing drivers, missing MVR received dates and CTSAC issues.
      // Medium EVIDENCE_REVIEW alerts must not block, or the normal review workflow would deadlock.
      const blockers = [...runRules(caseData, DEFAULT_RULE_CONFIG, claims), ...runPhase3Rules(caseData), ...documentRisk.alerts].filter((item) => !item.resolved && item.severity === "high");
      const pendingReview = ingestedDocuments.some((record) => record.state === "NEEDS_REVIEW");
      if (blockers.length > 0 || pendingReview) { window.alert("There are unresolved high-severity issues or documents awaiting review. Resolve them before marking complete."); return; }
    }
    await persistCompletionState(markCaseComplete(caseData), "MARK_COMPLETE");
  }
  async function markIncomplete() { await persistCompletionState(markCaseIncomplete(caseData), "MARK_INCOMPLETE"); }
  function beginValidation() { if (validationStarted) return; setCaseData((current) => ({ ...current, validationStatus: "IN_PROGRESS" })); void localRepositories.cases.recordAction(caseData.case_id, "START_VALIDATION"); }
  function updatePolicyChange(next: InsuranceCase, action: string, details: Record<string, unknown> = {}) { setCaseData(next); void localRepositories.cases.recordAction(next.case_id, action, details); }
  async function openStorageSettings() { setSettingsOpen(true); setStorageMessage(""); try { setStorageStats(await localRepositories.storage.stats()); } catch { setStorageMessage("Local storage service is unavailable."); } }

  const hasDriverReview = caseData.drivers.length > 0 || proposedDrivers(ingestedDocuments, caseData.drivers).length > 0;
  const tabs = isPolicyChange(caseData) ? ["change", ...(hasDriverReview ? ["driver"] : []), ...(caseData.vehicles.length ? ["vehicle"] : []), "coverage", "payment"] : ["overview", ...(hasDriverReview ? ["driver"] : []), ...(caseData.vehicles.length ? ["vehicle"] : []), "prior", "claims", "coverage", ...(isHab ? ["property"] : []), "payment"];
  const newCaseTypeSelector = <div className="type-toggle" aria-label="New case type">
    <button className={selectedNewCaseType === "AUTO" ? "active" : ""} aria-pressed={selectedNewCaseType === "AUTO"} onClick={() => setSelectedNewCaseType("AUTO")}>New Auto</button>
    <button className={selectedNewCaseType === "HAB" ? "active" : ""} aria-pressed={selectedNewCaseType === "HAB"} onClick={() => setSelectedNewCaseType("HAB")}>New HAB</button>
    <button className={selectedNewCaseType === "POLICY_CHANGE" ? "active" : ""} aria-pressed={selectedNewCaseType === "POLICY_CHANGE"} onClick={() => setSelectedNewCaseType("POLICY_CHANGE")}>Policy Change</button>
  </div>;

  if (!selectedCaseId && saveState === "loading") return <main className="app-shell empty-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><ShieldCheck /></div><div><p>BrokerDesk</p><span>Key-in & Audit Assistant</span></div></div></header><section className="empty-landing loading-landing" role="status" aria-live="polite"><LoaderCircle className="loading-spinner" /><p className="eyebrow">Local workspace</p><h1>Opening BrokerDesk</h1><p>Loading your last case and saved documents…</p></section></main>;
  if (!selectedCaseId) return <main className="app-shell empty-shell"><header className="topbar"><div className="brand"><div className="brand-mark"><ShieldCheck /></div><div><p>BrokerDesk</p><span>Key-in & Audit Assistant</span></div></div></header><section className="empty-landing"><ShieldCheck /><p className="eyebrow">Local single-user workspace</p><h1>No case selected</h1><p>Select a case type, then create a case when you are ready. Nothing is created automatically.</p>{newCaseTypeSelector}<Button onClick={() => void newCase()} disabled={creatingCase} aria-busy={creatingCase}><Plus /> {creatingCase ? "Creating…" : "New case"}</Button></section></main>;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><ShieldCheck /></div><div><p>BrokerDesk</p><span>Key-in & Audit Assistant</span></div></div>
        <div className="case-switcher">
          <Select value={caseData.case_id} onValueChange={loadCase}><SelectTrigger className="case-select"><SelectValue placeholder="Open a saved case" /></SelectTrigger><SelectContent>{!savedCases.some((item) => item.id === caseData.case_id) && <SelectItem value={caseData.case_id}>{caseData.label}</SelectItem>}{savedCases.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select>
          <span className={`status status-${status}`}>{titleCase(status)}</span>
          <span className={`save-state save-${saveState}`} role="status" aria-live="polite">{titleCase(saveState)}</span>
        </div>
        <div className="header-actions">
          <Dialog open={importOpen} onOpenChange={setImportOpen}>
            <DialogTrigger asChild><Button variant="outline" className="import-button" aria-label="Import case JSON" title="Import case JSON"><FileJson /> Import JSON</Button></DialogTrigger>
            <DialogContent className="max-w-3xl"><DialogHeader><DialogTitle>Import mock case JSON</DialogTitle><DialogDescription>Paste a normalized case object. Original source values remain visible after conflict resolution.</DialogDescription></DialogHeader><Textarea className="json-editor" value={jsonText} onChange={(event) => setJsonText(event.target.value)} />{importError && <p className="form-error">{importError}</p>}<DialogFooter><Button variant="outline" onClick={() => setImportOpen(false)}>Cancel</Button><Button onClick={importJson}>Run validation</Button></DialogFooter></DialogContent>
          </Dialog>
          <Button variant="outline" onClick={() => void openStorageSettings()} aria-label="Open local storage settings" title="Storage settings"><Settings /> Storage</Button>
          <Button onClick={() => void newCase()} disabled={creatingCase} aria-busy={creatingCase} aria-label="Create a new case" title="Create new case"><Plus /> {creatingCase ? "Creating…" : "New case"}</Button>
        </div>
      </header>

      <div className="priority-strip"><div><span className="live-dot" /> {validationStarted ? "Validation live" : "Validation not started"}</div><p>{!validationStarted ? "Upload documents or start key-in to begin validation." : critical.length ? <><strong>{critical.length} critical</strong> issue{critical.length > 1 ? "s" : ""} must be cleared before key-in.</> : <><strong>No critical issues.</strong> Review confirmations before key-in.</>}</p>{newCaseTypeSelector}</div>

      <div className="workspace-grid" style={{ "--documents-panel-width": `${documentsPanelWidth}px` } as React.CSSProperties}>
        <aside className="documents-panel panel">
          <div className="panel-heading"><div><p className="eyebrow">Source package</p><h1>Documents</h1></div><Button variant="outline" size="icon-sm" title="Upload documents" aria-label="Upload documents" onClick={() => openDocumentPicker(documentUploadRef.current)}><Upload /></Button></div>
          <div className="local-case-list"><div className="search-box"><Search /><input aria-label="Search saved cases" value={caseSearch} onChange={(event) => setCaseSearch(event.target.value)} placeholder="Search saved cases" /></div><label><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>{savedCases.map((item) => <button key={item.id} aria-current={item.id === caseData.case_id ? "page" : undefined} className={item.id === caseData.case_id ? "active" : ""} onClick={() => void openSavedCase(item.id)}><strong>{item.label}</strong><span>{item.insuredName || "Unnamed client"} · {titleCase(item.status)}</span></button>)}{savedCases.length === 0 && <p className="compact-empty">No matching cases.</p>}</div>
          <div className="search-box"><Search /><input aria-label="Search documents" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a document" /></div>
          <div className="document-list">{visibleDocs.map((doc) => <div className="document-item" key={doc.id}><div className={`doc-icon ${doc.conflict ? "conflict" : doc.received ? "found" : doc.required ? "missing" : "optional"}`}>{doc.conflict ? <FileWarning /> : doc.received ? <FileCheck2 /> : doc.required ? <XCircle /> : <FileCheck2 />}</div><div className="doc-copy"><strong>{doc.name}</strong><span>{doc.conflict ? "Conflict" : doc.received ? "Found" : doc.required ? "Missing" : "Optional"}</span></div><Select value={doc.category} onValueChange={(value) => changeDocumentCategory(doc.id, value)}><SelectTrigger size="sm" className="category-trigger" aria-label={`Change ${doc.name} category`}><ChevronDown /></SelectTrigger><SelectContent>{["signed_application", "quote", "ownership", "bill_of_sale", "vehicle_photo", "diploma", "payment_authorization", "cancellation_request", "mvr", "dash", "previous_policy", "lease_agreement", "mortgage_document", "void_cheque", "supporting_document"].map((category) => <SelectItem key={category} value={category}>{titleCase(category)}</SelectItem>)}</SelectContent></Select></div>)}{visibleDocs.length === 0 && <p className="compact-empty">No matching checklist documents.</p>}</div>
          <IngestionPanel subjects={[...caseData.drivers.filter(d => d.id).map(d => ({ id: d.id!, type: "DRIVER", label: `${d.name} · ${d.licence_number || d.id}` })), ...caseData.vehicles.filter(v => v.id).map(v => ({ id: v.id!, type: "VEHICLE", label: `${v.year} ${v.make} ${v.model} · ${v.vin || v.id}` }))]} caseId={caseData.case_id} insuredName={caseData.insured.name === "New client" ? undefined : caseData.insured.name} records={ingestedDocuments} repository={localRepositories.documents} inputRef={documentUploadRef} onChange={updateIngestedDocuments} onAudit={(action, documentId) => void localRepositories.cases.recordAction(caseData.case_id, action, {}, documentId)} />
          <div className="screenshot-zone"><span>Portal screenshot source</span><strong>Upload and classify ready</strong><p>Image OCR remains behind the extraction-provider contract.</p></div>
        </aside>

        <div className="documents-resizer" role="separator" aria-label="Resize Documents panel" aria-orientation="vertical" tabIndex={0} onPointerDown={beginDocumentsResize} onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const next = clampDocumentPanelWidth(documentsPanelWidth + (event.key === "ArrowRight" ? 20 : -20)); setDocumentsPanelWidth(next); window.localStorage.setItem("brokerdesk.documentsPanelWidth", String(next)); }} />

        <section ref={centerPanelRef} className="keyin-panel panel">
          {carrierRuleFor(caseData.policy.company)?.groupDiscountFirst && <GroupDiscountCard validation={groupReview.validation} onSelect={setGroupSelected} onConfirmMembership={confirmMembership} />}
          <div className="case-title"><div><p className="eyebrow">{caseData.case_id} · {titleCase(caseData.case_type)}</p><h1>{caseData.insured.name || "Unnamed client"}</h1><p>{caseData.policy.company || "Carrier not entered"} · Eff. {caseData.policy.effective_date || "not entered"} · Quote {caseData.policy.quote_number || "not entered"}</p></div><div className="case-title-actions"><Button size="sm" variant="outline" onClick={() => void renameCase()}>Rename</Button><Button size="sm" variant="outline" onClick={() => void archiveCase()}><Archive /> Archive</Button><Button size="sm" variant="outline" className="delete-case" onClick={() => void deleteCase()}><Trash2 /> Delete</Button>{!isPolicyChange(caseData) && <div className="signed-verify"><label><input type="checkbox" checked={Boolean(caseData.signed)} disabled={!caseData.signed && signedEvidenceOptions.length === 0} onChange={(event) => void toggleSignedVerified(event.target.checked)} /> Signed application verified</label>{!caseData.signed && signedEvidenceChoice && <><Select value={signedEvidenceChoice.value} onValueChange={setSignedDocChoice}><SelectTrigger size="sm" aria-label="Signed application document"><SelectValue /></SelectTrigger><SelectContent>{signedEvidenceOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><a href={localRepositories.documents.openUrl(signedEvidenceChoice.documentId)} target="_blank" rel="noreferrer">Open source</a></>}{!caseData.signed && signedEvidenceOptions.length === 0 && <small>Upload a signed application file first.</small>}<small>Confirm only after you have verified the signed application document.</small></div>}<Button size="sm" variant="outline" onClick={() => void (status === "keyed" ? markIncomplete() : markComplete())}>{completionActionLabel(status)}</Button><StartKeyIn data={caseData} assessment={claims} alerts={activeAlerts} onStart={beginValidation} /><div className="case-score"><span>{alerts.filter((item) => item.resolved).length}</span><small>resolved</small></div></div></div>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="case-tabs"><TabsList variant="line" className="tab-strip">{tabs.map((tab) => <TabsTrigger key={tab} value={tab}>{tab === "prior" ? "Prior Insurance" : titleCase(tab)}</TabsTrigger>)}</TabsList><div className="tab-body"><TabsContent value="overview"><Overview data={caseData} isHab={isHab} /></TabsContent><TabsContent value="driver"><DriverView data={caseData} proposals={proposedDrivers(ingestedDocuments, caseData.drivers)} onConfirm={confirmProposedDriver} /></TabsContent><TabsContent value="vehicle"><VehicleView data={caseData} /></TabsContent><TabsContent value="prior"><PriorView data={caseData} /></TabsContent><TabsContent value="claims"><ClaimsView assessment={claims} /></TabsContent><TabsContent value="coverage"><CoverageView data={caseData} /></TabsContent><TabsContent value="property"><PropertyView data={caseData} /></TabsContent>{isPolicyChange(caseData) && <TabsContent value="change"><PolicyChangeView key={caseData.case_id} data={caseData} onChange={updatePolicyChange} /></TabsContent>}<TabsContent value="payment"><PaymentView data={caseData} /></TabsContent></div></Tabs>
          {isPolicyChange(caseData) && <NameChangeSection data={caseData} onChange={updatePolicyChange} />}
        </section>

        <aside className="review-panel panel">
          <div className="panel-heading"><div><p className="eyebrow">Rule engine</p><h1>QA review</h1></div><div className="alert-total" aria-label={`${activeAlerts.length} active review items`}>{activeAlerts.length}</div></div>
          {!validationStarted ? <div className="validation-not-started"><ShieldCheck /><strong>Validation not started</strong><p>Upload documents or start key-in to begin validation.</p></div> : <><ReviewGroup title="Critical issues" count={critical.length} tone="critical">{critical.length ? critical.map((item, index) => <AlertCard key={`${item.id}-${index}`} alert={item} data={caseData} onResolve={resolveAlert} onOverride={overrideAlert} />) : <EmptyReview label="No critical issues" />}</ReviewGroup><ReviewGroup title="Missing / confirm" count={confirm.length} tone="confirm">{confirm.length ? confirm.map((item, index) => <AlertCard key={`${item.id}-${index}`} alert={item} data={caseData} onResolve={resolveAlert} onOverride={overrideAlert} />) : <EmptyReview label="Nothing awaiting confirmation" />}</ReviewGroup></>}
          {validationStarted && manualDecisionCandidates.length > 0 && <div className="manual-evidence-decision">
            <strong>Broker-confirmed evidence decision</strong>
            <p>Review the original sources, select a field and enter the confirmed value. The decision is retained for evidence review after source withdrawal.</p>
            <label>Evidence field to confirm
              <select value={activeManualEvidenceField} onChange={(event) => setManualEvidenceField(event.target.value)}>
                {manualDecisionCandidates.map((field) => <option key={field.field} value={field.field}>{titleCase(field.field)} ({field.values.length} source{field.values.length === 1 ? "" : "s"})</option>)}
              </select>
            </label>
            <Button size="sm" variant="outline" onClick={() => resolveAlert(activeManualEvidenceField)}>Enter correct value</Button>
          </div>}
          <div className="notes-card"><div className="notes-heading"><div><p className="eyebrow">Broker-ready</p><h2>Notes generator</h2></div><Select value={noteType} onValueChange={(value) => { setCaseNotes((current) => ({ ...current, [noteType]: note })); setNoteType(value); setNote(caseNotes[value] ?? ""); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="portal">Portal note</SelectItem><SelectItem value="uw">UW note</SelectItem><SelectItem value="audit">Audit reply</SelectItem><SelectItem value="policy">Policy change</SelectItem></SelectContent></Select></div>{noteType === "portal" && <label className="limit-control">Character limit <input type="number" min="80" max="1000" value={noteLimit} onChange={(event) => setNoteLimit(Number(event.target.value))} /></label>}<Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Generate a concise note from this case." /><div className={`character-count ${note.length > noteLimit && noteType === "portal" ? "over" : ""}`}>Characters: {note.length} / {noteType === "portal" ? noteLimit : "—"}</div><div className="note-actions"><Button variant="outline" onClick={generateNote}>Generate</Button><Button onClick={copyNote} disabled={!note}><Clipboard /> {copied ? "Copied" : "Copy"}</Button></div></div>
        </aside>
      </div>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent><DialogHeader><DialogTitle>Local storage</DialogTitle><DialogDescription>BrokerDesk keeps its database and source files on this Windows computer.</DialogDescription></DialogHeader>{storageStats ? <div className="storage-settings"><dl><KeyValue label="Data location" value={storageStats.dataLocation} /><KeyValue label="Database" value={storageStats.database} /><KeyValue label="Documents" value={`${storageStats.documentCount} files · ${(storageStats.documentBytes / 1024 / 1024).toFixed(1)} MB`} /><KeyValue label="Cases" value={storageStats.caseCount} /><KeyValue label="Last backup" value={storageStats.lastBackupAt ?? "Never"} /></dl><div className="storage-actions"><Button variant="outline" onClick={() => void localRepositories.storage.openFolder()}><FolderOpen /> Open folder</Button><Button variant="outline" onClick={() => void navigator.clipboard.writeText(storageStats.dataLocation)}><Clipboard /> Copy path</Button><Button onClick={async () => { const result = await localRepositories.storage.exportBackup(); setStorageMessage(`Backup created: ${result.path}`); setStorageStats(await localRepositories.storage.stats()); }}><HardDrive /> Export backup</Button><Button variant="outline" onClick={async () => { const result = await localRepositories.storage.cleanTemp(); setStorageMessage(`Removed ${result.removed} temporary item(s).`); }}><Trash2 /> Clean temp</Button></div></div> : <p>Loading local storage…</p>}{storageMessage && <p className="storage-message">{storageMessage}</p>}<DialogFooter><Button variant="outline" onClick={() => setSettingsOpen(false)}>Close</Button></DialogFooter></DialogContent></Dialog>
    </main>
  );
}

function GroupDiscountCard({ validation, onSelect, onConfirmMembership }: { validation: NonNullable<InsuranceCase["group_discount"]>; onSelect: (selected: boolean) => void; onConfirmMembership: () => void }) {
  const app = validation.ctsac_application;
  const diploma = validation.diploma;
  const item = (label: string, value: string, tone: "good" | "bad" | "warn" = "good") => <div><span>{label}</span><strong className={`group-${tone}`}>{value}</strong></div>;
  return <section className={`group-card validation-${validation.status.toLowerCase()}`}><div className="group-card-head"><div><p className="eyebrow">Carrier requirement · first</p><h2>GROUP DISCOUNT: {validation.selectionConfirmed ? validation.selected ? "YES" : "NO" : "NOT CONFIRMED"}</h2></div><div className="type-toggle"><button className={validation.selectionConfirmed && validation.selected ? "active" : ""} onClick={() => onSelect(true)}>Yes</button><button className={validation.selectionConfirmed && !validation.selected ? "active" : ""} onClick={() => onSelect(false)}>No</button></div></div>{validation.selected && <><div className="group-grid">{item("Association", validation.association ?? "CTSAC")}{item("CTSAC application", app ? "Found" : "Missing", app ? "good" : "bad")}{item("Degree / diploma", diploma ? "Found" : "Missing", diploma ? "good" : "bad")}{item("Applicant match", validation.identity_status ? titleCase(validation.identity_status) : "Not checked", validation.identity_status === "MATCH" ? "good" : validation.identity_status === "CONFLICT" ? "bad" : "warn")}{item("Application complete", app?.applicant_signature && app.application_date ? "Check passed" : "Needs review", app?.applicant_signature && app.application_date ? "good" : "bad")}{item("Membership status", titleCase(app?.internal_status ?? "not_confirmed"), app?.internal_status === "approved" ? "good" : app?.internal_status === "declined" ? "bad" : "warn")}</div><div className="group-validation"><span>Validation</span><strong>{titleCase(validation.status)}</strong>{app && (!app.internal_status || app.internal_status === "not_confirmed") && <Button size="sm" variant="outline" onClick={onConfirmMembership}>Confirm membership</Button>}</div></>}</section>;
}

function StartKeyIn({ data, alerts, onStart, assessment }: { assessment: ClaimAssessment; data: InsuranceCase; alerts: ReturnType<typeof runRules>; onStart: () => void }) {
  return <Sheet><SheetTrigger asChild><Button size="sm" className="start-keyin" onClick={onStart}>Start key-in</Button></SheetTrigger><SheetContent className="keyin-sheet"><SheetHeader><SheetTitle>Complete key-in summary</SheetTitle><SheetDescription>Wrong, missing, and blocking items first. Payment is last.</SheetDescription></SheetHeader><CompleteSummary data={data} alerts={alerts} assessment={assessment} /></SheetContent></Sheet>;
}

function SummaryBlock({ title, children }: { title: string; children: React.ReactNode }) { return <section className="summary-block"><h3>{title}</h3><dl>{children}</dl></section>; }
function SummaryItem({ label, value }: { label: string; value: React.ReactNode }) { return <div><dt>{label}</dt><dd>{value === null || value === undefined || value === "" ? "NOT CONFIRMED" : value}</dd></div>; }

function CompleteSummary({ data, alerts, assessment: rating }: { assessment: ClaimAssessment; data: InsuranceCase; alerts: ReturnType<typeof runRules> }) {
  const isAuto = data.case_type === "new_auto" || data.case_type === "auto_policy_change";
  const group = evaluateGroupDiscount(data).validation;
  const mortgagees = data.mortgage?.mortgagees.map((item) => canonicalParty("mortgagee", item)!);
  return <div className="complete-summary">
    {carrierRuleFor(data.policy.company)?.groupDiscountFirst && <div className={`summary-group validation-${group.status.toLowerCase()}`}><strong>GROUP DISCOUNT: {group.selectionConfirmed ? group.selected ? "YES" : "NO" : "NOT CONFIRMED"}</strong><span>Validation: {titleCase(group.status)}</span></div>}
    <section className="blocking-first"><h3>Wrong / missing / blocking</h3>{alerts.length ? <ul>{alerts.map((item, index) => <li key={`${item.id}-${index}`}><strong>{item.severity.toUpperCase()}</strong> {item.message}</li>)}</ul> : <p>No unresolved blockers.</p>}</section>
    {isAuto ? <>
      <SummaryBlock title="1 · Policy / quote"><SummaryItem label="Carrier" value={data.policy.company} /><SummaryItem label="Named insured" value={data.insured.name} /><SummaryItem label="Co-insured" value={data.insured.co_insured.map((item) => item.name).join(", ")} /><SummaryItem label="Client code" value={data.policy.client_code} /><SummaryItem label="Auto quote / submission #" value={data.policy.auto_quote_number ?? data.policy.quote_number} /><SummaryItem label="Effective date" value={data.policy.effective_date} /><SummaryItem label="Expiry date" value={data.policy.expiry_date} /><SummaryItem label="Binder #" value={data.policy.binder_number} /><SummaryItem label="Mailing address" value={data.policy.mailing_address ?? data.ownership?.address} /><SummaryItem label="Risk / garaging address" value={data.policy.risk_address ?? data.vehicles[0]?.garaging_address} /></SummaryBlock>
      <SummaryBlock title="2 · Prior insurance"><SummaryItem label="Previous carrier" value={data.prior_insurance.insurer} /><SummaryItem label="Previous policy #" value={data.prior_insurance.policy_number} /><SummaryItem label="Prior effective" value={data.prior_insurance.effective_date} /><SummaryItem label="Prior expiry" value={data.prior_insurance.expiry_date} /><SummaryItem label="Auto insured since" value={data.prior_insurance.insured_since} /><SummaryItem label="Date with company" value={data.prior_insurance.date_with_company} /><SummaryItem label="Continuous insurance" value={data.prior_insurance.continuous_insurance} /><SummaryItem label="Years prior insurance" value={data.prior_insurance.years_prior_insurance} /><SummaryItem label="Claims assessed at" value={rating.assessmentDate ?? "UNDETERMINED — effective date missing/invalid"} /><SummaryItem label="Claims" value={data.claims.length ? `${rating.ratingPeriod.length} within ${rating.years}-year period / ${rating.historical.length} historical / ${rating.undetermined.length} undetermined` : confirmedNone(data, "claims")} /><SummaryItem label="Known first-party at-fault records (not deduplicated)" value={data.claims.length ? data.claims.filter((claim) => claim.source_active !== false && claim.party_role === "FIRST_PARTY" && Boolean(claim.driver_id) && claim.at_fault_percent != null && claim.at_fault_percent > 0).length : confirmedNone(data, "claims")} /><SummaryItem label="Previous vehicle / use" value={[data.prior_insurance.previous_vehicle, data.prior_insurance.previous_use].filter(Boolean).join(" · ")} /></SummaryBlock>
      <SummaryBlock title="3 · Driver + vehicle">{data.drivers.map((driver) => <SummaryItem key={driver.name} label={`Driver — ${driver.name}`} value={`${driver.licence_province ?? "—"} ${driver.licence_class} · Exp ${driver.licence_expiry ?? "—"} · G1 ${driver.g1_date} · G2 ${driver.g2_date} · G ${driver.g_date} · MVR requested ${driver.mvr_requested ?? "—"} / received ${driver.mvr_received || "—"} · ${driver.principal ? "Principal" : "Occasional"} ${driver.percentage_use}% · Telematics ${driver.telematics.enabled ? `Yes, ${driver.telematics.app}, ${driver.telematics.phone || "phone unconfirmed"}, ${driver.telematics.email || "email unconfirmed"}, ${driver.telematics.discount_percent}%` : "No"}`} />)}{data.vehicles.map((vehicle) => { const lessor = canonicalParty("lessor", vehicle.lessor); const lienholder = canonicalParty("lienholder", vehicle.lienholder); return <SummaryItem key={vehicle.vin} label={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} value={`VIN ${vehicle.vin} · Owner ${vehicle.ownership?.registered_owner || "NOT CONFIRMED"} · ${vehicleTenure(data, vehicle)} · Purchase ${vehicle.purchase_date ?? "—"}, ${vehicle.purchase_condition ?? "—"}, ${money(vehicle.purchase_price)} · List new ${money(vehicle.list_price_new)} · ${vehicle.primary_use}, ${vehicle.annual_km} km, commute ${vehicle.commute_km} km, business ${vehicle.business_use_percent}% · Lessor ${lessor ? `${lessor.name}, ${lessor.address}` : "NOT CONFIRMED"} · Lienholder ${lienholder ? `${lienholder.name}, ${lienholder.address}` : "NOT CONFIRMED"}`} />; })}</SummaryBlock>
      <SummaryBlock title="4 · Coverage / endorsements">{data.coverage.comparison.map((row) => <SummaryItem key={row.name} label={row.name} value={row.application ?? row.portal} />)}</SummaryBlock>
      <SummaryBlock title="5 · Discounts"><SummaryItem label="Group discount" value={group.selected ? `${group.association ?? "CTSAC"} · ${titleCase(group.status)}` : "No"} /><SummaryItem label="Telematics" value={data.drivers.some((driver) => driver.telematics.enabled) ? "Yes" : "No"} /><SummaryItem label="Winter tires" value={data.vehicles.some((vehicle) => vehicle.winter_tires) ? "Yes" : "No"} /></SummaryBlock>
      <SummaryBlock title="6 · Notes / alerts"><SummaryItem label="Alerts" value={alerts.map((item) => item.message).join(" · ") || "NOT CONFIRMED"} /></SummaryBlock>
      <SummaryBlock title="7 · Payment"><SummaryItem label="Payment mode" value={data.payment.plan} /><SummaryItem label="Annual premium" value={money(data.payment.annual_premium)} /><SummaryItem label="Monthly amount" value={money(data.payment.monthly_amount)} /><SummaryItem label="Fees" value={money(data.payment.fees)} /><SummaryItem label="Total" value={money(data.payment.total_cost)} /></SummaryBlock>
    </> : <>
      <SummaryBlock title="Policy / quote"><SummaryItem label="Carrier" value={data.policy.company} /><SummaryItem label="Named insured" value={data.insured.name} /><SummaryItem label="Co-insured" value={data.insured.co_insured.map((item) => item.name).join(", ")} /><SummaryItem label="DOB / gender" value={`${data.insured.dob ?? "—"} / ${data.insured.gender ?? "—"}`} /><SummaryItem label="Client code" value={data.policy.client_code} /><SummaryItem label="Home quote / submission #" value={data.policy.hab_quote_number ?? data.policy.quote_number} /><SummaryItem label="Effective date" value={data.policy.effective_date} /><SummaryItem label="Risk address" value={data.habitational_risk?.risk_address} /></SummaryBlock>
      <SummaryBlock title="Prior insurance"><SummaryItem label="Previous carrier" value={data.prior_insurance.insurer} /><SummaryItem label="Previous policy #" value={data.prior_insurance.policy_number} /><SummaryItem label="Prior effective" value={data.prior_insurance.effective_date} /><SummaryItem label="Prior expiry" value={data.prior_insurance.expiry_date} /><SummaryItem label="Years prior insurance" value={data.prior_insurance.years_prior_insurance} /><SummaryItem label="Property insured since" value={data.prior_insurance.insured_since} /></SummaryBlock>
      <SummaryBlock title="Property"><SummaryItem label="Policy type / occupancy" value={`${data.habitational_risk?.policy_type ?? "—"} · ${data.habitational_risk?.occupancy ?? "—"}`} /><SummaryItem label="Occupied since" value={data.habitational_risk?.occupied_since} /><SummaryItem label="Structure / construction / exterior" value={`${data.habitational_risk?.structure ?? "—"} · ${data.habitational_risk?.construction ?? "—"} · ${data.habitational_risk?.exterior_finish ?? "—"}`} /><SummaryItem label="Families / units" value={`${data.habitational_risk?.families ?? "—"} / ${data.habitational_risk?.units ?? "—"}`} /><SummaryItem label="Smoke-free / pool / dog" value={`${knownBoolean(data.habitational_risk?.smoke_free)} / ${knownBoolean(data.habitational_risk?.swimming_pool)} / ${data.habitational_risk?.dog_animal_exposure ?? "NOT CONFIRMED"}`} /><SummaryItem label="Business / vacancy / rental / Airbnb" value={`${data.habitational_risk?.business_use ?? "NOT CONFIRMED"} / ${knownBoolean(data.habitational_risk?.vacant)} / ${knownBoolean(data.habitational_risk?.rental)} / ${knownBoolean(data.habitational_risk?.airbnb)}`} /></SummaryBlock>
      <SummaryBlock title="Mortgage / loss payee"><SummaryItem label="Mortgagee" value={mortgagees?.map((item) => item.name).join(", ")} /><SummaryItem label="Address" value={mortgagees?.map((item) => item.address).join("; ")} /><SummaryItem label="Nature of interest" value={data.mortgage?.nature_of_interest ?? (mortgagees?.length ? "Mortgagee" : mortgageDisplay(data))} /><SummaryItem label="Loss payee" value={data.mortgage?.loss_payees?.map((item) => item.name).join(", ")} /></SummaryBlock>
      <SummaryBlock title="Coverage">{data.coverage.comparison.map((row) => <SummaryItem key={row.name} label={row.name} value={row.application ?? row.portal} />)}</SummaryBlock>
      <SummaryBlock title="Payment"><SummaryItem label="Payment mode" value={data.payment.plan} /><SummaryItem label="Premium" value={money(data.payment.annual_premium)} /><SummaryItem label="Tax" value={money(data.payment.tax)} /><SummaryItem label="Fees" value={money(data.payment.fees)} /><SummaryItem label="Total" value={money(data.payment.total_cost)} /></SummaryBlock>
    </>}
  </div>;
}

function Overview({ data, isHab }: { data: InsuranceCase; isHab: boolean }) { const ownership = data.vehicles.find((vehicle) => vehicle.ownership?.received)?.ownership ?? data.ownership; return <div className="content-stack"><Section title="Policy overview" eyebrow="Key-in order"><dl className="key-grid"><KeyValue label="Insurance company" value={data.policy.company} strong source={sourceField(data, "insurer")} /><KeyValue label="Insured" value={data.insured.name} source={sourceField(data, "namedInsured")} /><KeyValue label="Co-insured" value={data.insured.co_insured.map((item) => item.name).join(", ") || "NOT CONFIRMED"} source={sourceField(data, "coInsured", "co_insured")} /><KeyValue label="Client code" value={data.policy.client_code} /><KeyValue label="Quote / Submission #" value={data.policy.quote_number} source={sourceField(data, "quoteNumber")} /><KeyValue label="Effective date" value={data.policy.effective_date} source={sourceField(data, "effectiveDate")} /><KeyValue label="Binder #" value={data.policy.binder_number} /></dl></Section>{ownership && <Section title="Ownership source" eyebrow={ownership.received ? "Found · extracted fields" : "Awaiting source"}><dl className="key-grid"><KeyValue label="Registered owner" value={ownership.registered_owner} source={sourceField(data, "registeredOwner")} /><KeyValue label="Address" value={ownership.address} source={sourceField(data, "ownerAddress")} /><KeyValue label="VIN" value={ownership.vin} strong source={sourceField(data, "vin")} /><KeyValue label="Year" value={ownership.year} source={sourceField(data, "year")} /><KeyValue label="Make" value={ownership.make} source={sourceField(data, "make")} /><KeyValue label="Model" value={ownership.model} source={sourceField(data, "model")} /><KeyValue label="Plate" value={ownership.plate} source={sourceField(data, "plate")} /><KeyValue label="Lessor" value={ownership.lessor?.name} source={sourceField(data, "lessor")} /></dl></Section>}{isHab && <Section title="Risk"><dl className="key-grid"><KeyValue label="Policy type" value={data.habitational_risk?.policy_type} source={sourceField(data, "policyType")} /><KeyValue label="Risk address" value={data.habitational_risk?.risk_address} source={sourceField(data, "riskAddress")} /><KeyValue label="Mortgagee" value={data.mortgage?.mortgagees.map((item) => item.name).join(", ")} source={sourceField(data, "mortgagee")} /><KeyValue label="Smoke-free" value={knownBoolean(data.habitational_risk?.smoke_free)} /></dl></Section>}<div className="payment-last-note"><CheckCircle2 /> Payment is intentionally kept last in the broker summary.</div></div>; }

function DriverView({ data, proposals, onConfirm }: { data: InsuranceCase; proposals: ProposedDriver[]; onConfirm: (proposal: ProposedDriver) => void }) {
  return <div className="content-stack">
    {proposals.length > 0 && <Section title="Unassigned MVR subjects" eyebrow="Broker confirmation required">{proposals.map(proposal => <div key={`${proposal.documentId}-${proposal.logicalDocumentId ?? "file"}`} className="telematics-block"><p>{proposal.name} · Licence {proposal.licenceNumber} · MVR evidence only. Not automatically named insured, principal driver or assigned a vehicle.</p><Button size="sm" onClick={() => onConfirm(proposal)}>Confirm driver {proposal.name}</Button></div>)}</Section>}
    {data.drivers.map((driver) => <Section key={driver.id ?? driver.licence_number} title={driver.name} eyebrow={driver.principal ? "Principal driver" : "Occasional driver"}><dl className="key-grid"><KeyValue label="DOB" value={driver.dob} /><KeyValue label="Gender" value={driver.gender} /><KeyValue label="Marital status" value={driver.marital_status} /><KeyValue label="DL #" value={driver.licence_number} /><KeyValue label="Licence province" value={driver.licence_province} /><KeyValue label="Licence class" value={driver.licence_class} /><KeyValue label="Licence expiry" value={driver.licence_expiry} /><KeyValue label="Licence conditions" value={driver.licence_conditions || "NOT CONFIRMED"} /><KeyValue label="Licence status" value={driver.licence_status} /><KeyValue label="G1 date" value={driver.g1_date} /><KeyValue label="G2 date" value={driver.g2_date} /><KeyValue label="G date" value={driver.g_date} /><KeyValue label="MVR requested" value={driver.mvr_requested} /><KeyValue label="MVR received" value={driver.mvr_received} /><KeyValue label="Assigned vehicle" value={driver.assigned_vehicle} /><KeyValue label="Driver training" value={driver.driver_training ? "Yes" : "No"} /><KeyValue label="Percentage use" value={`${driver.percentage_use}%`} /><KeyValue label="Retired" value={driver.retired ? "Yes" : "No"} /><KeyValue label="Convictions" value={driver.convictions.map((item) => `${item.description} · ${item.conviction_date}`).join(", ") || "NOT CONFIRMED"} /><KeyValue label="Demerit points" value={driver.demerit_points} /></dl><MvrReview driver={driver} fields={data.field_sources} /><div className="telematics-block"><h3>Telematics · inside driver record</h3><dl className="key-grid"><KeyValue label="Selected" value={driver.telematics.enabled ? "Yes" : "No"} /><KeyValue label="App" value={driver.telematics.app} /><KeyValue label="Registered phone" value={driver.telematics.phone || "Not confirmed"} /><KeyValue label="Registered email" value={driver.telematics.email || "Not confirmed"} /><KeyValue label="Discount" value={`${driver.telematics.discount_percent}%`} /></dl></div></Section>)}
  </div>;
}

function VehicleView({ data }: { data: InsuranceCase }) { const vehicle = data.vehicles[0]; if (!vehicle) return null; const lessor = canonicalParty("lessor", vehicle.lessor); const lienholder = canonicalParty("lienholder", vehicle.lienholder); return <Section title={`${vehicle.year} ${vehicle.make} ${vehicle.model}`} eyebrow="Vehicle"><dl className="key-grid"><KeyValue label="VIN" value={vehicle.vin} strong source={sourceField(data, "vin")} /><KeyValue label="Owned / leased / financed" value={vehicleTenure(data, vehicle)} /><KeyValue label="Purchase condition" value={vehicle.purchase_condition} /><KeyValue label="Purchase date" value={vehicle.purchase_date} /><KeyValue label="Purchase price" value={money(vehicle.purchase_price)} /><KeyValue label="List price new" value={money(vehicle.list_price_new)} /><KeyValue label="Primary use" value={vehicle.primary_use} source={sourceField(data, "vehicleUse")} /><KeyValue label="Annual KM" value={vehicle.annual_km?.toLocaleString()} source={sourceField(data, "annualKm")} /><KeyValue label="Commute KM" value={vehicle.commute_km} source={sourceField(data, "commuteKm")} /><KeyValue label="Business use" value={`${vehicle.business_use_percent}%`} /><KeyValue label="Garaging" value={vehicle.garaging_address} /><KeyValue label="Parking at night" value={vehicle.parking} /><KeyValue label="Winter tires" value={vehicle.winter_tires ? "Yes" : "No"} /></dl><div className="party-grid"><div className="telematics-block"><h3>Lessor · reference address</h3><p>{lessor ? <><strong>{lessor.name}</strong><br />{lessor.address}</> : <strong>NOT CONFIRMED</strong>}</p></div><div className="telematics-block"><h3>Lienholder · reference address</h3><p>{lienholder ? <><strong>{lienholder.name}</strong><br />{lienholder.address}</> : <strong>NOT CONFIRMED</strong>}</p></div></div></Section>; }

function PriorView({ data }: { data: InsuranceCase }) { const prior = data.prior_insurance; return <Section title="Prior insurance" eyebrow="Grouped for key-in"><dl className="key-grid"><KeyValue label={data.habitational_risk ? "Previous property insurer" : "Previous insurer"} value={prior.insurer} strong source={sourceField(data, "priorInsurer", "prior_insurer")} /><KeyValue label="Previous policy #" value={prior.policy_number} source={sourceField(data, "priorPolicyNumber")} /><KeyValue label="Prior effective" value={prior.effective_date} source={sourceField(data, "priorEffective")} /><KeyValue label="Prior expiry" value={prior.expiry_date} source={sourceField(data, "priorExpiry", "prior_expiry")} /><KeyValue label="Years prior insurance" value={prior.years_prior_insurance == null ? "Confirm" : `${prior.years_prior_insurance} years`} /><KeyValue label={data.habitational_risk ? "Property insured since" : "Auto insured since"} value={prior.insured_since} source={sourceField(data, "propertyInsuredSince", "property_insured_since")} /></dl></Section>; }

function ClaimsView({ assessment }: { assessment: ClaimAssessment }) {
  return <div className="content-stack"><p>Assessment date: <strong>{assessment.assessmentDate ?? "UNDETERMINED — intended effective date missing or invalid"}</strong> · Configured lookback: {assessment.years} years</p>
    <ClaimsTable title="Rating period claims" claims={assessment.ratingPeriod} periodLabel={`Within configured ${assessment.years}-year period`} />
    <ClaimsTable title="Historical claims" claims={assessment.historical} periodLabel="Retained outside configured period" />
    <ClaimsTable title="Undetermined / withdrawn evidence" claims={assessment.undetermined} periodLabel="Period cannot be established, or supporting evidence was withdrawn" />
  </div>;
}
function ClaimsTable({ title, claims, periodLabel }: { title: string; claims: InsuranceCase["claims"]; periodLabel: string }) {
  return <Section title={title} eyebrow={periodLabel}>{!claims.length && <p>No records in this view; this is not a confirmed clean history.</p>}<div className="table-scroll"><table><thead><tr><th>Loss / claim / report</th><th>Driver / party / vehicle</th><th>Coverage / status</th><th>Loss / expense</th><th>Reported fault</th><th>Source / review</th><th>Portal</th></tr></thead><tbody>{claims.map(claim => <tr key={claim.id}>
    <td>{claim.loss_date || "UNKNOWN"}<small>Claim: {claim.claim_number || "UNKNOWN"} · Report: {claim.report_id || "UNKNOWN"}</small></td>
    <td>{claim.driver || "UNKNOWN"}<small>{claim.party_role ?? "UNKNOWN"} · {claim.association_status ?? "Association not recorded"}</small><small>{claim.vehicle || claim.vehicle_vin || "Vehicle UNKNOWN"}</small></td>
    <td>{claim.coverage || "UNKNOWN"}<small>{claim.status || "Status UNKNOWN"}</small></td>
    <td>{money(claim.loss_amount)}<small>Expense: {money(claim.expense)}</small></td>
    <td>{claim.at_fault_percent == null ? "UNKNOWN" : `${claim.at_fault_percent}%`}<small>Applies to reported party only</small></td>
    <td>{claim.source ? <details><summary>PDF / report evidence</summary><p>{claim.source.documentId} · Section {claim.source.logicalDocumentId ?? "whole file"}</p><p>PDF pages: {claim.source.evidence.map(e => e.page ?? "unknown").join(", ")}</p><pre>{JSON.stringify(claim.source.original, null, 2)}</pre></details> : "Broker / legacy record"}{claim.source_active === false && <p>Support withdrawn — manual facts retained</p>}{Boolean(claim.possible_duplicate_ids?.length) && <p>Possible duplicate records — not merged or summed</p>}</td>
    <td>{claim.portal_present === false ? "Missing" : claim.portal_present === true ? "Matched" : "NOT CONFIRMED"}</td>
  </tr>)}</tbody></table></div></Section>;
}

function CoverageView({ data }: { data: InsuranceCase }) { return <Section title="Coverage comparison" eyebrow="Signed selections remain visible"><div className="table-scroll"><table><thead><tr><th>Coverage</th><th>Application</th><th>Quote</th><th>Prior policy</th><th>Portal</th><th>Result</th></tr></thead><tbody>{data.coverage.comparison.map((row) => { const missing = row.required && (!row.portal || row.portal.toLowerCase() === "missing"); const matched = same(row.application, row.portal); return <tr key={row.name}><td><strong>{row.name}</strong></td><td>{row.application ?? "—"}</td><td>{row.quote ?? "—"}</td><td>{row.prior_policy ?? "—"}</td><td className={missing ? "cell-bad" : ""}>{row.portal ?? "Missing"}</td><td><span className={missing ? "table-bad" : matched ? "table-good" : "table-warn"}>{missing ? "Missing" : matched ? "Match" : "Confirm"}</span></td></tr>; })}</tbody></table></div></Section>; }

function PropertyView({ data }: { data: InsuranceCase }) { const risk = data.habitational_risk; if (!risk) return null; const mortgagees = data.mortgage?.mortgagees.map((item) => canonicalParty("mortgagee", item)!) ?? []; const lossPayees = data.mortgage?.loss_payees ?? []; return <Section title="Property" eyebrow="Habitational risk"><dl className="key-grid"><KeyValue label="Risk address" value={risk.risk_address} strong /><KeyValue label="Occupancy" value={risk.occupancy} /><KeyValue label="Construction" value={risk.construction} /><KeyValue label="Exterior finish" value={risk.exterior_finish} /><KeyValue label="Year built" value={risk.year_built} /><KeyValue label="Living area" value={risk.living_area ? `${risk.living_area.toLocaleString()} sq ft` : "—"} /><KeyValue label="Bedrooms" value={risk.bedrooms} /><KeyValue label="Bathrooms" value={risk.bathrooms} /><KeyValue label="Garage" value={risk.garage} /><KeyValue label="Smoke-free" value={knownBoolean(risk.smoke_free)} /><KeyValue label="Swimming pool" value={knownBoolean(risk.swimming_pool)} /><KeyValue label="Airbnb" value={knownBoolean(risk.airbnb)} /><KeyValue label="Vacant" value={knownBoolean(risk.vacant)} /></dl><div className="telematics-block"><h3>Mortgage / loss payee · reference address</h3><p><strong>Mortgage: {mortgageDisplay(data)}</strong><br />{mortgagees.map((item) => `${item.name} — ${item.address}`).join("; ") || `Mortgagee: ${mortgageDisplay(data)}`}<br />Loss payee: {lossPayees.map((item) => `${item.name} — ${item.address}`).join("; ") || confirmedNone(data, "mortgage.lossPayees")}</p></div></Section>; }

function PolicyChangeView({ data, onChange }: { data: InsuranceCase; onChange: (next: InsuranceCase, action: string, details?: Record<string, unknown>) => void }) {
  const change = data.policy_change ?? createDefaultPolicyChangeState(data.policy.effective_date ?? ""); const items = change.requested_changes ?? [];
  const [draft, setDraft] = useState<PolicyChangeItem>({ type: "OTHER_POLICY_CHANGE", effective_date: change.change_effective_date || data.policy.effective_date, source: "CLIENT_REQUEST" });
  const [editingId, setEditingId] = useState<string | null>(null); const [currentJson, setCurrentJson] = useState(() => JSON.stringify(change.current_policy_state ?? {}, null, 2)); const [resultJson, setResultJson] = useState(() => JSON.stringify(change.resulting_policy_state ?? {}, null, 2));
  const [fact, setFact] = useState({ field: "", previous: "", value: "", note: "" });
  const saveCase = (patch: Partial<NonNullable<InsuranceCase["policy_change"]>>, action: string, details: Record<string, unknown> = {}) => onChange({ ...data, policy_change: { ...change, ...patch } }, action, details);
  const saveTransaction = () => { const item = { ...draft, id: editingId ?? crypto.randomUUID() }; const next = editingId ? items.map((entry) => entry.id === editingId ? item : entry) : [...items, item]; const types = [...new Set(next.map((entry) => entry.type))]; const actions: Partial<Record<PolicyChangeTransactionType, string>> = { VEHICLE_SUBSTITUTION: "VEHICLE_SUBSTITUTED", ADD_VEHICLE: "VEHICLE_ADDED", DELETE_VEHICLE: "VEHICLE_DELETED", ADD_DRIVER: "DRIVER_ADDED", DELETE_DRIVER: "DRIVER_DELETED", DRIVER_REASSIGNMENT: "DRIVER_REASSIGNED", ADDRESS_CHANGE: "ADDRESS_CHANGED", VEHICLE_USE_CHANGE: "VEHICLE_USE_CHANGED", ANNUAL_KM_CHANGE: "ANNUAL_KM_CHANGED", COMMUTE_CHANGE: "COMMUTE_CHANGED", COVERAGE_CHANGE: "COVERAGE_CHANGED", DEDUCTIBLE_CHANGE: "DEDUCTIBLE_CHANGED", LESSOR_CHANGE: "INTERESTED_PARTY_CHANGED", LIENHOLDER_CHANGE: "INTERESTED_PARTY_CHANGED", PAYMENT_CHANGE: "PAYMENT_CHANGE_REQUESTED", CANCELLATION: "CANCELLATION_REQUESTED", ENDORSEMENT_CHANGE: "ENDORSEMENT_CHANGED", OPCF16_ADD: "ENDORSEMENT_CHANGED", OPCF16_REMOVE: "ENDORSEMENT_CHANGED", OPCF16_REINSTATE: "ENDORSEMENT_CHANGED", OPCF17_ADD: "ENDORSEMENT_CHANGED", OPCF17_REMOVE: "ENDORSEMENT_CHANGED", OPCF17_REINSTATE: "ENDORSEMENT_CHANGED" }; const audit = editingId ? "TRANSACTION_CHANGED" : actions[item.type] ?? "TRANSACTION_ADDED"; saveCase({ requested_changes: next, transaction_types: types, requested_action: next.map((entry) => `${titleCase(entry.type)}: ${String(entry.new_value ?? entry.notes ?? "")}`).join("; ") }, audit, { transaction: item }); setDraft({ type: "OTHER_POLICY_CHANGE", effective_date: change.change_effective_date || data.policy.effective_date, source: "CLIENT_REQUEST" }); setEditingId(null); };
  const edit = (item: PolicyChangeItem) => { setDraft(item); setEditingId(item.id ?? null); };
  const remove = (item: PolicyChangeItem) => { const next = items.filter((entry) => entry.id !== item.id); saveCase({ requested_changes: next, transaction_types: [...new Set(next.map((entry) => entry.type))] }, "TRANSACTION_REMOVED", { transaction: item }); };
  const saveState = (key: "current_policy_state" | "resulting_policy_state", text: string) => { try { saveCase({ [key]: JSON.parse(text) }, key === "current_policy_state" ? "CURRENT_POLICY_STATE_CHANGED" : "RESULTING_POLICY_STATE_CHANGED"); } catch { window.alert("Enter valid JSON before saving this state."); } };
  const addFact = () => { if (!fact.field || !fact.value) return; const entry = { field: fact.field, previous_value: fact.previous || undefined, value: fact.value, confirmed_by: "Local User", confirmed_at: new Date().toISOString(), note: fact.note || undefined }; onChange({ ...data, client_confirmed_facts: [...(data.client_confirmed_facts ?? []), entry] }, "CLIENT_CONFIRMED_FACT", { fact: entry }); setFact({ field: "", previous: "", value: "", note: "" }); };
  return <div className="content-stack policy-change-editor"><Section title="Policy / Change Basic Information" eyebrow="Policy Change Daily-Use Editor"><div className="editor-grid"><label>Policy Number<input value={data.policy.policy_number ?? ""} onChange={(event) => onChange({ ...data, policy: { ...data.policy, policy_number: event.target.value } }, "POLICY_CHANGE_BASIC_INFO_CHANGED")} /></label><label>Named Insured<input value={data.insured.name} onChange={(event) => onChange({ ...data, insured: { ...data.insured, name: event.target.value } }, "POLICY_CHANGE_BASIC_INFO_CHANGED")} /></label><label>Carrier<input value={data.policy.company} onChange={(event) => onChange({ ...data, policy: { ...data.policy, company: event.target.value } }, "POLICY_CHANGE_BASIC_INFO_CHANGED")} /></label><label>Change Effective Date<input type="date" value={change.change_effective_date ?? ""} onChange={(event) => saveCase({ change_effective_date: event.target.value }, "TRANSACTION_TYPE_CHANGED")} /></label><label>UW Status<select value={change.uw_status ?? "NOT_REQUIRED"} onChange={(event) => saveCase({ uw_status: event.target.value as typeof change.uw_status, uw_required: event.target.value !== "NOT_REQUIRED" }, `UW_${event.target.value}`)}>{["NOT_REQUIRED", "PENDING", "REFERRED", "APPROVED", "DECLINED"].map((value) => <option key={value}>{value}</option>)}</select></label><label>Backdated<input type="checkbox" checked={Boolean(change.is_backdated)} onChange={(event) => saveCase({ is_backdated: event.target.checked }, event.target.checked ? "BACKDATE_REQUESTED" : "BACKDATE_REMOVED")} /></label></div></Section><Section title="Current Policy State"><Textarea value={currentJson} onChange={(event) => setCurrentJson(event.target.value)} /><Button size="sm" onClick={() => saveState("current_policy_state", currentJson)}>Save current state</Button></Section><Section title="Requested Changes"><div className="transaction-editor"><label>Transaction<select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as PolicyChangeTransactionType })}>{POLICY_CHANGE_TRANSACTIONS.map((type) => <option key={type} value={type}>{titleCase(type)}</option>)}</select></label><label>Subject / vehicle / driver<input value={draft.subject_name ?? ""} onChange={(event) => setDraft({ ...draft, subject_name: event.target.value })} /></label><label>Field / endorsement<input value={draft.field ?? ""} onChange={(event) => setDraft({ ...draft, field: event.target.value })} placeholder="Address, VIN, OPCF code, payment method…" /></label><label>Current value<input value={String(draft.previous_value ?? "")} onChange={(event) => setDraft({ ...draft, previous_value: event.target.value })} /></label><label>Requested value<input value={String(draft.new_value ?? "")} onChange={(event) => setDraft({ ...draft, new_value: event.target.value })} /></label><label>Effective date<input type="date" value={draft.effective_date ?? ""} onChange={(event) => setDraft({ ...draft, effective_date: event.target.value })} /></label><label>Source<input value={draft.source ?? ""} onChange={(event) => setDraft({ ...draft, source: event.target.value })} /></label><label className="wide">Notes<input value={draft.notes ?? ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div className="editor-actions"><Button size="sm" onClick={saveTransaction}>{editingId ? "Save transaction" : "Add transaction"}</Button>{editingId && <Button size="sm" variant="outline" onClick={() => { setEditingId(null); setDraft({ type: "OTHER_POLICY_CHANGE" }); }}>Cancel edit</Button>}</div></div><div className="transaction-list">{items.map((item) => <article key={item.id}><div><strong>{titleCase(item.type)}</strong><span>{item.subject_name || item.field || "Policy"} · {String(item.previous_value ?? "—")} → {String(item.new_value ?? "—")} · {item.effective_date || "No date"}</span></div><Button size="sm" variant="outline" onClick={() => edit(item)}>Edit</Button><Button size="sm" variant="outline" onClick={() => remove(item)}>Remove</Button></article>)}</div></Section><Section title="Resulting Policy State"><Textarea value={resultJson} onChange={(event) => setResultJson(event.target.value)} /><Button size="sm" onClick={() => saveState("resulting_policy_state", resultJson)}>Save resulting state</Button></Section><Section title="Client Confirmed Facts"><div className="editor-grid"><label>Field<input value={fact.field} onChange={(event) => setFact({ ...fact, field: event.target.value })} /></label><label>Previous/source value<input value={fact.previous} onChange={(event) => setFact({ ...fact, previous: event.target.value })} /></label><label>Confirmed value<input value={fact.value} onChange={(event) => setFact({ ...fact, value: event.target.value })} /></label><label>Source note<input value={fact.note} onChange={(event) => setFact({ ...fact, note: event.target.value })} /></label></div><Button size="sm" onClick={addFact}>Add confirmed fact</Button><div className="transaction-list">{data.client_confirmed_facts?.map((item, index) => <article key={`${item.field}-${index}`}><div><strong>{item.field}</strong><span>{String(item.previous_value ?? "—")} → {String(item.value)} · {item.confirmed_by}</span></div></article>)}</div></Section><Section title="UW / Backdate"><div className="editor-grid"><label>Backdate reason<input value={change.backdate_reason ?? ""} onChange={(event) => saveCase({ backdate_reason: event.target.value }, "BACKDATE_REQUESTED")} /></label><label>Notes<input value={change.notes ?? ""} onChange={(event) => saveCase({ notes: event.target.value }, "POLICY_CHANGE_NOTES_CHANGED")} /></label></div><pre>{transactionSummary(data)}</pre></Section><Section title="Payment / Premium Impact"><dl className="key-grid"><KeyValue label="Quoted Annual" value={money(data.premium.quoted_annual)} /><KeyValue label="Portal Annual" value={money(data.premium.portal_annual)} /><KeyValue label="Difference" value={money(data.premium.difference)} /></dl></Section></div>;
}

function NameChangeSection({ data, onChange }: { data: InsuranceCase; onChange: (next: InsuranceCase, action: string) => void }) {
  const change = data.policy_change;
  if (!change || !normalizePolicyChangeTransactions(change.requested_action, change.transaction_types).includes("NAME_CHANGE")) return null;
  const value = change.name_change ?? { previous_legal_name: "", requested_legal_name: "", effective_date: change.change_effective_date ?? "", broker_confirmed: false };
  const save = (patch: Partial<typeof value>, resetConfirmation = true) => onChange({ ...data, policy_change: { ...change, name_change: { ...value, ...patch, broker_confirmed: resetConfirmation ? false : patch.broker_confirmed ?? value.broker_confirmed } } }, "NAME_CHANGE_UPDATED");
  return <Section title="Name Change" eyebrow="Legal identity · broker confirmation required"><div className="editor-grid">
    <label>Previous legal name<input value={value.previous_legal_name} onChange={event => save({ previous_legal_name: event.target.value })} /></label>
    <label>Requested legal name<input value={value.requested_legal_name} onChange={event => save({ requested_legal_name: event.target.value })} /></label>
    <label>Effective date<input type="date" value={value.effective_date} onChange={event => save({ effective_date: event.target.value })} /></label>
    <label>Active supporting document<select value={value.supporting_document_id ?? ""} onChange={event => save({ supporting_document_id: event.target.value || undefined })}><option value="">Select evidence</option>{data.documents.filter(document => document.received).map(document => <option key={document.id} value={document.id}>{document.name}</option>)}</select></label>
    <label>Broker confirms legal name change<input type="checkbox" checked={value.broker_confirmed} onChange={event => save({ broker_confirmed: event.target.checked }, false)} /></label>
  </div><p>The insured name is not changed automatically. Confirm the requested transaction and supporting evidence before applying it.</p></Section>;
}

function PaymentView({ data }: { data: InsuranceCase }) {
  const payment = data.payment;
  const annual = payment.annual_premium ?? data.premium.quoted_annual;
  const line = data.case_type === "new_auto" ? "AUTO" : data.case_type === "new_home" ? "HAB" : null;
  const annualEstimate = annual == null || !line ? null : estimateBrokerFee(annual, line, "annual");
  const monthlyEstimate = annual == null || !line ? null : estimateBrokerFee(annual, line, "monthly");
  return <Section title="Payment" eyebrow="Last in broker summary">
    <dl className="key-grid"><KeyValue label="Payment plan" value={payment.plan} strong /><KeyValue label="Annual premium" value={money(payment.annual_premium)} /><KeyValue label="Tax" value={money(payment.tax)} /><KeyValue label="Installment fee" value={money(payment.fees)} /><KeyValue label="Total estimated cost" value={money(payment.total_cost)} /><KeyValue label="Monthly amount" value={money(payment.monthly_amount)} /><KeyValue label="Number of installments" value={payment.number_of_installments} /><KeyValue label="Down payment" value={money(payment.down_payment)} /></dl>
    {annualEstimate && monthlyEstimate && <div className="payment-worksheet-estimate"><h3>Broker worksheet estimate (not insurer tariff)</h3>
      <dl className="key-grid"><KeyValue label="Base annual premium" value={money(annualEstimate.annualPremium)} /><KeyValue label="Tax (auto 0%; home 8%)" value={money(annualEstimate.tax)} /><KeyValue label="Annual-plan total (no finance fee)" value={money(annualEstimate.total)} /><KeyValue label="Monthly-plan finance fee (auto 1.3%; home 3%)" value={money(monthlyEstimate.financingFee)} /><KeyValue label="Monthly-plan yearly total" value={money(monthlyEstimate.total)} /><KeyValue label="Monthly reference (12 installments)" value={monthlyEstimate.monthly == null ? "Not applicable" : money(monthlyEstimate.monthly)} /></dl>
      <p>Calculation reference only; select and confirm the insurer payment plan separately. Actual carrier fees, down payment and installment count may differ.</p>
    </div>}
  </Section>;
}

function ReviewGroup({ title, count, tone, children }: { title: string; count: number; tone: string; children: React.ReactNode }) { return <section className={`review-group ${tone}`}><div className="review-title"><h2>{title}</h2><span>{count}</span></div><div className="review-items">{children}</div></section>; }
function EmptyReview({ label }: { label: string }) { return <div className="empty-review"><CheckCircle2 /> {label}</div>; }
function AlertCard({ alert, data, onResolve, onOverride }: { alert: ReturnType<typeof runRules>[number]; data: InsuranceCase; onResolve: (field: string | undefined, source?: FieldSourceName) => void; onOverride: (code: Alert["code"]) => void }) { const field = data.field_sources.find((item) => item.field === alert.field); return <article className={`alert-card ${alert.severity}`}><div className="alert-card-top">{alert.severity === "high" ? <CircleAlert /> : <AlertTriangle />}<div><span>{alert.severity}</span><strong>{alert.message}</strong></div></div><SourceValues values={alert.sourceValues ?? []} /><div className="resolution-actions">{field && <>{field.values.map((item, index) => field.values.filter(candidate => candidate.source === item.source).length === 1 ? <button key={`${item.source}-${item.documentId ?? "manual"}-${index}`} onClick={() => onResolve(alert.field, item.source)}>Use {titleCase(item.source).replace("Signed ", "")}</button> : null)}{field.values.some((item) => field.values.filter(candidate => candidate.source === item.source).length > 1) && <span>Multiple sources of the same type: enter a broker-confirmed value after reviewing each source.</span>}<button onClick={() => onResolve(alert.field)}>Enter correct value</button></>}<button className="override-button" onClick={() => onOverride(alert.code)}>Broker override</button></div></article>; }

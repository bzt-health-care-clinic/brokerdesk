import { activeParsedSources } from "./active-evidence.ts";
import type { Driver } from "./insurance-types.ts";
import type { UploadedDocumentRecord } from "./extraction-types.ts";

export interface ProposedDriver { name: string; licenceNumber: string; documentId: string; logicalDocumentId?: string }
const licenceKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A proposal is available only when active MVR evidence names one unambiguous licence holder. */
export function proposedDrivers(records: UploadedDocumentRecord[], existing: Driver[]): ProposedDriver[] {
  const candidates = records.flatMap(record => activeParsedSources(record).filter(source => source.documentType === "MVR").map(source => ({
    name: String(source.data.driverName ?? "").trim(), licenceNumber: String(source.data.licenceNumber ?? "").trim(), documentId: source.documentId, logicalDocumentId: source.logicalDocumentId,
  }))).filter(candidate => candidate.name && licenceKey(candidate.licenceNumber));
  const groups = new Map<string, ProposedDriver[]>();
  for (const candidate of candidates) { const key = licenceKey(candidate.licenceNumber); groups.set(key, [...(groups.get(key) ?? []), candidate]); }
  return [...groups].flatMap(([key, group]) => {
    if (existing.some(driver => licenceKey(driver.licence_number) === key)) return [];
    if (new Set(group.map(candidate => candidate.name.toUpperCase())).size !== 1) return [];
    return [group[0]];
  });
}

export function confirmedDriverFromProposal(proposal: ProposedDriver): Driver {
  return { id: crypto.randomUUID(), name: proposal.name, relationship: "", principal: false, percentage_use: 0,
    licence_number: proposal.licenceNumber, licence_class: "", g1_date: "", g2_date: "", g_date: "", mvr_received: "",
    driver_training: false, retired: false, convictions: [], demerit_points: null,
    telematics: { enabled: false, app: "", phone: "", email: "", discount_percent: 0 } };
}

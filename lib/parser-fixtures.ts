import type { DocumentType, ParsedSource } from "./extraction-types.ts";

function source(documentType: DocumentType, data: Record<string, unknown>): ParsedSource {
  const documentId = `fixture-${documentType.toLowerCase()}`;
  return {
    documentId,
    documentType,
    parsedAt: "2026-09-14T12:00:00.000Z",
    confidence: .98,
    data,
    warnings: [],
    fieldEvidence: Object.fromEntries(Object.entries(data).map(([field, value], index) => [field, [{ page: Math.floor(index / 5) + 1, text: String(value), confidence: .98 }]])),
  };
}

export const parserFixtures: ParsedSource[] = [
  source("AUTO_APPLICATION", { insurer: "Pembridge", quoteNumber: "SYNTH-QUOTE-0001", namedInsured: "CASEY EXAMPLE", effectiveDate: "2026-09-09", vin: "ZZZTESTA0T0000001", vehicleUse: "Pleasure", annualKm: "5000", commuteKm: "0", g1Date: "2004-03-10", g2Date: "2005-03-10", gDate: "2006-03-10", telematicsEmail: "synthetic.user@example.com" }),
  source("AUTO_QUOTE", { insurer: "Pembridge", quoteNumber: "SYNTH-QUOTE-0001", namedInsured: "Casey Example", effectiveDate: "2026-09-09", vin: "ZZZTESTA0T0000001", annualKm: "5000", commuteKm: "0", premium: "2760" }),
  source("OWNERSHIP", { registeredOwner: "CASEY EXAMPLE", ownerAddress: "100 Example Avenue, Toronto, ON A1A 1A1", plate: "CXKP214", vin: "ZZZTESTA0T0000001", year: "2024", make: "Lexus", model: "NX 350" }),
  source("MVR", { driverName: "CASEY EXAMPLE", licenceNumber: "T0000-00000-00000", licenceClass: "G", licenceStatus: "Licensed", issueDate: "2017-12-05", demeritPoints: "0", replyDate: "2026-08-18" }),
  source("DASH", { priorInsurer: "Certas Home and Auto Insurance Company", priorPolicyNumber: "SYNTH-ID-0001", priorEffective: "2018-09-09", priorExpiry: "2027-09-09", policyStatus: "Active", insuredSince: "2014-03-10", claimsJson: [{ lossDate: "2016-09-13", atFaultPercent: 100, lossAmount: 10540 }] }),
  source("HAB_APPLICATION", { insurer: "Aviva", namedInsured: "Riley Example", effectiveDate: "2026-10-01", propertyInsuredSince: "2020-09-12", riskAddress: "200 Sample Road, Ottawa, ON A1A 1A1", policyType: "Homeowner", mortgagee: "The Royal Bank of Canada", mortgageeAddress: "500 Fictional Lane, Toronto, ON A1A 1A1", premium: "1850" }),
  source("HAB_QUOTE", { insurer: "Aviva", quoteNumber: "SYNTH-ID-0001", namedInsured: "RILEY EXAMPLE", effectiveDate: "2026-10-01", propertyInsuredSince: "2020-07-08", riskAddress: "200 Sample Road, Ottawa, ON A1A 1A1", policyType: "Homeowner", premium: "1850" }),
  source("POLICY_CHANGE", { namedInsured: "Jordan Example", policyNumber: "SYNTH-ID-0001", insurer: "Pembridge", requestedEffectiveDate: "2026-09-08", vehicleOrProperty: "2024 Hyundai Kona", vin: "ZZZTESTA0T0000001", requestedAction: "Restore previous full coverage" }),
  source("PORTAL_SCREENSHOT", { namedInsured: "Jordan Example", effectiveDate: "2026-09-08", vin: "ZZZTESTA0T0000001", annualKm: "5000", premium: "2996" }),
];

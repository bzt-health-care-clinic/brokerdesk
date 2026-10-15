import type { LogicalDocument, UploadedDocumentRecord } from "./extraction-types.ts";

export function sanitizeWindowsFilename(value: string) {
  const clean = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/g, "").trim();
  return clean === "." || clean === ".." ? "Document" : clean.slice(0, 180) || "Document";
}

const withName = (name: string | undefined, suffix: string) => sanitizeWindowsFilename([name?.trim(), suffix].filter(Boolean).join(" - ")) + ".pdf";
export function suggestDocumentFilename(record: UploadedDocumentRecord, insuredName?: string) {
  const sections = record.logicalDocuments ?? [];
  const types = new Set(sections.map((item) => item.documentType));
  const g4 = record.containerType === "SIGNED_AUTO_PACKAGE" || /^g4sign[_ -]/i.test(record.originalFileName ?? record.fileName);
  if (g4) return withName(insuredName, "G4Broker Signed Documents");
  if (["AUTO_SUPPORTING_PACKAGE", "COMBINED_AUTO_PACKAGE"].includes(record.containerType ?? "") || types.size > 1) return withName(insuredName, "Auto - Combined Supporting Package");
  const section: LogicalDocument | undefined = sections[0]; const type = section?.documentType ?? record.documentType; const parsedSubject = record.parsed?.data.driverName; const subject = section?.subjectName ?? (typeof parsedSubject === "string" ? parsedSubject : undefined);
  const suffix: Partial<Record<typeof type, string>> = { OWNERSHIP: "Auto - Ownership", BILL_OF_SALE: "Auto - Bill of Sale", VEHICLE_PHOTO: `Auto - Vehicle Photo${subject ? ` - ${subject}` : ""}${section?.documentSubtype ? ` - ${section.documentSubtype}` : ""}`, DRIVER_TRAINING_CERTIFICATE: `Auto - Graduation Certificate${subject ? ` - ${subject}` : ""}`, PAYMENT_AUTHORIZATION: "Auto - Payment Authorization", CANCELLATION_REQUEST: "Auto - Cancellation Request", AUTO_QUOTE: "Auto - Quote", AUTO_APPLICATION: "Auto - Signed Application", WINTER_TIRE_PROOF: "Auto - Winter Tire Proof", MVR: `Auto - MVR${subject ? ` - ${subject}` : ""}`, DASH: `Auto - DASH${subject ? ` - ${subject}` : ""}` };
  return suffix[type] ? withName(insuredName, suffix[type]!) : undefined;
}

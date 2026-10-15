import type { DocumentType, UploadedDocumentRecord } from "./extraction-types.ts";

export function activeDocumentTypes(records: UploadedDocumentRecord[]) {
  return new Set<DocumentType>(records.flatMap((record) => (record.logicalDocuments === undefined ? [{ documentType: record.documentType, presenceStatus: "FOUND" as const }] : record.logicalDocuments).filter((item) => item.presenceStatus === "FOUND").map((item) => item.documentType)));
}

export function documentTypeIsFound(records: UploadedDocumentRecord[], types: DocumentType[]) {
  const active = activeDocumentTypes(records);
  return types.some((type) => active.has(type));
}

export function applyDocumentPresence<T extends { documents: Array<{ category: string; received: boolean }>; ownership?: { received: boolean } }>(item: T, records: UploadedDocumentRecord[]): T {
  const categoryTypes: Record<string, DocumentType[]> = { signed_application: ["AUTO_APPLICATION", "HAB_APPLICATION"], quote: ["AUTO_QUOTE", "HAB_QUOTE"], ownership: ["OWNERSHIP"], bill_of_sale: ["BILL_OF_SALE"], vehicle_photo: ["VEHICLE_PHOTO"], payment_authorization: ["PAYMENT_AUTHORIZATION"], cancellation_request: ["CANCELLATION_REQUEST"], mvr: ["MVR"], dash: ["DASH"], previous_policy: ["PRIOR_AUTO_POLICY", "PRIOR_PROPERTY_POLICY"], lease_agreement: ["LEASE_DOCUMENT"], finance_document: ["FINANCE_DOCUMENT"], winter_tire_proof: ["WINTER_TIRE_PROOF"], mortgage_document: ["MORTGAGE_DOCUMENT"], void_cheque: ["VOID_CHEQUE"], signed_change_form: ["OPCF_FORM", "POLICY_CHANGE"] };
  const active = activeDocumentTypes(records); const next = structuredClone(item);
  const shared = [{ category: "bill_of_sale", name: "Bill of Sale", type: "BILL_OF_SALE" }, { category: "vehicle_photo", name: "Vehicle Photo", type: "VEHICLE_PHOTO" }, { category: "diploma", name: "Graduation Certificate", type: "DRIVER_TRAINING_CERTIFICATE" }, { category: "payment_authorization", name: "Payment Authorization", type: "PAYMENT_AUTHORIZATION" }, { category: "cancellation_request", name: "Cancellation Request", type: "CANCELLATION_REQUEST" }] as const;
  for (const document of shared) if (active.has(document.type) && !next.documents.some((entry) => entry.category === document.category)) next.documents.push({ id: `shared-${document.category}`, name: document.name, category: document.category, required: false, received: true } as T["documents"][number]);
  next.documents = next.documents.map((document) => ({ ...document, received: (categoryTypes[document.category] ?? []).some((type) => active.has(type)) }));
  if (next.ownership) next.ownership.received = active.has("OWNERSHIP");
  return next;
}

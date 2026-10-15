export type CaseValidationStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";

export function validationHasStarted(item: { validationStatus?: CaseValidationStatus }) {
  // Existing saved and fixture cases predate this field and retain their current validation behavior.
  return item.validationStatus !== "NOT_STARTED";
}

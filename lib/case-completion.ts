import type { InsuranceCase } from "./insurance-types.ts";

export function markCaseComplete<T extends InsuranceCase>(item: T): T {
  return { ...item, status: "keyed" };
}

export function markCaseIncomplete<T extends InsuranceCase>(item: T): T {
  return { ...item, status: "incomplete" };
}

export function completionActionLabel(status: InsuranceCase["status"]) {
  return status === "keyed" ? "Mark incomplete" : "Mark complete";
}

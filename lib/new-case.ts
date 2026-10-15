import type { InsuranceCase } from "./insurance-types.ts";
import { createBlankAutoCase, createBlankHabCase, createBlankPolicyChangeCase } from "./case-factories.ts";

export type NewCaseType = "AUTO" | "HAB" | "POLICY_CHANGE";

export function createBlankCaseForType(type: NewCaseType): InsuranceCase {
  if (type === "HAB") return createBlankHabCase();
  if (type === "POLICY_CHANGE") return createBlankPolicyChangeCase();
  return createBlankAutoCase();
}

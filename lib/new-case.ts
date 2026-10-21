import type { InsuranceCase } from "./insurance-types.ts";
import { createBlankAutoCase, createBlankHabCase, createBlankPolicyChangeCase } from "./case-factories.ts";

export type NewCaseType = "AUTO" | "HAB" | "POLICY_CHANGE" | "HOME_POLICY_CHANGE";

export function createBlankCaseForType(type: NewCaseType): InsuranceCase {
  if (type === "HAB") return createBlankHabCase();
  if (type === "POLICY_CHANGE") return createBlankPolicyChangeCase();
  if (type === "HOME_POLICY_CHANGE") {
    const item=createBlankHabCase();
    item.case_type="home_policy_change";item.label="New Home Policy Change";
    item.documents=item.documents.map(document=>({...document,required:false}));
    item.policy_change=createBlankPolicyChangeCase().policy_change;
    return item;
  }
  return createBlankAutoCase();
}

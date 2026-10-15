import type { CaseSummary } from "./local-repositories.ts";
import type { InsuranceCase } from "./insurance-types.ts";

export const caseEditorKind = (item: InsuranceCase | null | undefined) => !item ? "empty" : item.case_type === "auto_policy_change" || item.case_type === "home_policy_change" ? "policy_change" : ["new_home", "new_condo", "new_tenant"].includes(item.case_type) ? "hab" : "new_auto";
export const nextCaseAfterRemoval = (items: CaseSummary[]) => items[0]?.id ?? null;

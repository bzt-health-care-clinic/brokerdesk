import { DEFAULT_RULE_CONFIG, type Claim, type InsuranceCase, type RuleConfig } from "./insurance-types.ts";

export function validCalendarDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
export function partitionClaims(claims: Claim[], asOf: Date | null, years: number, inclusive = true) {
  const boundary = asOf && Number.isFinite(asOf.getTime()) && Number.isFinite(years) && years >= 0 ? new Date(asOf) : null;
  boundary?.setUTCFullYear(boundary.getUTCFullYear() - years);
  const result: { ratingPeriod: Claim[]; historical: Claim[]; undetermined: Claim[] } = { ratingPeriod: [], historical: [], undetermined: [] };
  for (const claim of claims) {
    const loss = validCalendarDate(claim.loss_date);
    if (!loss || !boundary || claim.source_active === false) result.undetermined.push(claim);
    else if (inclusive ? loss >= boundary : loss > boundary) result.ratingPeriod.push(claim);
    else result.historical.push(claim);
  }
  return result;
}
export function assessClaims(data: InsuranceCase, config: RuleConfig = DEFAULT_RULE_CONFIG) {
  const policyChange = data.case_type === "auto_policy_change" || data.case_type === "home_policy_change";
  const intended = policyChange ? data.policy_change?.change_effective_date || data.policy_change?.requested_effective_date || data.policy.effective_date : data.policy.effective_date;
  const date = validCalendarDate(intended);
  return { assessmentDate: date ? intended : null, requestedDate: intended || null, years: config.ratingPeriodYears, ...partitionClaims(data.claims, date, config.ratingPeriodYears, config.claimBoundaryInclusive ?? true) };
}
export type ClaimAssessment = ReturnType<typeof assessClaims>;

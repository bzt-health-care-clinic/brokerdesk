// Internal broker worksheet estimate only. This is NOT a carrier tariff.
// Source: user-supplied fee calculator; the workbook itself remains private.
// Excel rules: AUTO tax=0%, finance=1.3%; HAB tax=8%, finance=3%
// both percentages apply to ANNUAL BASE PREMIUM (not premium + tax).
// Monthly payment=(premium+tax+finance)/12; annual payment excludes finance.
export type FeeLineOfBusiness = "AUTO" | "HAB";
export type FeePaymentPlan = "monthly" | "annual";
export interface BrokerFeeEstimate {
  annualPremium: number;
  tax: number;
  financingFee: number;
  total: number;
  monthly: number | null;
  installments: number;
  rateSource: "BROKER_WORKSHEET_REFERENCE";
}

export const WORKSHEET_FEE_RATES = Object.freeze({
  AUTO: Object.freeze({ tax: 0, monthlyFinance: 0.013 }),
  HAB: Object.freeze({ tax: 0.08, monthlyFinance: 0.03 }),
});
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * The spreadsheet has no explicit ROUND() operations, only 2-decimal
 * displayed cells. Compute from unrounded intermediate values and round
 * each DISPLAYED result to cents; do not charge based on a rounded month.
 */
export function estimateBrokerFee(
  annualPremium: number,
  line: FeeLineOfBusiness,
  plan: FeePaymentPlan,
): BrokerFeeEstimate | null {
  if (!Number.isFinite(annualPremium) || annualPremium < 0) return null;
  const rates = WORKSHEET_FEE_RATES[line];
  const tax = annualPremium * rates.tax;
  const fee = plan === "monthly" ? annualPremium * rates.monthlyFinance : 0;
  const total = annualPremium + tax + fee;
  return {
    annualPremium: cents(annualPremium),
    tax: cents(tax),
    financingFee: cents(fee),
    total: cents(total),
    monthly: plan === "monthly" ? cents(total / 12) : null,
    installments: plan === "monthly" ? 12 : 1,
    rateSource: "BROKER_WORKSHEET_REFERENCE",
  };
}

import type { InsuranceCase } from "./insurance-types.ts";

export function confirmedNone(data: InsuranceCase, key: string) {
  return data.factConfirmations?.[key]?.confirmed ? "None" : "NOT CONFIRMED";
}
export function knownBoolean(value: boolean | null | undefined) {
  return value == null ? "UNKNOWN" : value ? "Yes" : "No";
}
export function mortgageDisplay(data: InsuranceCase) {
  if (data.mortgage?.mortgagees.length) return String(data.mortgage.number_of_mortgages || data.mortgage.mortgagees.length);
  if (data.mortgage?.number_of_mortgages) return `${data.mortgage.number_of_mortgages} — details missing`;
  return confirmedNone(data, "mortgage.none");
}
export function vehicleTenure(data: InsuranceCase, vehicle: InsuranceCase["vehicles"][number]) {
  if (vehicle.leased === true || vehicle.lessor) return "Leased";
  if (vehicle.lienholder) return "Financed";
  return data.factConfirmations?.[`vehicle.${vehicle.id}.tenure`]?.confirmed && vehicle.owned ? "Owned" : "NOT CONFIRMED";
}

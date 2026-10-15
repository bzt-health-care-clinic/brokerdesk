export type InstitutionRole = "lessor" | "lienholder" | "mortgagee";

export interface InstitutionAddress {
  role: InstitutionRole;
  name: string;
  aliases: string[];
  address: string;
  alternateAddresses?: string[];
}

export const INSTITUTION_DIRECTORY: InstitutionAddress[] = [
  { role: "lessor", name: "BMW Financial Services", aliases: ["BMW", "BMW Financial Services Canada"], address: "1 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Canadian Road Management Company", aliases: ["Ford Canadian Road Management"], address: "2 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Mercedes-Benz Financial", aliases: ["Mercedes Benz Financial"], address: "3 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Pfaff Leasing", aliases: [], address: "4 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Porsche Leasing", aliases: [], address: "5 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Toyota Credit Canada Inc.", aliases: ["Toyota Credit Canada", "Lexus Financial Services", "Subaru Financial Services"], address: "6 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Nissan Canada Finance", aliases: ["Infiniti Financial Services"], address: "7 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Nissan Canada Inc.", aliases: ["Acura Financial Services", "Honda Financial Services"], address: "8 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "VW Credit Canada Inc.", aliases: ["Audi Financial Services", "Volkswagen Credit Canada Inc."], address: "9 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Honda Canada Finance Inc.", aliases: ["Honda Canada Finance"], address: "10 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Ford Credit Canada Limited", aliases: ["Ford Credit Canada"], address: "11 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Porsche Financial Services Canada", aliases: [], address: "12 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Paul Motor Leasing Inc.", aliases: ["Paul Motor Leasing"], address: "13 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Tesla Lease Trust", aliases: ["Tesla Leasing"], address: "14 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lessor", name: "Subaru Financial Service", aliases: ["Subaru Financial Services"], address: "15 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },

  { role: "lienholder", name: "AutoCapital Canada", aliases: ["Auto Capital Canada"], address: "16 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Bank of Montreal", aliases: ["BMO"], address: "17 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Cars on Credit", aliases: [], address: "18 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Canadian Dealer Lease Services", aliases: ["Canadian Dealer Lease Services Inc.", "CDLSI"], address: "19 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Canadian Imperial Bank of Commerce", aliases: ["CIBC"], address: "20 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Canadian Title Loans", aliases: [], address: "21 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Carfinco", aliases: [], address: "22 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Desjardins", aliases: [], address: "23 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Eden Park Financial", aliases: [], address: "24 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "First Access Funding Corp", aliases: ["First Access Funding Corporation"], address: "25 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "General Bank of Canada", aliases: [], address: "26 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "National Bank of Canada", aliases: ["National Bank"], address: "27 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Scotia Dealer Advantage", aliases: [], address: "28 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "The Bank of Nova Scotia", aliases: ["Scotiabank", "Bank of Nova Scotia Auto Finance"], address: "29 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "TD Canada Trust", aliases: ["TD Bank"], address: "30 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "The Royal Bank of Canada RBC Auto Finance", aliases: ["RBC Auto Finance", "Royal Bank Auto Finance"], address: "31 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Volkswagen Credit Canada Inc.", aliases: ["VW Credit Canada Inc."], address: "32 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Manulife Bank of Canada", aliases: ["Manulife Bank"], address: "33 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Honda Canada Finance Inc.", aliases: ["Honda Canada Finance"], address: "34 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "lienholder", name: "Hyundai Motor Finance", aliases: ["Hyundai Finance"], address: "35 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },

  { role: "mortgagee", name: "Bank of China (Canada)", aliases: ["Bank of China Canada"], address: "36 Synthetic Institution Avenue, Exampleville, ON A1A 1A1", alternateAddresses: ["36 Alternate Synthetic Avenue, Exampleville, ON A1A 1A1"] },
  { role: "mortgagee", name: "Bank of Montreal", aliases: ["BMO"], address: "37 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Canadian Imperial Bank of Commerce", aliases: ["CIBC"], address: "38 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Equitable Bank", aliases: [], address: "39 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Home Equity Mortgage Corporation", aliases: ["HEMC"], address: "40 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Home Trust", aliases: ["Home Trust Company"], address: "41 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "HSBC Bank Canada", aliases: ["HSBC"], address: "42 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Industrial and Commercial Bank of China (Canada)", aliases: ["ICBC Canada"], address: "43 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "National Bank", aliases: ["National Bank of Canada"], address: "44 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Street Capital Bank of Canada", aliases: ["Street Capital"], address: "45 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "The Bank of Nova Scotia", aliases: ["Scotiabank", "Bank of Nova Scotia Home"], address: "46 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "The Royal Bank of Canada", aliases: ["RBC", "Royal Bank of Canada"], address: "47 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "The Toronto-Dominion Bank", aliases: ["TD Bank", "Toronto Dominion Bank"], address: "48 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "United Employees Credit Union Limited", aliases: ["United Employees Credit Union"], address: "49 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
  { role: "mortgagee", name: "Vector Financial Services Ltd.", aliases: ["Vector Financial Services"], address: "50 Synthetic Institution Avenue, Exampleville, ON A1A 1A1" },
];

const normalizeName = (value: string) => value.toUpperCase().replace(/\b(INCORPORATED|INC\.?|LIMITED|LTD\.?)\b/g, "").replace(/[^A-Z0-9]/g, "");

export function findInstitution(role: InstitutionRole, name: string): InstitutionAddress | null {
  const needle = normalizeName(name);
  return INSTITUTION_DIRECTORY.find((item) => item.role === role && [item.name, ...item.aliases].some((candidate) => normalizeName(candidate) === needle)) ?? null;
}

export function getCanonicalInstitution(role: InstitutionRole, name: string) {
  const match = findInstitution(role, name);
  return match ? { name: match.name, address: match.address, alternateAddresses: match.alternateAddresses ?? [] } : null;
}

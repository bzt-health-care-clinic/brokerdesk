import type { InsuranceCase } from "./insurance-types.ts";
import { mockCases } from "./mock-cases.ts";

const base = mockCases.find((item) => item.case_id === "CASE-E")!;
const hab = mockCases.find((item) => item.case_id === "CASE-H")!;
const clone = (value: InsuranceCase) => structuredClone(value);
const completeApplication = { english_name: "Avery Example", chinese_name: "示例用户", phone: "416-555-0100", email: "synthetic.user@example.com", employer_institution: "University of Toronto", position_title: "Researcher", field_specialty: "Education", highest_degree: "Master's", university: "Peking University", applicant_signature: "Avery Example", application_date: "2026-08-20", internal_status: "approved" as const, member_number: "SYNTH-ID-0001", review_date: "2026-08-22" };
const matchingDiploma = { holder_name: "AVERY EXAMPLE", university: "Peking University", degree: "Master's", major: "Education", issue_date: "2012-06-30", certificate_number: "PKU-2012-8821", readable: true };

function autoFixture(id: string, label: string, mutate: (item: InsuranceCase) => void): InsuranceCase {
  const item = clone(base); item.case_id = id; item.label = label; item.policy.company = "Definity"; item.insured.name = "Avery Example"; item.policy.auto_quote_number = item.policy.quote_number; mutate(item); if (item.group_discount) item.group_discount.selectionConfirmed = true; return item;
}

export const phase3Cases: InsuranceCase[] = [
  autoFixture("P3-1", "P3·1 Definity · both group docs missing", (item) => { item.group_discount = { selected: true, association: "CTSAC", status: "MISSING_DOCUMENTS" }; }),
  autoFixture("P3-2", "P3·2 Definity · diploma missing", (item) => { item.group_discount = { selected: true, association: "CTSAC", ctsac_application: completeApplication, status: "MISSING_DOCUMENTS" }; }),
  autoFixture("P3-3", "P3·3 Economical · group validated", (item) => { item.policy.company = "Economical"; item.group_discount = { selected: true, association: "CTSAC", ctsac_application: completeApplication, diploma: matchingDiploma, activeEvidence: { application: ["synthetic-ctsac-application"], diploma: ["synthetic-diploma"] }, status: "VALIDATED" }; }),
  autoFixture("P3-4", "P3·4 Diploma name mismatch", (item) => { item.group_discount = { selected: true, association: "CTSAC", ctsac_application: completeApplication, diploma: { ...matchingDiploma, holder_name: "ZETA, TEST" }, activeEvidence: { application: ["synthetic-ctsac-application"], diploma: ["synthetic-diploma"] }, status: "FAILED" }; }),
  autoFixture("P3-5", "P3·5 CTSAC application unsigned", (item) => { item.group_discount = { selected: true, association: "CTSAC", ctsac_application: { ...completeApplication, applicant_signature: undefined }, diploma: matchingDiploma, activeEvidence: { application: ["synthetic-ctsac-application"], diploma: ["synthetic-diploma"] }, status: "NEEDS_REVIEW" }; }),
  autoFixture("P3-6", "P3·6 Group discount not selected", (item) => { item.group_discount = { selected: false, association: "CTSAC", status: "NOT_SELECTED" }; }),
  autoFixture("P3-7", "P3·7 Combined package quote numbers", (item) => { item.policy.auto_quote_number = "123456789"; item.policy.hab_quote_number = "987654321"; item.policy.quote_number = "123456789"; }),
  { ...clone(hab), case_id: "P3-8", label: "P3·8 Tenant · no mortgage", case_type: "new_tenant", mortgage: { number_of_mortgages: 0, mortgagees: [], loss_payees: [] }, habitational_risk: { ...hab.habitational_risk!, policy_type: "Tenant", occupied_since: "2024-03-01" }, policy: { ...hab.policy, hab_quote_number: "SYNTH-ID-0001" } },
  autoFixture("P3-9", "P3·9 Complete MVR standard", (item) => { item.group_discount = { selected: false, status: "NOT_SELECTED" }; item.drivers[0] = { ...item.drivers[0], mvr_requested: "2026-08-18", mvr_received: "2026-08-18", licence_class: "G", licence_expiry: "2030-04-18", licence_conditions: ["Corrective lenses"], licence_status: "Licensed", licence_province: "ON", assigned_vehicle: "Vehicle 1" }; }),
  autoFixture("P3-10", "P3·10 Single owner / co-insured", (item) => { item.insured.name = "Morgan Example"; item.ownership!.registered_owner = "Morgan Example"; item.drivers[0].name = "Morgan Example"; item.insured.co_insured = [{ name: "Taylor Example" }]; item.group_discount = { selected: false, status: "NOT_SELECTED" }; }),
];

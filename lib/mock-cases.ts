import type { InsuranceCase } from "./insurance-types.ts";

const documents = (ownership = true) => [
  { id: "doc-app", name: "Signed Application", category: "signed_application" as const, required: true, received: true },
  { id: "doc-quote", name: "Quote", category: "quote" as const, required: true, received: true },
  { id: "doc-own", name: "Ownership", category: "ownership" as const, required: true, received: ownership },
  { id: "doc-mvr", name: "MVR", category: "mvr" as const, required: true, received: true },
  { id: "doc-dash", name: "DASH / AutoPlus", category: "dash" as const, required: true, received: true },
  { id: "doc-lease", name: "Lease Agreement", category: "lease_agreement" as const, required: false, received: true },
  { id: "doc-void", name: "Void Cheque", category: "void_cheque" as const, required: false, received: false },
];

const baseAuto: InsuranceCase = {
  factConfirmations: { "vehicles.0.lienholder.none": { confirmed: true, by: "Synthetic fixture", at: "2026-09-14" } },
  case_id: "AUTO-2026-0914",
  case_type: "new_auto",
  status: "in_review",
  label: "Auto — clean baseline",
  signed: true,
  policy: {
    company: "Pembridge",
    client_code: "XUGU01",
    quote_number: "416-555-0100",
    binder_number: null,
    effective_date: "2026-10-08",
    expiry_date: "2027-10-08",
  },
  insured: { name: "Jordan Example", dob: "1988-04-18", gender: "M", co_insured: [] },
  ownership: {
    received: true,
    registered_owner: "Jordan Example",
    address: "100 Example Avenue, Toronto, ON A1A 1A1",
    plate: "CXKP 214",
    year: 2026,
    make: "Volvo",
    model: "XC60 Ultra B5 AWD",
    vin: "ZZZTESTA0T0000001",
    leased: true,
    lessor: { name: "Canadian Dealer Lease Services Inc.", address: "Suite 300, 300 Test Street, Toronto, ON A1A 1A1" },
    lienholder: null,
  },
  drivers: [
    {
      name: "Jordan Example",
      dob: "1988-04-18",
      gender: "M",
      marital_status: "Married",
      relationship: "applicant",
      principal: true,
      percentage_use: 100,
      licence_number: "T0000-00000-00000",
      licence_class: "G",
      g1_date: "2014-11-10",
      g2_date: "2016-06-05",
      g_date: "2017-08-06",
      mvr_received: "2026-08-18",
      driver_training: false,
      retired: false,
      convictions: [{ description: "Speeding", offence_date: "2024-01-28", conviction_date: "2024-02-05", speed_over_limit: 15, severity: "Minor", demerit_points: 0 }],
      demerit_points: 0,
      telematics: { enabled: true, app: "Pembridge My_BRIDGE", phone: "416-555-0100", email: "synthetic.user@example.com", discount_percent: 10 },
    },
  ],
  vehicles: [
    {
      year: 2026,
      make: "Volvo",
      model: "XC60 Ultra B5 AWD",
      vin: "ZZZTESTA0T0000001",
      owned: false,
      leased: true,
      purchase_condition: "New",
      purchase_date: "2026-09-30",
      purchase_price: 68400,
      list_price_new: 71350,
      primary_use: "Pleasure",
      annual_km: 5000,
      commute_km: 0,
      business_use_percent: 0,
      winter_tires: true,
      parking: "Private driveway",
      garaging_address: "100 Example Avenue, Toronto, ON A1A 1A1",
      lessor: { name: "Canadian Dealer Lease Services Inc.", address: "Suite 300, 300 Test Street, Toronto, ON A1A 1A1" },
      lienholder: null,
    },
  ],
  prior_insurance: {
    insurer: "Intact Insurance",
    policy_number: "SYNTH-ID-0001",
    effective_date: "2025-10-08",
    expiry_date: "2026-10-08",
    insured_since: "2014-11-10",
    years_prior_insurance: 12,
  },
  claims: [
    { id: "clm-1", loss_date: "2025-07-03", insurer: "Intact", policy_number: "SYNTH-ID-0001", claim_number: "SYNTH-CLAIM-0001", coverage: "Collision", loss_amount: 22504, expense: 1200, vehicle: "2023 Volvo XC60", driver: "Jordan Example", at_fault_percent: 100, status: "Closed", portal_present: true },
    { id: "clm-2", loss_date: "2025-03-04", insurer: "Intact", policy_number: "SYNTH-ID-0001", claim_number: "SYNTH-CLAIM-0001", coverage: "Comprehensive/Glass", loss_amount: 865, expense: 0, vehicle: "2023 Volvo XC60", driver: "Jordan Example", at_fault_percent: 0, status: "Closed", portal_present: true },
    { id: "clm-3", loss_date: "2016-09-13", insurer: "Aviva", policy_number: "SYNTH-ID-0001", claim_number: "SYNTH-CLAIM-0001", coverage: "Collision", loss_amount: 10540, expense: 850, vehicle: "2014 Honda Accord", driver: "Jordan Example", at_fault_percent: 100, status: "Closed", portal_present: true },
  ],
  coverage: {
    liability: 2000000,
    dcpd_deductible: 0,
    all_perils_deductible: 1000,
    endorsements: ["OPCF 20", "OPCF 27", "OPCF 43", "OPCF 44R"],
    comparison: [
      { name: "Liability", application: "$2M", quote: "$2M", prior_policy: "$2M", portal: "$2M", required: true },
      { name: "All Perils", application: "$1,000", quote: "$1,000", prior_policy: "$1,000", portal: "$1,000", required: true },
      { name: "OPCF 20", application: "$3,000", quote: "$3,000", prior_policy: "$3,000", portal: "$3,000", required: true },
      { name: "OPCF 27", application: "$75,000", quote: "$75,000", prior_policy: "$75,000", portal: "$75,000", required: true },
      { name: "OPCF 43", application: "Yes", quote: "Yes", prior_policy: "Yes", portal: "Yes", required: true },
      { name: "Standard Accident Benefits", application: "Included", quote: "Included", prior_policy: "Included", portal: "Included", required: true },
    ],
  },
  premium: { quoted_annual: 2760, portal_annual: 2760, difference: 0, difference_percent: 0 },
  payment: { plan: "Monthly", annual_premium: 2760, tax: 0, fees: 36, total_cost: 2796, monthly_amount: 233, number_of_installments: 12, down_payment: 233 },
  field_sources: [],
  documents: documents(),
  alerts: [],
};

const clone = (value: InsuranceCase): InsuranceCase => JSON.parse(JSON.stringify(value));

function fixture(id: string, label: string, mutate: (draft: InsuranceCase) => void) {
  const draft = clone(baseAuto);
  draft.case_id = id;
  draft.label = label;
  mutate(draft);
  return draft;
}

export const mockCases: InsuranceCase[] = [
  fixture("CASE-A", "A · Ownership mismatch", (item) => {
    item.ownership!.registered_owner = "Morgan Example";
    item.field_sources.push({ field: "registered_owner", values: [{ source: "ownership", value: "Morgan Example" }, { source: "signed_application", value: "Jordan Example" }], resolved_value: null, status: "conflict" });
  }),
  fixture("CASE-B", "B · Co-insured review", (item) => {
    item.insured.name = "Morgan Example";
    item.ownership!.registered_owner = "Morgan Example";
    item.drivers[0].name = "Morgan Example";
    item.insured.co_insured = [{ name: "Taylor Example", dob: "1990-02-06", gender: "F" }];
    item.field_sources.push({ field: "co_insured", values: [{ source: "signed_application", value: "Taylor Example" }, { source: "ownership", value: null }], resolved_value: null, status: "conflict" });
  }),
  fixture("CASE-C", "C · Prior policy active", (item) => {
    item.prior_insurance.expiry_date = "2027-09-09";
    item.policy.effective_date = "2026-09-09";
    item.field_sources.push({ field: "prior_expiry", values: [{ source: "dash", value: "2027-09-09" }, { source: "signed_application", value: "2026-09-09" }], resolved_value: null, status: "conflict" });
  }),
  fixture("CASE-D", "D · Claim missing in portal", (item) => {
    item.claims[1].portal_present = false;
  }),
  fixture("CASE-E", "E · Historical claim retained", () => {}),
  fixture("CASE-F", "F · Premium discrepancy", (item) => {
    item.premium = { quoted_annual: 2760, portal_annual: 2996, difference: 236, difference_percent: 0.0855 };
    item.field_sources.push({ field: "premium", values: [{ source: "quote", value: 2760 }, { source: "portal", value: 2996 }], resolved_value: null, status: "conflict" });
  }),
  fixture("CASE-G", "G · Missing OPCF 43", (item) => {
    const row = item.coverage.comparison.find((entry) => entry.name === "OPCF 43")!;
    row.portal = "Missing";
    row.required = true;
    item.case_type = "auto_policy_change";
    item.policy_change = { requested_action: "Restore previous full coverage", vehicle_or_property: "2026 Volvo XC60 Ultra B5 AWD", vin: item.vehicles[0].vin, add: ["All Perils $1,000", "OPCF 20 $3,000", "OPCF 27 $75,000", "OPCF 43"], remove: ["Comprehensive Only"], keep: ["Liability $2M", "Standard Accident Benefits", "Uninsured Automobile", "OPCF 44R"], confirm: [] };
  }),
  fixture("CASE-I", "I · Telematics phone missing", (item) => {
    item.drivers[0].telematics.phone = "";
  }),
  fixture("CASE-J", "J · Lessor address mismatch", (item) => {
    item.vehicles[0].lessor!.address = "300 Test Street, Toronto, ON A1A 1A1";
    item.field_sources.push({ field: "lessor", values: [{ source: "ownership", value: item.ownership!.lessor }, { source: "signed_application", value: item.vehicles[0].lessor }], resolved_value: null, status: "conflict" });
  }),
  {
    ...clone(baseAuto),
    case_id: "CASE-H",
    case_type: "new_home",
    label: "H · Property insured since conflict",
    ownership: undefined,
    vehicles: [],
    drivers: [],
    policy: { ...baseAuto.policy, company: "Aviva", quote_number: "SYNTH-ID-0001", effective_date: "2026-10-01", expiry_date: "2027-10-01" },
    prior_insurance: { insurer: "CAA Insurance", policy_number: "H-92811", effective_date: "2025-10-01", expiry_date: "2026-10-01", insured_since: "2020-07-08", years_prior_insurance: 6 },
    habitational_risk: { policy_type: "Homeowner", risk_address: "200 Sample Road, Ottawa, ON A1A 1A1", occupancy: "Owner occupied / Primary residence", construction: "Brick", exterior_finish: "Fire Resistive", year_built: 2008, living_area: 2240, bedrooms: 4, bathrooms: 3, garage: "Attached double", smoke_free: true, swimming_pool: false, rental: false, airbnb: false, vacant: false },
    mortgage: { number_of_mortgages: 1, mortgagees: [{ name: "Royal Bank of Canada", address: "400 Demo Drive, Toronto, ON A1A 1A1" }] },
    coverage: { endorsements: [], comparison: [{ name: "Dwelling", application: "$850,000", quote: "$850,000", prior_policy: "$790,000", portal: "$850,000", required: true }, { name: "Liability", application: "$2M", quote: "$2M", prior_policy: "$2M", portal: "$2M", required: true }, { name: "Sewer Backup", application: "$50,000", quote: "$50,000", prior_policy: "$50,000", portal: "$50,000", required: true }, { name: "Overland Water", application: "Included", quote: "Included", prior_policy: "Included", portal: "Included", required: true }] },
    field_sources: [{ field: "property_insured_since", values: [{ source: "quote", value: "2020-07-08" }, { source: "signed_application", value: "2020-09-12" }, { source: "previous_policy", value: "2020-07-08" }], resolved_value: null, status: "conflict" }],
    documents: [
      { id: "hab-app", name: "Signed Application", category: "signed_application", required: true, received: true },
      { id: "hab-quote", name: "Quote", category: "quote", required: true, received: true },
      { id: "hab-prev", name: "Previous Policy", category: "previous_policy", required: false, received: true },
      { id: "hab-mort", name: "Mortgage Information", category: "mortgage_document", required: false, received: true },
      { id: "hab-void", name: "Void Cheque", category: "void_cheque", required: false, received: false },
    ],
  },
];

export const defaultCase = mockCases[5];

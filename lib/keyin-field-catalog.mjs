/**
 * BrokerDesk reviewed Key-in field catalog, 2026-10-22 MVP.
 *
 * The catalog defines input/display order, NOT insurer underwriting eligibility.
 * This first set deliberately includes common Auto/Home/Change Key-in fields; the
 * insurer-specific field coverage matrix remains a separate release gate.
 */
export const KEYIN_CATALOG_VERSION = "2026-10-22-v1.3";

const val = (v) => v === undefined ? null : v;
const text = (section, id, label, value, required = true, opts = {}) => ({
  id, section, label, value: val(value), required, type: opts.type ?? "text",
  entityId: opts.entityId ?? null, evidence: [], source: "CASE_UNVERIFIED", conflict: false
});
const number = (section, id, label, value, required = true, opts = {}) =>
  text(section, id, label, value, required, { ...opts, type: "number" });
const bool = (section, id, label, value, required = true, opts = {}) =>
  text(section, id, label, value, required, { ...opts, type: "boolean" });
const entry = (prefix, key) => `${prefix}.${key}`;

export const AUTO_SECTIONS = [
  ["policy", "Policy / Insured"],
  ["drivers", "Drivers"],
  ["vehicles", "Vehicles / Driver Assignments / Garaging"],
  ["coverage", "Vehicle Coverage / OPCF / Quote Discounts"],
  ["history", "MVR / DASH / Prior Insurance"],
  ["documents", "Payment / Documents"],
  ["final", "Final Submission"]
];
export const HOME_SECTIONS = [
  ["policy", "Policy / Insured"],
  ["property", "Property"],
  ["building", "Building Details"],
  ["coverage", "Risk / Coverage / Quote Discounts"],
  ["history", "Claims / Prior Insurance"],
  ["documents", "Payment / Documents"],
  ["final", "Final Submission"]
];
export const CHANGE_SECTIONS = [
  ["policy", "Current Policy"],
  ["changes", "Requested Changes / Before -> After"],
  ["remarks", "UW Remarks"],
  ["documents", "Authorization / Documents"],
  ["final", "Final Submission"]
];

function policyRows(item, policyChange = false) {
  const policy = item.policy ?? {}, insured = item.insured ?? {};
  return [
    text("policy", "policy.insurer", "Company", policy.company),
    text("policy", "policy.insured", "Named Insured", insured.name),
    text("policy", "policy.coInsured", "Co-insured",
      (insured.co_insured ?? []).map(person => person.name).filter(Boolean), false, { type: "list" }),
    text("policy", "policy.number", "Policy #", policy.policy_number, policyChange),
    text("policy", "policy.quoteNumber", "Quote #",
      policy.auto_quote_number || policy.hab_quote_number || policy.quote_number, !policyChange),
    text("policy", "policy.effectiveDate", "Effective Date", policy.effective_date, !policyChange, { type: "date" }),
    text("policy", "policy.mailingAddress", "Mailing Address", policy.mailing_address, !policyChange),
    text("policy", "policy.riskAddress", "Risk Address", policy.risk_address, false),
  ];
}
function documentRows(item, opts, section = "documents") {
  const docs = (item.documents ?? []).filter(document => document.required);
  const fields = docs.map(document =>
    bool(section, `document:${document.id}.received`, `${document.category}: ${document.name}`,
      document.received === true, true, {entityId: document.id}));
  if (opts.paymentRequired) {
    fields.unshift(text(section, "payment.plan", "Payment Plan", item.payment?.plan));
  }
  return fields;
}
function addQuoteDiscounts(fields, opts, section = "coverage") {
  const seen = new Set();
  for (const discount of opts.quoteDiscounts ?? []) {
    const identity = String(discount.id ?? discount.name ?? "").trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    fields.push(bool(section, `quoteDiscount:${identity}.selected`,
      `Quote Discount: ${discount.name ?? identity}`, discount.selected));
    if (discount.evidenceRequired === true) {
      fields.push(bool(section, `quoteDiscount:${identity}.evidencePresent`,
        `Evidence Present: ${discount.name ?? identity}`, discount.evidencePresent));
    }
  }
  fields.push(bool(section, "quoteDiscounts.checkedAgainstQuote",
    "All discounts shown on the Quote have been checked", opts.quoteDiscountsChecked ?? false));
}
function reports(fields, opts, item, section = "history") {
  const identified=new Map((opts.reports??[]).map(r=>[`${r.type}:${r.id}`,r]));
  // A supplied MVR/DASH is not silently skipped when text parsing fails.
  for (const doc of item.documents??[]) {
    if ((doc.category==="mvr"||doc.category==="dash")&&doc.received===true &&
        !identified.has(`${doc.category}:${doc.id}`) &&
        !(opts.reportCategoriesPresent??[]).includes(doc.category))
      identified.set(`${doc.category}:${doc.id}`,{type:doc.category,id:doc.id,
        pulledDate:null,summary:null});
  }
  for (const report of identified.values()) {
    if (!["mvr", "dash"].includes(report.type)) continue;
    if (!report.id) continue;
    const id = `report:${report.type}:${report.id}`;
    fields.push(text(section, `${id}.pulledDate`,
      `${report.type.toUpperCase()} Pulled Date`, report.pulledDate, true,
      { type: "date", entityId: report.id }));
    fields.push(text(section, `${id}.summary`,
      `${report.type.toUpperCase()} Convictions / Claims`, report.summary, true,
      { type: "record", entityId: report.id }));
  }
}
function prior(fields, item, section = "history") {
  const p = item.prior_insurance ?? {};
  fields.push(text(section, "prior.insurer", "Most Recent Prior Insurer", p.insurer, false));
  fields.push(text(section, "prior.policyNumber", "Prior Policy #", p.policy_number, false));
  fields.push(text(section, "prior.start", "Prior Start Date", p.effective_date, false, {type:"date"}));
  fields.push(text(section, "prior.end", "Prior End Date", p.expiry_date, false, {type:"date"}));
  fields.push(text(section, "prior.continuous", "Continuous Insurance",
    p.continuous_insurance ?? null, false));
}
function addAutoRows(item, opts) {
  const fields = policyRows(item);
  const drivers = item.drivers ?? [];
  if (!drivers.length) fields.push(text("drivers", "drivers.addDriver",
    "Add driver(s) before confirming", null));
  drivers.forEach((driver, index) => {
    const identifier = driver.id || driver.licence_number || `unresolved-${index+1}`;
    const key = `driver:${identifier}`;
    const extra = { entityId: identifier };
    const rows = [
      ["name", "Name", driver.name],
      ["dob", "DOB", driver.dob],
      ["licenceNumber", "Licence Number", driver.licence_number],
      ["licenceClass", "Licence Class", driver.licence_class],
      ["licenceProvince", "Licence Province", driver.licence_province],
      ["relationship", "Relationship", driver.relationship],
      ["maritalStatus", "Marital Status", driver.marital_status],
      ["g1Date", "G1 Date", driver.g1_date],
      ["g2Date", "G2 Date", driver.g2_date],
      ["gDate", "G Date", driver.g_date],
      ["licenceStatus", "Licence Status", driver.licence_status]
    ];
    rows.forEach(([keyName,label,value]) => fields.push(
      text("drivers", entry(key,keyName), `${driver.name || `Driver ${index+1}`} · ${label}`,
        value, ["name","licenceNumber","licenceClass"].includes(keyName), extra)));
  });
  const vehicles = item.vehicles ?? [];
  if (!vehicles.length) fields.push(text("vehicles", "vehicles.addVehicle",
    "Add vehicle(s) before confirming", null));
  vehicles.forEach((v,index)=>{
    const identifier = v.id || v.vin || `unresolved-${index+1}`;
    const key = `vehicle:${identifier}`, extra = { entityId: identifier };
    const label = v.vin || `Vehicle ${index+1}`;
    for (const [name,title,value,required] of [
      ["year","Year",v.year,true],["make","Make",v.make,true],["model","Model",v.model,true],
      ["vin","VIN",v.vin,true],["use","Vehicle Use",v.primary_use,true],
      ["condition","New / Used",v.purchase_condition,false],
      ["annualKm","Annual KM",v.annual_km,true],
      ["commute","Commute",opts.commuteByVehicle?.[identifier] ?? null,true],
      ["commuteOneWayKm","Commute One-way KM",v.commute_km,
        opts.commuteByVehicle?.[identifier] === true],
      ["winterTires","Winter Tires",v.winter_tires,false],
      ["leased","Leased",v.ownership?.leased ?? v.leased,false],
      ["lienholder","Lienholder",v.lienholder?.name || v.ownership?.lienholder?.name,false],
      ["lessor","Lessor",v.lessor?.name || v.ownership?.lessor?.name,false],
      ["purchaseDate","Purchase Date",v.purchase_date,false],
      ["parkingSameAsMailing","Garaging = Mailing Address",
        opts.garagingSameMailByVehicle?.[identifier] ?? null,true],
      ["garagingAddress","Garaging Address",v.garaging_address,
        opts.garagingSameMailByVehicle?.[identifier] === false],
      ["driverAssignments","Assigned Driver -> Role",
        opts.driverAssignmentsByVehicle?.[identifier] ?? null,true],
    ]) {
      const kind = ["annualKm","commuteOneWayKm","year"].includes(name) ? "number" :
        ["commute","winterTires","leased","parkingSameAsMailing"].includes(name) ? "boolean" :
        name === "driverAssignments" ? "assignments" : "text";
      fields.push(text("vehicles", entry(key,name), `${label} · ${title}`, value, required,
        { ...extra, type: kind }));
    }
    const coverage = opts.coverageByVehicle?.[identifier] ?? {};
    const base = [
      ["liability", "Liability", coverage.liability, "number"],
      ["allPerils.present", "All Perils", coverage.allPerils?.present, "boolean"],
      ["collision.present", "Collision", coverage.collision?.present, "boolean"],
      ["comprehensive.present", "Comprehensive", coverage.comprehensive?.present, "boolean"],
      ["opcf", "Selected OPCF", coverage.opcf, "list"],
      ["opcf44", "OPCF 44 / 44R", coverage.opcf44, "boolean"]
    ];
    for (const [name,title,value,type] of base) fields.push(
      text("coverage", entry(key,name), `${label} · ${title}`, value,
        name !== "opcf44", { ...extra, type }));
    // Always retain deductible IDs so enabling coverage later never bypasses
    // a newly required deductible. The UI hides an inactive deductible row.
    for (const [name,title] of [["allPerils","All Perils"],["collision","Collision"],
      ["comprehensive","Comprehensive"]]) {
      fields.push(number("coverage", entry(key,`${name}.deductible`),
        `${label} · ${title} Deductible`, coverage[name]?.deductible ?? null,
        coverage[name]?.present === true, extra));
    }
  });
  addQuoteDiscounts(fields,opts);
  reports(fields,opts,item);
  prior(fields,item);
  fields.push(text("history", "claims.list", "Claims / DASH Details",
    item.claims?.length ? item.claims : null, false, { type: "record" }));
  fields.push(...documentRows(item,opts,"documents"));
  return fields;
}
function addHomeRows(item,opts) {
  const fields = policyRows(item);
  const h = item.habitational_risk ?? {};
  const details = [
    ["property","riskAddress","Risk Address",h.risk_address,true],
    ["property","occupancy","Occupancy",h.occupancy,true],
    ["property","yearBuilt","Year Built",h.year_built,true],
    ["property","structure","Structure",h.structure,true],
    ["property","construction","Construction",h.construction,true],
    ["property","units","Units",h.units,false],
    ["property","families","Families",h.families,false],
    ["property","livingArea","Living Area",h.living_area,true],
    ["building","roof","Roof",h.roof,true],
    ["building","roofYear","Roof Year",opts.homeExtras?.roofYear ?? null,false],
    ["building","plumbing","Plumbing",h.plumbing,true],
    ["building","plumbingYear","Plumbing Year",opts.homeExtras?.plumbingYear ?? null,false],
    ["building","electrical","Electrical",h.electrical,true],
    ["building","electricalYear","Electrical Year",opts.homeExtras?.electricalYear ?? null,false],
    ["building","electricalPanel","Electrical Panel",opts.homeExtras?.electricalPanel ?? null,false],
    ["building","heating","Heating",h.heating,true],
    ["building","heatingYear","Heating Year",opts.homeExtras?.heatingYear ?? null,false],
    ["building","basementArea","Basement Area",h.basement_area,false],
    ["building","garage","Garage",h.garage,false],
    ["building","bathrooms","Bathrooms",h.bathrooms,false],
    ["coverage","dogAnimal","Animals",h.dog_animal_exposure,false],
    ["coverage","rental","Rental",h.rental,false],
    ["coverage","businessUse","Business Use",h.business_use,false],
    ["coverage","coverage","Coverage / Limits",opts.homeCoverage ?? null,true]
  ];
  for (const [section,name,label,value,required] of details) {
    const isNum = ["yearBuilt","livingArea","basementArea","units","families"].includes(name);
    fields.push(text(section,`home.${name}`,label,value,required,{type:isNum?"number":"text"}));
  }
  addQuoteDiscounts(fields,opts);
  reports(fields,opts,item);
  prior(fields,item);
  fields.push(text("history","claims.list","Claim Details",item.claims?.length?item.claims:null,false,{type:"record"}));
  fields.push(...documentRows(item,opts));
  return fields;
}
function addChangeRows(item,opts) {
  const fields = policyRows(item,true);
  const change = item.policy_change ?? {};
  fields.push(text("changes","change.effectiveDate","Effective Date",
    change.change_effective_date||change.requested_effective_date,null,{type:"date"}));
  fields[fields.length-1].required=true;
  const updates = change.requested_changes ?? [];
  if (!updates.length) fields.push(text("changes","changes.addChange","Requested Change",null));
  updates.forEach((change,index)=>{
    const id = change.id || `item-${index+1}`, prefix=`change:${id}`;
    for (const [key,label,value,required] of [
      ["type","Action",change.type,true],
      ["subject","Affected Object",change.subject_name || change.subject_id,true],
      ["before","Before",change.previous_value,false],
      ["after","After",change.new_value,true],
      ["date","Effective Date",change.effective_date || item.policy_change?.change_effective_date,true]
    ]) fields.push(text("changes",entry(prefix,key),`${id} · ${label}`,value,required));
  });
  fields.push(text("remarks","remarks.text","UW Remarks",opts.remarksText ??
    item.policy_change?.notes ?? null,true,{type:"multiline"}));
  fields.push(...documentRows(item,opts));
  return fields;
}
export function buildKeyinCatalog(item, options = {}) {
  const supported = new Set(["new_auto", "new_home", "auto_policy_change", "home_policy_change"]);
  if (!supported.has(item?.case_type))
    throw new Error(`Key-in catalog does not support case type: ${String(item?.case_type)}`);
  const change = ["auto_policy_change","home_policy_change"].includes(item.case_type);
  const auto = item.case_type === "new_auto";
  const sections = (change ? CHANGE_SECTIONS : auto ? AUTO_SECTIONS : HOME_SECTIONS)
    .map(([id,title])=>({id,title,status:"PENDING",confirmation:null}));
  const fields = change ? addChangeRows(item,options) :
    auto ? addAutoRows(item,options) : addHomeRows(item,options);
  const ids=new Set();
  for (const field of fields) {
    if (ids.has(field.id)) throw new Error(`Duplicate Key-in field ID: ${field.id}`);
    ids.add(field.id);
  }
  return { sections, fields };
}

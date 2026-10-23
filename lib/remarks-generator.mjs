/**
 * BrokerDesk policy change Remarks generator, schema v1.
 *
 * Pure JavaScript so it can run both in the local Node server and the React UI.
 * It deliberately does NOT use an LLM or fill unidentified fields by guessing.
 * All insurance values must come from a Broker-reviewed record.
 */
export const REMARKS_RULE_VERSION = "2026-10-22-v1.3";
export const PEMBRIDGE_REMARKS_LIMIT = 460;

const has = value => value !== undefined && value !== null &&
  (typeof value !== "string" || value.trim() !== "");
const clean = value => String(value ?? "").replace(/[\r\n\t]+/g, " ")
  .replace(/\s+/g, " ").trim();
const capitalize = text => text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
const permit = (value, allowed) => allowed.includes(value) ? value : null;

export function remarksLimit(company) {
  return /\bPEMBRIDGE\b/i.test(String(company ?? "")) ? PEMBRIDGE_REMARKS_LIMIT : null;
}

/** Counts actual characters in the copied string, including punctuation and line breaks.
 * Uses UTF-16 code units (conservative for non-BMP characters); no visual-only count.
 */
export function remarksCharacterCount(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").length;
}
export function validateRemarks(text, company, options = {}) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n");
  const limit = remarksLimit(company);
  const characters = remarksCharacterCount(value);
  const errors = [];
  if (!value.trim()) errors.push("Remarks are required.");
  if (/^\s*[-*]\s/m.test(value) || /\*\*/.test(value))
    errors.push("Remarks must be plain text without Markdown bullets or bold markers.");
  if (limit !== null && characters > limit)
    errors.push(`Pembridge Remarks exceed ${limit} characters (${characters}).`);
  if (/\[(?:[^\]]+)\]/.test(value))
    errors.push("Unresolved square-bracket placeholders must be replaced.");
  if (options.requireComplete && /\bPlease\s*(?:$|\n\s*Effective date:)/i.test(value))
    errors.push("Describe the requested change before confirming Remarks.");
  return { valid: errors.length === 0, errors, characters, limit,
    remaining: limit === null ? null : limit - characters };
}

function isoDate(input) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input ?? ""))) return null;
  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day) return null;
  return date;
}
export function remarksDate(iso) {
  const date = isoDate(iso);
  return date ? date.toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC"
  }) : null;
}
const money = number => {
  if (typeof number === "number" && Number.isFinite(number)) {
    return number >= 1000000 && number % 1000000 === 0
      ? `$${number / 1000000}M`
      : `$${number.toLocaleString("en-CA", { maximumFractionDigits: 2 })}`;
  }
  return has(number) ? clean(number) : "";
};
const yes = (value, field, missing) => {
  if (typeof value !== "boolean") { missing.push(field); return false; }
  return value;
};
const validVin = vin => /^[A-HJ-NPR-Z0-9]{17}$/i.test(clean(vin).replace(/[\s-]/g, ""));
const vehicleLabel = (vehicle, prefix, missing) => {
  for (const prop of ["year", "make", "model", "vin"])
    if (!has(vehicle?.[prop])) missing.push(`${prefix}.${prop}`);
  if (has(vehicle?.vin) && !validVin(vehicle.vin))
    missing.push(`${prefix}.vin (invalid 17-character VIN)`);
  const year = has(vehicle?.year) ? clean(vehicle.year) + " " : "";
  const make = has(vehicle?.make) ? clean(vehicle.make) + " " : "";
  const model = has(vehicle?.model) ? clean(vehicle.model) : "";
  return `${year}${make}${model}, VIN ${clean(vehicle?.vin)}`.trim();
};
const kmNumber = (value, label, missing) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    missing.push(label);
    return "";
  }
  return `${value.toLocaleString("en-CA", { maximumFractionDigits: 1 })} km`;
};
const coverageText = (coverage, missing, compact) => {
  if (!coverage || !has(coverage.liability))
    missing.push("addedVehicle.coverage.liability");
  const bits = [];
  if (has(coverage?.liability)) bits.push(`liability ${money(coverage.liability)}`);
  for (const [key, title] of [
    ["allPerils", "All Perils"], ["collision", "Collision"], ["comprehensive", "Comprehensive"]
  ]) {
    const item = coverage?.[key];
    if (item?.present === true) {
      if (!Number.isFinite(item.deductible) || item.deductible < 0)
        missing.push(`addedVehicle.coverage.${key}.deductible`);
      else bits.push(`${title} ${money(item.deductible)} deductible`);
    }
    // Every major physical-damage coverage needs an explicit Yes or No.
    // Absence of a coverage object must never be interpreted as No.
    if (!item || (item.present !== true && item.present !== false))
      missing.push(`addedVehicle.coverage.${key}.present`);
  }
  if (!Array.isArray(coverage?.opcf))
    missing.push("addedVehicle.coverage.opcf");
  else if (coverage.opcf.length)
    bits.push("OPCF " + [...new Set(coverage.opcf.map(v => clean(v).replace(/^OPCF\s*/i, ""))
      .filter(Boolean))].join(", "));
  return compact ? bits.join(", ") : "Coverage: " + bits.join(", ");
};
function vehicleAddText(v, compact, missing) {
  if (!v || typeof v !== "object") {
    missing.push("addedVehicle");
    return "";
  }
  const label = vehicleLabel(v, "addedVehicle", missing);
  if (!has(v.use)) missing.push("addedVehicle.use");
  const category = permit(clean(v.use).toLowerCase(), ["pleasure", "commute", "business"]);
  if (!category) missing.push("addedVehicle.use (Pleasure/Commute/Business)");
  const annual = kmNumber(v.annualKm, "addedVehicle.annualKm", missing);
  const commute = yes(v.commute, "addedVehicle.commute", missing);
  const distance = commute ? kmNumber(v.commuteOneWayKm, "addedVehicle.commuteOneWayKm", missing) : "";
  const use = category ? `${category} use` : "";
  const driving = [use, commute ? `one-way commute ${distance}` : "no commute", `annual ${annual}`]
    .filter(Boolean).join(", ");
  const tenure = v.lessor?.name ? `Lessor: ${clean(v.lessor.name)}.` :
    v.lienholder?.name ? `Lienholder: ${clean(v.lienholder.name)}.` : "";
  const condition = has(v.condition) ? `${clean(v.condition)} vehicle.` : "";
  const cover = coverageText(v.coverage, missing, compact);
  const winter = v.winterTires === true ? (v.winterTireReceiptToFollow ?
    "Winter tires installed; receipt to follow." : "Winter tires installed.") : "";
  const first = compact ? `please add ${label}.` : `please add vehicle ${label}.`;
  return [first, condition, driving ? `${capitalize(driving)}.` : "", tenure,
    `${cover}.`, winter].filter(Boolean).join(" ");
}
function vehicleRemoveText(v, missing, compact) {
  if (!v) { missing.push("removedVehicle"); return ""; }
  const label = vehicleLabel(v, "removedVehicle", missing);
  const reason = has(v.reason) ? ` (${clean(v.reason)})` : "";
  return `${compact ? "Remove" : "Please remove vehicle"} ${label}${reason}.`;
}
function addDriverText(d, missing) {
  if (!has(d?.name)) missing.push("driver.name");
  if (!has(d?.licenceNumber)) missing.push("driver.licenceNumber");
  let text = `please add driver ${clean(d?.name)}, licence #${clean(d?.licenceNumber)}`;
  if (has(d?.relationship)) text += ` (${clean(d.relationship)})`;
  const claims = Array.isArray(d?.claims) ? d.claims : [];
  const convictions = Array.isArray(d?.convictions) ? d.convictions : [];
  if (claims.length) text += `; ${claims.length} claim(s): ${claims.map(c =>
    remarksDate(c.lossDate) ?? clean(c.lossDate)).join(", ")}`;
  if (convictions.length) text += `; ${convictions.length} conviction(s): ${convictions.map(c =>
    [remarksDate(c.offenceDate) ?? clean(c.offenceDate), clean(c.description)]
      .filter(Boolean).join(" ")).join(", ")}`;
  return text + ".";
}
function addressText(input, missing) {
  const types = [];
  if (input?.mailing) types.push("mailing");
  if (input?.risk) types.push("risk");
  if (!types.length) missing.push("addressChange.addressType");
  if (!has(input?.newAddress)) missing.push("addressChange.newAddress");
  return `please change the insured's ${types.join(" and ")} address to ${clean(input?.newAddress)}.`;
}
function cancellationText(input, missing) {
  const kind = permit(input?.type, ["FLAT", "SHORT_RATE", "PRO_RATA", "UW_EXCEPTION"]);
  if (!kind) missing.push("cancellation.type");
  const descriptions = {
    FLAT: "flat cancel", SHORT_RATE: "short-rate cancel",
    PRO_RATA: "pro-rata cancel", UW_EXCEPTION: "cancel per UW-approved exception"
  };
  return `please ${descriptions[kind] ?? "cancel"} this policy${has(input?.reason) ?
    `; reason: ${clean(input.reason)}` : ""}.`;
}
const automatic = new Set([
  "VEHICLE_SUBSTITUTION", "ADD_VEHICLE", "DELETE_VEHICLE", "ADD_DRIVER",
  "ADDRESS_CHANGE", "PAYMENT_CHANGE", "CANCELLATION"
]);
const fallback = date => [
  "Hi U/W,", "As insured's request,", "Please",
  date ? `Effective date: ${date}` : "Effective date:"
].join("\n");

/**
 * Input must contain Broker-reviewed data. Never fabricate missing figures.
 * Returns a draft plus `missing`; a caller MUST disallow Broker confirmation if
 * needsManualCompletion / missing / overLimit is true.
 */
export function generateRemarks(input) {
  const company = String(input?.company ?? "");
  const compact = remarksLimit(company) !== null;
  const type = input?.type ?? "OTHER_POLICY_CHANGE";
  const date = remarksDate(input?.effectiveDate);
  const missing = [];
  if (!date) missing.push("effectiveDate");
  let instruction = "";
  if (type === "ADD_VEHICLE" || type === "VEHICLE_SUBSTITUTION") {
    instruction = vehicleAddText(input.addedVehicle, compact, missing);
    if (type === "VEHICLE_SUBSTITUTION")
      instruction += " " + vehicleRemoveText(input.removedVehicle, missing, compact);
  } else if (type === "DELETE_VEHICLE") {
    instruction = vehicleRemoveText(input.removedVehicle, missing, compact);
    instruction = instruction.replace(/^Please/, "please");
  } else if (type === "ADD_DRIVER") {
    instruction = addDriverText(input.driver, missing);
  } else if (type === "ADDRESS_CHANGE") {
    instruction = addressText(input.addressChange, missing);
  } else if (type === "PAYMENT_CHANGE") {
    // Bank numbers should not be repeated in a free-text note when the original
    // void cheque/authorization is attached.
    instruction = "please update the banking information as per the attached void cheque.";
    if (!input.voidChequeAttached) missing.push("voidChequeAttached");
  } else if (type === "CANCELLATION") {
    instruction = cancellationText(input.cancellation, missing);
  }
  const needsManualCompletion = !automatic.has(type) || missing.length > 0;
  const text = needsManualCompletion
    ? fallback(date)
    : compact
      ? `Hi U/W, As insured's request, ${instruction} Effective date: ${date}.`
      : `Hi U/W,\nAs insured's request, ${instruction}\nEffective date: ${date}.`;
  const check = validateRemarks(text, company, { requireComplete: true });
  return {
    type, text, templateId: needsManualCompletion ? "MANUAL_FALLBACK" : type,
    templateVersion: REMARKS_RULE_VERSION, missing: [...new Set(missing)],
    needsManualCompletion, overLimit: check.limit !== null && check.characters > check.limit,
    ...check, valid: check.valid && !needsManualCompletion
  };
}

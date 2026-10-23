/**
 * Step 4A form adapter: validates Broker-reviewed MVR/DASH summary edits.
 *
 * Keep unfamiliar source properties and item metadata intact; these may be used
 * by other parsers/audit views. A blank value is never treated as a clean report.
 */
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stringValue = v => v === null || v === undefined ? "" : String(v);

export function reportKind(fieldId) {
  const m = String(fieldId ?? "").match(/^report:(mvr|dash):.+\.summary$/);
  return m ? m[1] : null;
}

export function reportToForm(value, kind) {
  const src = isObject(value) ? value : {};
  const key = kind === "mvr" ? "hasConvictions" : "hasClaims";
  const list = kind === "mvr" ? "convictions" : "claims";
  const rows = Array.isArray(src[list]) ? src[list] : [];
  return {
    presence: src[key] === true ? "yes" : src[key] === false ? "no" : "",
    rows: rows.map((row,sourceIndex) => kind === "mvr" ? {
      _sourceIndex:sourceIndex,
      offenceDate: stringValue(row?.offenceDate),
      description: stringValue(row?.description),
      classification: stringValue(row?.classification),
    } : {
      _sourceIndex:sourceIndex,
      claimNumber: stringValue(row?.claimNumber),
      lossDate: stringValue(row?.lossDate),
      driver: stringValue(row?.driver),
      vehicle: stringValue(row?.vehicle),
      atFaultPercent: stringValue(row?.atFaultPercent),
    }),
  };
}

export function emptyReportRow(kind) {
  return kind === "mvr"
    ? { _sourceIndex:null, offenceDate:"", description:"", classification:"" }
    : { _sourceIndex:null, claimNumber:"", lossDate:"", driver:"", vehicle:"", atFaultPercent:"" };
}

const validDate = v => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === v;
};
const shortText = (v, max=300) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

export function formToReport(form, oldValue, kind) {
  const issues=[];
  if (kind !== "mvr" && kind !== "dash") return { value:null, issues:["Unknown report type."] };
  const source=isObject(oldValue)?oldValue:{};
  if (!form || !Array.isArray(form.rows) || form.rows.length > 100)
    return {value:null,issues:["Invalid or oversized report details."]};
  if (form.presence !== "yes" && form.presence !== "no")
    issues.push("Choose Yes or No after checking the source report. Unreadable is not No.");
  if (form.presence === "no" && form.rows.length)
    issues.push("No contradicts listed offences or claims.");
  if (form.presence === "yes" && !form.rows.length)
    issues.push("Yes requires at least one detail row.");
  const resultRows = [];
  for (const [i,r] of form.rows.entries()) {
    if (!isObject(r)) { issues.push(`Detail ${i+1} is invalid.`); continue; }
    const sourceIndex = Number.isSafeInteger(r._sourceIndex) && r._sourceIndex>=0 ? r._sourceIndex : -1;
    const oldRow = Array.isArray(source[kind==="mvr"?"convictions":"claims"]) && sourceIndex>=0
      ? source[kind==="mvr"?"convictions":"claims"][sourceIndex] : null;
    const preserved = isObject(oldRow) ? oldRow : {};
    if (kind==="mvr") {
      const offenceDate=String(r.offenceDate??"").trim();
      const description=String(r.description??"").trim();
      const classification=String(r.classification??"").trim();
      if (!validDate(offenceDate)||!shortText(description)||!shortText(classification,100))
        issues.push(`Conviction ${i+1}: enter offence date, description and classification.`);
      resultRows.push({...preserved, offenceDate, description, classification});
    } else {
      const claimNumber=String(r.claimNumber??"").trim();
      const lossDate=String(r.lossDate??"").trim();
      const driver=String(r.driver??"").trim();
      const vehicle=String(r.vehicle??"").trim();
      const faultInput=String(r.atFaultPercent??"").trim();
      const atFaultPercent=faultInput===""?NaN:Number(faultInput);
      if (!shortText(claimNumber,120)||!validDate(lossDate)||!shortText(driver,200)||
          !Number.isFinite(atFaultPercent)||atFaultPercent<0||atFaultPercent>100)
        issues.push(`Claim ${i+1}: enter claim #, loss date, driver and 0–100% at-fault.`);
      // Vehicle optional; preserve parser-specific metadata and mark only when entered.
      resultRows.push({...preserved, claimNumber, lossDate, driver,
        vehicle, atFaultPercent});
    }
  }
  if (issues.length) return {value:null,issues};
  const list=kind==="mvr"?"convictions":"claims";
  const flag=kind==="mvr"?"hasConvictions":"hasClaims";
  return {value:{...source, [flag]:form.presence==="yes", [list]:resultRows},issues:[]};
}

/**
 * Step 4B: pure, read-only projection of the imported Broker-confirmed sheet.
 *
 * - Uses the immutable v0.4 worksheet, NEVER the unreviewed Case.
 * - Keeps separate vehicles, drivers, MVR/DASH reports and change items.
 * - Does not infer zero convictions/claims, change financial values or coverage.
 * - UI grouping cannot alter the stored snapshot or its SHA-256.
 *
 * This module has no dependencies and is safe for server/client rendering.
 */
const obj = value => value !== null && typeof value === "object" && !Array.isArray(value);
const present = value => value !== null && value !== undefined && value !== "";
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key);
const objectValues = value => obj(value) ? value : {};
const text = value => {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "Not provided";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map(text).join("; ") : "None";
  return JSON.stringify(value);
};
const shorter = label => {
  const separator = " · ";
  const position = String(label).lastIndexOf(separator);
  return position >= 0 ? label.slice(position+separator.length) : label;
};
const idOf = (id,scope) => {
  const prefix=scope+":";
  if (!String(id).startsWith(prefix)) return null;
  const remainder=id.slice(prefix.length);
  const dot=remainder.indexOf(".");
  return dot > 0 ? {entityId:remainder.slice(0,dot),key:remainder.slice(dot+1)} : null;
};
const reportOf = id => {
  const match=String(id).match(/^report:(mvr|dash):(.+)\.(pulledDate|summary)$/);
  return match ? {kind:match[1],entityId:match[2],key:match[3]} : null;
};
const asRow = row => ({
  id:row.id,label:shorter(row.label),value:obj(row.originalValue)||Array.isArray(row.originalValue)
    ? text(row.originalValue) : text(row.originalValue ?? row.value),
  evidencePresent:row.evidencePresent===true
});
const newGroup=(id,title)=>({id,title,rows:[],tables:[]});
const newSection=(source,title=source.title)=>({id:source.id,title,groups:[]});
function table(id,title,columns,records) {
  return {id,title,columns,rows:records};
}
const ROLE_LABEL={
  PRINCIPAL:"Principal", SECONDARY:"Secondary", OCCASIONAL:"Occasional",
  NOT_INCLUDED_IN_RATING:"Not Included in Rating", EXCLUDED:"Excluded"
};
function addVehicleField(group,field,driverNames){
  const parsed=idOf(field.id,"vehicle");
  if(parsed?.key!=="driverAssignments" || !Array.isArray(field.originalValue)) {
    group.rows.push(asRow(field));return;
  }
  const assignments=field.originalValue;
  if (!assignments.length){ group.rows.push({
    ...asRow(field),label:"Assigned Drivers",value:"No assignments listed"
  });return; }
  const rows=assignments.map((assignment,index)=>{
    const id=String(assignment?.driverId??"");
    return {
      id:`${field.id}:${index}`,
      values:[
        driverNames.get(id) || (id ? `Driver ID: ${id}` : "Unidentified driver"),
        ROLE_LABEL[String(assignment?.role)]||text(assignment?.role)
      ]
    };
  });
  group.tables.push(table(`${field.id}:roles`,"Assigned Drivers",["Driver","Role"],rows));
}
function groupedVehicleSections(source,coverage,driverNames) {
  const map=new Map();
  const otherVehicle=[],otherCoverage=[],discounts=[];
  const get=(id)=>{
    if (!map.has(id))map.set(id,{id,rows:[],byKey:new Map(),group:newGroup(`vehicle:${id}`,`Vehicle · ${id}`)});
    return map.get(id);
  };
  for (const field of source?.rows??[]) {
    const parsed=idOf(field.id,"vehicle");
    if(!parsed){otherVehicle.push(field);continue;}
    const record=get(parsed.entityId);
    record.rows.push(field);
    record.byKey.set(parsed.key,field.originalValue);
  }
  for(const field of coverage?.rows??[]) {
    const parsed=idOf(field.id,"vehicle");
    if(parsed){get(parsed.entityId).rows.push(field);continue;}
    if(field.id.startsWith("quoteDiscount:") || field.id.startsWith("quoteDiscounts."))
      discounts.push(field);
    else otherCoverage.push(field);
  }
  const groups=[];
  for(const [id,record] of map){
    const val=k=>present(record.byKey.get(k))?String(record.byKey.get(k)):"";
    const identity=[val("year"),val("make"),val("model")].filter(Boolean).join(" ");
    const vin=val("vin");
    record.group.title=identity
      ? `${identity}${vin ? ` · ${vin}` : ""}`
      : (vin || `Vehicle · ${id}`);
    const seen=new Set();
    for(const field of record.rows){
      if(seen.has(field.id))continue;
      seen.add(field.id);
      // Do not present inactive deductible as an unexplained missing charge.
      if(/^(allPerils|collision|comprehensive)\.deductible$/.test(idOf(field.id,"vehicle")?.key??"")){
        const coverageKey=idOf(field.id,"vehicle").key.split(".")[0];
        const active=record.rows.find(r=>r.id===`vehicle:${id}.${coverageKey}.present`);
        if(active?.originalValue===false)continue;
      }
      addVehicleField(record.group,field,driverNames);
    }
    groups.push(record.group);
  }
  if(otherVehicle.length){
    const g=newGroup("vehicles:other","Other Vehicle Fields");
    g.rows=otherVehicle.map(asRow);groups.push(g);
  }
  const coverageGroups=[];
  if(otherCoverage.length){
    const g=newGroup("coverage:other","Other Coverage");
    g.rows=otherCoverage.map(asRow);coverageGroups.push(g);
  }
  if(discounts.length){
    const g=newGroup("coverage:discounts","Discounts Shown on Quote");
    g.rows=discounts.map(asRow);coverageGroups.push(g);
  }
  return {vehicles:groups,coverage:coverageGroups};
}
function driverGroups(section) {
  const map=new Map(),other=[];
  for(const row of section.rows){
    const parsed=idOf(row.id,"driver");
    if(!parsed){other.push(row);continue;}
    if(!map.has(parsed.entityId))map.set(parsed.entityId,newGroup(
      `driver:${parsed.entityId}`,`Driver · ${parsed.entityId}`));
    const group=map.get(parsed.entityId);
    if(parsed.key==="name" && present(row.originalValue))group.title=String(row.originalValue);
    group.rows.push(asRow(row));
  }
  const groups=[...map.values()];
  if(other.length){const g=newGroup("drivers:other","Other Driver Information");g.rows=other.map(asRow);groups.push(g);}
  return groups;
}
function reportGroups(history) {
  const map=new Map(),prior=[],claims=[],other=[];
  for(const field of history.rows){
    const p=reportOf(field.id);
    if(p){
      const key=`${p.kind}:${p.entityId}`;
      if(!map.has(key))map.set(key,{kind:p.kind,id:p.entityId,values:new Map()});
      map.get(key).values.set(p.key,field);
    } else if(field.id.startsWith("prior."))prior.push(field);
    else if(field.id==="claims.list")claims.push(field);
    else other.push(field);
  }
  const groups=[];
  for(const [key,report] of map){
    const g=newGroup(`report:${key}`,`${report.kind.toUpperCase()} · ${report.id}`);
    const date=report.values.get("pulledDate");
    g.rows.push({
      id:`report:${key}:date`,label:"Pulled Date",
      value:date ? text(date.originalValue ?? date.value) : "Not provided",
      evidencePresent:date?.evidencePresent===true
    });
    const summary=report.values.get("summary");
    const value=objectValues(summary?.originalValue);
    const flag=report.kind==="mvr"?"hasConvictions":"hasClaims";
    const list=report.kind==="mvr"?"convictions":"claims";
    g.rows.push({
      id:`report:${key}:presence`,
      label:report.kind==="mvr"?"Convictions":"Claims",
      // Missing or unparsable is never the same as No.
      value:typeof value[flag]==="boolean"?(value[flag]?"Yes":"No"):"Not provided",
      evidencePresent:summary?.evidencePresent===true
    });
    if(Array.isArray(value[list]) && value[list].length>0){
      if(value[flag]!==true){
        g.rows.push({
          id:`report:${key}:conflict`,label:"Report Conflict",
          value:"Detail records exist but the report is not marked Yes",
          evidencePresent:summary?.evidencePresent===true
        });
      }
      const baseFields=report.kind==="mvr"?
        [["offenceDate","Offence Date"],["description","Description"],["classification","Classification"]] :
        [["claimNumber","Claim #"],["lossDate","Loss Date"],["driver","Driver"],
         ["vehicle","Vehicle"],["atFaultPercent","At-Fault"]];
      // Preserve source-specific attributes (e.g., report perspective / amount)
      // rather than silently dropping extra fact columns.
      const extraKeys=[...new Set(value[list].flatMap(r=>Object.keys(objectValues(r))))]
        .filter(k=>!baseFields.some(([known])=>known===k) &&
                   !["sourceIndex","_sourceIndex"].includes(k));
      const keys=[...baseFields.map(([k])=>k),...extraKeys];
      const cols=[...baseFields.map(([,label])=>label),
        ...extraKeys.map(k=>{
          const label=k.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/_/g," ");
          return label.charAt(0).toUpperCase()+label.slice(1);
        })];
      const items=value[list].map((r,index)=>{
        const record=objectValues(r);
        return {id:`report:${key}:detail:${index}`,values:keys.map(k=>
          k==="atFaultPercent" && typeof record[k]==="number" ?
            `${record[k]}%` : text(record[k])
        )};
      });
      g.tables.push(table(`report:${key}:details`,report.kind==="mvr"?"Conviction Details":"Claim Details",cols,items));
    } else if(value[flag]===true) {
      g.rows.push({id:`report:${key}:missing-details`,label:"Details",value:"Not provided",
        evidencePresent:false});
    }
    groups.push(g);
  }
  if(claims.length){
    const g=newGroup("history:claims","Other Claims on Case");
    for(const row of claims) {
      if(!Array.isArray(row.originalValue) || !row.originalValue.length) {
        g.rows.push(asRow(row));continue;
      }
      for(const [index,c] of row.originalValue.entries()){
        if(!obj(c)){g.rows.push({id:`${row.id}:${index}`,label:`Claim ${index+1}`,value:text(c),
          evidencePresent:row.evidencePresent===true});continue;}
        const columns=Object.keys(c);
        g.tables.push(table(`${row.id}:${index}`,`Claim ${index+1}`,
          columns.map(k=>k.replace(/_/g," ")),[
            {id:`${row.id}:${index}:data`,values:columns.map(k=>text(c[k]))}
          ]));
      }
    }
    groups.push(g);
  }
  if(prior.length){
    const g=newGroup("history:prior","Most Recent Prior Insurance");
    g.rows=prior.map(asRow);groups.push(g);
  }
  if(other.length){
    const g=newGroup("history:other","Other History Information");
    g.rows=other.map(asRow);groups.push(g);
  }
  return groups;
}
function changeGroups(section) {
  const map=new Map(),other=[];
  for(const field of section.rows){
    const parsed=idOf(field.id,"change");
    if(!parsed){other.push(field);continue;}
    if(!map.has(parsed.entityId))map.set(parsed.entityId,newGroup(
      `change:${parsed.entityId}`,`Change · ${parsed.entityId}`));
    const group=map.get(parsed.entityId);
    group.rows.push(asRow(field));
  }
  const groups=[...map.values()];
  for(const g of groups){
    const action=g.rows.find(r=>r.id===`${g.id}.type`);
    const subject=g.rows.find(r=>r.id===`${g.id}.subject`);
    if(action) g.title=[action.value,subject?.value].filter(x=>x&&x!=="Not provided").join(" — ");
  }
  if(other.length){const g=newGroup("changes:other","Change Effective Date");g.rows=other.map(asRow);groups.unshift(g);}
  return groups;
}
function genericGroups(section) {
  const g=newGroup(`${section.id}:fields`,"Details");
  g.rows=section.rows.map(row=>{
    // Preserve the entire manual Remarks string, including line breaks;
    // we do not add Markdown or bullet formatting.
    if(row.id==="remarks.text")return {
      ...asRow(row),label:"UW Remarks",
      value:typeof row.originalValue==="string"?row.originalValue:text(row.originalValue??row.value)
    };
    return asRow(row);
  });
  return [g];
}
/** Builds presentation-only sections in canonical broker review order. */
export function buildStructuredAuditorSheet(sheet) {
  if(!sheet || sheet.brokerReview!=="BROKER_CONFIRMED" || !Array.isArray(sheet.sections))
    throw new Error("Structured Auditor view requires a Broker-confirmed worksheet.");
  const sources=sheet.sections;
  const find=id=>sources.find(section=>section.id===id);
  const names=new Map();
  for(const field of find("drivers")?.rows??[]){
    const p=idOf(field.id,"driver");
    if(p?.key==="name" && present(field.originalValue))
      names.set(p.entityId,String(field.originalValue));
  }
  const vehicles=groupedVehicleSections(find("vehicles"),find("coverage"),names);
  const result=[];
  for(const section of sources){
    const view=newSection(section,
      section.id==="vehicles"?"Vehicles / Assigned Drivers / Coverage":section.title);
    if(section.id==="vehicles") view.groups=vehicles.vehicles;
    else if(section.id==="coverage" && find("vehicles"))
      view.groups=vehicles.coverage;
    else if(section.id==="drivers")view.groups=driverGroups(section);
    else if(section.id==="history")view.groups=reportGroups(section);
    else if(section.id==="changes")view.groups=changeGroups(section);
    else view.groups=genericGroups(section);
    if(view.groups.length)result.push(view);
  }
  // A malformed catalog without a vehicles section must not silently hide
  // vehicle coverage rows.
  return {sourceReviewHash:sheet.sourceReviewHash,sections:result};
}
export function structuredGroupText(group) {
  const lines=[group.title];
  for(const row of group.rows)lines.push(`${row.label}: ${row.value}`);
  for(const t of group.tables){
    lines.push(t.title, t.columns.join(" | "));
    for(const row of t.rows)lines.push(row.values.join(" | "));
  }
  return lines.join("\n");
}
export function structuredSectionText(section) {
  return [section.title,...section.groups.map(structuredGroupText)].join("\n\n");
}
export function structuredSheetText(view) {
  return view.sections.map(structuredSectionText).join("\n\n");
}

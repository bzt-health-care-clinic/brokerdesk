import type { DocumentType, ExtractionWarning, FieldEvidence, ParsedEntity, ParsedSource, RawExtractedDocument } from './extraction-types.ts';
import { evidenceOf, joinCells, layoutCells, templateDate, type LayoutCell } from './layout-reader.ts';

type Target = { data: Record<string, unknown>; fieldEvidence: Record<string, FieldEvidence[]>; warnings: ExtractionWarning[] };
type IndexedPage = { page: number; width: number; height: number; cells: LayoutCell[]; ocr: boolean };
const confidenceFloor = (page: IndexedPage) => page.ocr ? .95 : .9;
const normal = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
const compact = (text: string) => normal(text).toUpperCase().replace(/[^A-Z0-9]/g, '');
const isLabel = (text: string) => /^(?:NAME|ADDRESS|YEAR|MONTH|DAY|POSTAL|DATE|INSURED|POLICY|BROKER|CITY|PROV|NUMBER|NO\.|VIN|LICENCE|STATUS|COMPANY|APPROVED|TYPE|COVERAGE|YES|NO)$/i.test(text);
function record(target: Target, key: string, value: unknown, cells: LayoutCell[], page: IndexedPage) {
  const evidence = cells.flatMap(evidenceOf);
  if (evidence.length) target.fieldEvidence[key] = [...(target.fieldEvidence[key] ?? []), ...evidence];
  if (value === undefined || !cells.length || cells.some(c => c.confidence < confidenceFloor(page))) {
    target.warnings.push({ code: 'NEEDS_REVIEW', field: key, severity: 'medium', message: `Signed application ${key} is ambiguous, invalid or low-confidence on physical page ${page.page}; no value accepted.` });
    return;
  }
  if (target.data[key] !== undefined && JSON.stringify(target.data[key]) !== JSON.stringify(value)) {
    delete target.data[key];
    target.warnings.push({ code: 'NEEDS_REVIEW', field: key, severity: 'high', message: `Conflicting ${key} values in the signed application. Manual source review required.` });
    return;
  }
  if (!target.warnings.some(w => w.field === key && /Conflicting/.test(w.message))) target.data[key] = value;
  if (page.ocr) target.warnings.push({ code: 'OCR_FIELD_REVIEW', field: key, severity: 'medium', message: `OCR candidate ${key} on page ${page.page} must be confirmed against the signed original.` });
}
function find(page: IndexedPage, pattern: RegExp, left = 0, right = Infinity, top = 0, bottom = Infinity) {
  return page.cells.filter(c => c.box.x >= left && c.box.x < right && c.box.y >= top && c.box.y < bottom && pattern.test(c.text))
    .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}
function rightOf(page: IndexedPage, label: LayoutCell, minGap: number, maxGap: number, sameRow = 6, maxRight = Infinity, validate: (value: string) => boolean = () => true): LayoutCell | undefined {
  const start = label.box.x + label.box.width;
  const candidates = page.cells.filter(c => c !== label && c.box.x >= start + minGap && c.box.x <= Math.min(start + maxGap, maxRight) &&
    Math.abs(c.box.y - label.box.y) <= sameRow && !isLabel(c.text) && validate(c.text))
    .sort((a, b) => Math.abs(a.box.y - label.box.y) - Math.abs(b.box.y - label.box.y) || a.box.x - b.box.x);
  if (!candidates.length) return undefined;
  const best = candidates[0];
  // A different candidate at the same x/y distance is not an unambiguous answer.
  if (candidates.slice(1).some(c => Math.abs(c.box.y - best.box.y) < 1 && Math.abs(c.box.x - best.box.x) < 2 && normal(c.text) !== normal(best.text))) return undefined;
  return best;
}
function onlyOnRow(page: IndexedPage, x0: number, x1: number, y: number, test: (text: string) => boolean, tol = 3): LayoutCell | undefined {
  const matches = page.cells.filter(c => c.box.x >= x0 && c.box.x < x1 && Math.abs(c.box.y - y) <= tol && test(c.text));
  return matches.length === 1 ? matches[0] : undefined;
}
const yesNoUnproven = (sink: Target, field: string, page: IndexedPage) => sink.warnings.push({ code: 'CHECKBOX_REVIEW', field, severity: 'medium', message: `Signed application checkbox ${field} on page ${page.page} is graphical and was not verified; confirm directly from the form.` });
function validPerson(value: string) { return /^[\p{L}][\p{L}\s,.'\u2019-]{2,90}$/u.test(normal(value)) && !/^(?:NAME|INSURANCE|BROKER|CANTRUST|POLICY|ADDRESS)/i.test(value); }
function validLicence(value: string) { const s = compact(value); return /^[A-Z][A-Z0-9]{10,19}$/.test(s) ? s : undefined; }
function validVin(value: string) { const s = compact(value); return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s : undefined; }
function validInt(value: string, low: number, high: number) { const v = normal(value).replace(/,/g, ''); const n = Number(v); return /^\d{1,7}$/.test(v) && n >= low && n <= high ? n : undefined; }
const dateYmd = (v: string) => templateDate(v, 'YMD');
function newEntity(kind: ParsedEntity['kind'], page: IndexedPage, index: number): ParsedEntity {
  return { id: `signed-${kind.toLowerCase()}-p${page.page}-${index}`, kind, label: `${kind} ${index} (signed application, p.${page.page})`, data: {}, fieldEvidence: {}, warnings: [] };
}
function pagesOf(raw: RawExtractedDocument) {
  return (raw.pages ?? []).map(p => ({page: p.pageNumber ?? p.page, width: p.width ?? 0, height: p.height ?? 0,
    cells: layoutCells(p).filter(c => !/^Document ID:\s*\S+$/i.test(c.text)),
    ocr: Boolean(raw.metadata?.provider === 'ocr_space' || raw.metadata?.provider === 'paddle_ocr' ||
      (p as { extractionProvider?: string }).extractionProvider === 'ocr_space' || (p as { extractionProvider?: string }).extractionProvider === 'paddle_ocr') }))
    .filter(p => p.width > 0 && p.height > 0);
}

function parseCsioHome(page: IndexedPage, result: ParsedSource) {
  const width = page.width;
  const section = find(page, /APPLICANT.S FULL NAME AND POSTAL ADDRESS/i, 0, width*.5)[0];
  if (section) {
    const from = section.box.y, to = find(page, /BROKER.S NAME AND POSTAL ADDRESS|POLICY PERIOD/i).find(c => c.box.y > from)?.box.y ?? from+160;
    const nameLabel = find(page,/^NAME$/i, 0, width*.45, from, to)[0];
    const value = nameLabel && rightOf(page, nameLabel, 5, 210, 6, width*.49, validPerson);
    if (value) record(result, 'namedInsured', value.text, [value], page);
    const second = find(page,/^APPLICANT 2\b/i, width*.49, width, from, to)[0];
    if (second) { const next = rightOf(page,second,5,120,6,width,(s)=>validPerson(s)); if (next) record(result,'coInsured',next.text,[next],page); }
  }
  for (const [key, pattern, side] of [
    ['effectiveDate',/^EFFECTIVE DATE$/i,0], ['expiryDate',/^EXPIRY DATE$/i,1]
  ] as const) {
    const label = find(page, pattern, side?width*.48:0, side?width:width*.48)[0];
    if (!label) continue;
    const rawDate=rightOf(page,label,0,135,7,side?width:width*.45,v=>Boolean(dateYmd(v)));
    if (rawDate) record(result,key,dateYmd(rawDate.text),[rawDate],page);
  }
  const sinceLabel = find(page,/^INSURED SINCE$/i)[0];
  if(sinceLabel){const c=page.cells.filter(x=>x.box.x>sinceLabel.box.x+sinceLabel.box.width && x.box.x<sinceLabel.box.x+140 &&
    Math.abs(x.box.y-sinceLabel.box.y)<7 && Boolean(dateYmd(x.text)))[0];
    if(c)record(result,'propertyInsuredSince',dateYmd(c.text),[c],page);}
  const risks=find(page,/^RISK ADDRESS$/i);
  const ratings=find(page,/RATING INFORMATION/i);
  if(risks.length>1||ratings.length>1){result.warnings.push({code:'APPLICATION_LAYOUT_REVIEW',severity:'high',message:`Several property locations share physical page ${page.page}. Layout grouping needs manual confirmation; no property was selected.`});return;}
  const riskTitle=risks[0];
  const rating=ratings[0];
  if(!riskTitle&&!rating)return;
  const property=newEntity('PROPERTY',page,result.entities!.filter(e=>e.kind==='PROPERTY').length+1);
  if(riskTitle){
    const addrLabel=find(page,/^ADDRESS$/i,0,width*.28,riskTitle.box.y,riskTitle.box.y+65)[0];
    const street=addrLabel&&rightOf(page,addrLabel,5,255,7,width*.65,s=>/[A-Za-z].*\d|\d.*[A-Za-z]/.test(s));
    const cityMarker=find(page,/^CITY,?\s*$/i,width*.45,width,riskTitle.box.y,riskTitle.box.y+65)[0];
    const city=cityMarker&&rightOf(page,cityMarker,2,110,7,width*.86,s=>/^[A-Za-z\s-]{3,35}$/.test(s));
    const postal=page.cells.find(c=>c.box.y>=riskTitle.box.y&&c.box.y<(rating?.box.y??riskTitle.box.y+80)&&
      /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(c.text));
    if(street&&city&&postal){
      const all=joinCells([street,city,postal]);record(property,'riskAddress',`${street.text}, ${city.text}, ON ${postal.text}`,[all],page);
    } else if (street) {property.fieldEvidence.riskAddress=evidenceOf(street);property.warnings.push({code:'NEEDS_REVIEW',field:'riskAddress',severity:'medium',message:`Only part of the risk address on page ${page.page} was located. Complete address was withheld.`});}
  }
  if(rating){
    const from=rating.box.y, end=find(page,/DETACHED OUTBUILDINGS|COVERAGES AND LIABILITY|COVERAGES$/i).find(c=>c.box.y>from)?.box.y??page.height;
    const specs: Array<[string,RegExp,number,number]>=[
      ['yearBuilt',/^YEAR BUILT$/i,180,1890],['families',/^FAMILIES$/i,48,0],
      ['storeys',/^STOREYS$/i,48,0],['livingArea',/^TOTAL LIVING AREA$/i,115,0],
      ['structure',/^STRUCTURE TYPE$/i,190,0],['exteriorFinish',/^EXTERIOR WALL FRAMING TYPE$|^EXTERIOR WALL FINISH TYPE$/i,180,0],
      ['roof',/^ROOF COVERING TYPE$/i,180,0],['electrical',/^ELECTRICAL WIRING TYPE$/i,180,0],
      ['heating',/^PRIMARY HEATING TYPE$/i,190,0],['garage',/^GARAGE TYPE$/i,155,0],
    ];
    for(const [key,pat,span] of specs){
      const lbl=find(page,pat,0,width,from,end)[0];if(!lbl)continue;
      const v=rightOf(page,lbl,4,span,7,width,txt=>{
        if(['yearBuilt','families','storeys','livingArea'].includes(key)) return /^\d{1,7}$/.test(normal(txt));
        return /^[A-Za-z][A-Za-z\s/&().-]{2,70}$/.test(txt) && !isLabel(txt);
      });
      if(!v)continue;
      const value=key==='yearBuilt'?validInt(v.text,1800,2100):key==='families'?validInt(v.text,1,20):
        key==='storeys'?validInt(v.text,1,120):key==='livingArea'?validInt(v.text,100,100000):v.text;
      record(property,key,value,[v],page);
    }
    for(const unsafe of ['smokeFree','ownerOccupied','dogExposure','swimmingPool','vacant','claimsReported']) yesNoUnproven(property,unsafe,page);
  }
  if(Object.keys(property.data).length||Object.keys(property.fieldEvidence).length)result.entities!.push(property);
}

function parseOafOne(page: IndexedPage,result:ParsedSource){
  const w=page.width;
  const described=find(page,/^Described Automobile\b/i)[0];
  const driverHeading=find(page,/^Driver Information\s*[\u2013-]/i)[0];
  if(!described&&!driverHeading)return;
  const leftOwner=find(page,/^Applicant.s Name & Primary Address$/i,0,w*.5)[0];
  if(leftOwner){
    const nameAndAddress=find(page,/^Name and Address$/i,0,w*.5,leftOwner.box.y,leftOwner.box.y+60)[0];
    const titleNext=find(page,/^Policy Period$/i)[0];
    const name=nameAndAddress && page.cells.filter(c=>c.box.x>=nameAndAddress.box.x && c.box.x<w*.48 &&
      c.box.y>nameAndAddress.box.y+4 && c.box.y<(titleNext?.box.y??nameAndAddress.box.y+65) && validPerson(c.text))
      .sort((a,b)=>a.box.y-b.box.y)[0];
    if(name) record(result,'namedInsured',name.text,[name],page);
  }
  const policyPeriod=find(page,/^Policy Period$/i)[0];
  if(policyPeriod){
    const limits=[['effectiveDate',0,w*.48],['expiryDate',w*.48,w]] as const;
    for(const [key,x0,x1] of limits){
      const label=find(page,key==='effectiveDate'?/^Effective Date:$/i:/^Expiry Date:$/i,x0,x1,policyPeriod.box.y,policyPeriod.box.y+60)[0];
      if(!label)continue;
      const headerY=label.box.y+label.box.height;
      const nextSection=described?.box.y??page.height;
      const values=page.cells.filter(c=>c.box.x>=label.box.x+label.box.width-2 && c.box.x<x1&&c.box.y>=headerY && c.box.y<Math.min(headerY+27,nextSection-2));
      const nums=values.filter(c=>/^\d{1,4}$/.test(c.text)&&Number(c.text)>0).sort((a,b)=>a.box.x-b.box.x);
      const year=nums.find(c=>/^(?:19|20)\d{2}$/.test(c.text));
      if(year){const month=nums.find(c=>c.box.x>year.box.x+year.box.width&&c.box.x<year.box.x+55&&Number(c.text)<=12);
        const day=month&&nums.find(c=>c.box.x>month.box.x+month.box.width&&c.box.x<month.box.x+65&&Number(c.text)<=31);
        if(month&&day)record(result,key,templateDate(`${year.text}/${month.text}/${day.text}`,'YMD'),[year,month,day],page);}
    }
  }
  if(described){
    const vinHead=find(page,/Vehicle Identification No\./i,0,w,described.box.y,described.box.y+165)[0];
    const end=find(page,/^Estimated Annual$/i,0,w,described.box.y,described.box.y+220)[0];
    const vinTop=(vinHead?.box.y??described.box.y+45)+8;
    const vinBottom=end?.box.y??Math.min(described.box.y+160,page.height);
    const vinRows=page.cells.filter(c=>c.box.x<w*.065&&/^\d{1,2}\.$/.test(c.text)&&c.box.y>vinTop&&c.box.y<vinBottom).sort((a,b)=>a.box.y-b.box.y);
    const descriptionRows=page.cells.filter(c=>c.box.x<w*.065&&/^\d{1,2}\.$/.test(c.text)&&
      c.box.y>described.box.y && c.box.y<(vinHead?.box.y??described.box.y+70)).sort((a,b)=>a.box.y-b.box.y);
    for(const [index,row] of vinRows.entries()){
      const ordinal=Number(row.text.replace('.',''));
      const letters=page.cells.filter(c=>c.box.y>=row.box.y-3.2&&c.box.y<=row.box.y+3.2&&c.box.x>=w*.065&&c.box.x<w*.28&&/^[A-HJ-NPR-Z0-9]$/i.test(c.text)).sort((a,b)=>a.box.x-b.box.x);
      const grouped=letters.length?joinCells(letters):undefined;
      const vin=grouped&&validVin(letters.map(c=>c.text).join(''));
      const describedRow=descriptionRows.find(r=>Number(r.text.replace('.',''))===ordinal);
      const info=describedRow? page.cells.filter(c=>Math.abs(c.box.y-describedRow.box.y)<3.1):[];
      if(!vin){
        if(info.length>1)result.warnings.push({code:'NEEDS_REVIEW',field:'vin',severity:'medium',message:`Automobile row ${ordinal} on page ${page.page} has no reliable 17-character VIN. No vehicle identity or assignment was inferred.`});
        continue;
      }
      const vehicle=newEntity('VEHICLE',page,ordinal);
      record(vehicle,'vin',vin,[grouped!],page);
      if(describedRow){
        const year=info.find(c=>c.box.x>=w*.07&&c.box.x<w*.16&&/^(?:19|20)\d{2}$/.test(c.text));
        if(year)record(vehicle,'year',validInt(year.text,1900,2100),[year],page);
        const make=info.find(c=>c.box.x>=w*.16&&c.box.x<w*.34&&/^[A-Za-z][\w\s-]{1,32}$/.test(c.text));
        if(make)record(vehicle,'make',make.text,[make],page);
        const model=info.find(c=>c.box.x>=w*.31&&c.box.x<w*.65&&/^[A-Za-z0-9][\w\s/-]{2,65}$/.test(c.text));
        if(model)record(vehicle,'model',model.text,[model],page);
      }
      if(!vehicle.data.year||!vehicle.data.make||!vehicle.data.model)vehicle.warnings.push({code:'NEEDS_REVIEW',field:'vehicleDescription',severity:'medium',message:`Vehicle ${ordinal} page ${page.page} description is incomplete. Do not infer make/model/year from neighbouring rows.`});
      // Image-only circles are not machine-verified selections.
      for(const unsafe of ['leased','vehicleUse','commuteKm','businessUse','modified'])yesNoUnproven(vehicle,unsafe,page);
      result.entities!.push(vehicle);
    }
    // Driver/vehicle relationships are never fabricated from row ordinal.
  }
  if(driverHeading){
    const driverHeadY=driverHeading.box.y;
    const footer=find(page,/^Special Notes:|^Effective\s*\(/i,0,w,driverHeadY)[0]?.box.y??page.height;
    const licenceColumn=find(page,/^Driver.s Licence Number$/i,0,w,driverHeadY,Math.min(driverHeadY+48,footer))[0];
    const dobHead=find(page,/^Date of Birth$/i,0,w,driverHeadY,Math.min(driverHeadY+48,footer))[0];
    const nameColumn=find(page,/^Name as shown on Driver.s Licence$/i,0,w,driverHeadY,Math.min(driverHeadY+48,footer))[0];
    if(!licenceColumn||!dobHead||!nameColumn){result.warnings.push({code:'NEEDS_REVIEW',field:'drivers',severity:'high',message:`OAF 1 driver columns on page ${page.page} are ambiguous. Driver identity withheld.`});return;}
    const rowStart=Math.max(nameColumn.box.y,licenceColumn.box.y,dobHead.box.y)+10;
    const rowEnd=Math.min(footer,driverHeadY+115);
    const markers=page.cells.filter(c=>c.box.x<w*.065&&/^\d{1,2}\.$/.test(c.text)&&c.box.y>rowStart&&c.box.y<rowEnd).sort((a,b)=>a.box.y-b.box.y);
    for(const marker of markers){
      const ordinal=Number(marker.text.slice(0,-1));if(ordinal>12)continue;
      const y=marker.box.y;
      const name=onlyOnRow(page,nameColumn.box.x,nameColumn.box.x+nameColumn.box.width+85,y,validPerson,3);
      const dl=onlyOnRow(page,licenceColumn.box.x, dobHead.box.x-4, y, s=>Boolean(validLicence(s)),3);
      if(!name&&!dl)continue;
      const driver=newEntity('DRIVER',page,ordinal);
      if(name)record(driver,'driverName',name.text,[name],page);
      if(dl)record(driver,'licenceNumber',validLicence(dl.text),[dl],page);
      const yNum=onlyOnRow(page,dobHead.box.x-25,dobHead.box.x+31,y,s=>/^(?:19|20)\d{2}$/.test(s),3);
      const mon=yNum&&onlyOnRow(page,yNum.box.x+22,yNum.box.x+70,y,s=>/^\d{1,2}$/.test(s)&&Number(s)>=1&&Number(s)<=12,3);
      const day=mon&&onlyOnRow(page,mon.box.x+14,mon.box.x+55,y,s=>/^\d{1,2}$/.test(s)&&Number(s)>=1&&Number(s)<=31,3);
      if(yNum&&mon&&day)record(driver,'dob',templateDate(`${yNum.text}/${mon.text}/${day.text}`,'YMD'),[yNum,mon,day],page);
      if(!name||!dl)driver.warnings.push({code:'NEEDS_REVIEW',field:'driverIdentity',severity:'high',message:`Driver row ${ordinal} on page ${page.page} has incomplete identity; do not bind to an existing driver.`});
      for(const unsafe of ['driverTraining','principal','licenceClass','internationalExperience']) yesNoUnproven(driver,unsafe,page);
      result.entities!.push(driver);
    }
  }
}

/** OAF 1 loss and conviction tables use driver numbers, not the previous
 * paragraph's name or the previous vehicle row. An incomplete row remains a
 * review observation, not a clean history. */
function parseOafHistory(page: IndexedPage, result: ParsedSource) {
  const claims = find(page,/Previous Accidents and Insurance Claims/i)[0];
  const convictions = find(page,/History of Convictions/i)[0];
  for(const [section,heading,next,field] of [
    ['claims',claims,convictions,'declaredClaims'],
    ['convictions',convictions,undefined,'declaredConvictions']
  ] as const){
    if(!heading)continue;
    const from=heading.box.y+26,to=next?.box.y??Math.min(page.height,heading.box.y+150);
    const markers=page.cells.filter(c=>c.box.x>=page.width*.046 && c.box.x<page.width*.078 &&
      c.box.y>from && c.box.y<to && /^\d{1,2}$/.test(c.text))
      .filter(c=>page.cells.some(v=>v.box.y<c.box.y&&v.box.y>heading.box.y&&/^(?:Date Convicted|Date)$/i.test(v.text)))
      .sort((a,b)=>a.box.y-b.box.y);
    for(const marker of markers){
      const n=Number(marker.text);
      if(n<1||n>12)continue;
      const year=onlyOnRow(page,section==='claims'?page.width*.11:page.width*.08,
        section==='claims'?page.width*.158:page.width*.126,marker.box.y,v=>/^(?:19|20)\d{2}$/.test(v),3);
      const month=onlyOnRow(page,section==='claims'?page.width*.17:page.width*.13,
        section==='claims'?page.width*.218:page.width*.171,marker.box.y,v=>/^\d{1,2}$/.test(v)&&Number(v)>0&&Number(v)<=12,3);
      const day=onlyOnRow(page,section==='claims'?page.width*.222:page.width*.178,
        section==='claims'?page.width*.266:page.width*.211,marker.box.y,v=>/^\d{1,2}$/.test(v)&&Number(v)>0&&Number(v)<=31,3);
      const date=year&&month&&day?templateDate(`${year.text}/${month.text}/${day.text}`,'YMD'):undefined;
      const detail=section==='convictions'?onlyOnRow(page,page.width*.211,page.width*.47,
        marker.box.y,v=>/^[A-Za-z][A-Za-z\s/.,()-]{2,75}$/.test(v),3):undefined;
      if(!year&&!month&&!day&&!detail)continue;
      const sourceCells=[marker,...[year,month,day,detail].filter((x):x is LayoutCell=>Boolean(x))];
      const matching=result.entities!.filter(e=>e.kind==='DRIVER'&&Number(e.id.match(/-(\d+)$/)?.[1])===n);
      const driver=matching.length===1?matching[0]:undefined;
      const sink=driver??newEntity('DRIVER',page,n);
      if(!driver)sink.warnings.push({code:'NEEDS_REVIEW',field,severity:'high',message:`History row ${n} on page ${page.page} has no uniquely matched OAF driver; no driver assignment was made.`});
      if(!date || sourceCells.some(c=>c.confidence<confidenceFloor(page))){
        sink.fieldEvidence[field]=[...(sink.fieldEvidence[field]??[]),...sourceCells.flatMap(evidenceOf)];
        sink.warnings.push({code:'NEEDS_REVIEW',field,severity:'high',message:`${section} date/detail row ${n} page ${page.page} is incomplete or uncertain; no declared clean-history assumption.`});
      }else{
        const rows=(sink.data[field]??[]) as Record<string,unknown>[];
        rows.push({date,driverNumber:n,...(detail?{description:detail.text}:{})});
        sink.data[field]=rows;
        sink.fieldEvidence[field]=[...(sink.fieldEvidence[field]??[]),...sourceCells.flatMap(evidenceOf)];
      }
      if(!driver)result.entities!.push(sink);
    }
  }
}

/** CSIO/OAF forms use same-row/column and repeated-row geometry, not inline-label heuristics. */
export function parseSignedApplication(raw: RawExtractedDocument, type: DocumentType): ParsedSource | undefined {
  if(type!=='AUTO_APPLICATION'&&type!=='HAB_APPLICATION')return undefined;
  const allText=raw.pages?.map(p=>p.text??'').join('\n')??raw.text??'';
  const detected=type==='AUTO_APPLICATION'? /Ontario Application for Automobile Insurance|Owner.s Form\s*\(OAF\s*1\)|APPLICATION FOR AUTOMOBILE INSURANCE/i.test(allText) :
    /HABITATIONAL INSURANCE APPLICATION|APPLICATION FOR HABITATIONAL INSURANCE|CSIO\s*-\s*Habitational Insurance Application/i.test(allText);
  if(!detected)return undefined;
  const result:ParsedSource={documentId:String(raw.metadata?.fileId??'unidentified'),documentType:type,parsedAt:new Date().toISOString(),
    confidence:.8,data:{},fieldEvidence:{},warnings:[],entities:[],layoutVersion:2};
  const typedPages=pagesOf(raw).filter(p=>!p.ocr || (raw.pages??[]).some(x=>(x.pageNumber??x.page)===p.page&&(x as {ocrGeometryVerified?:boolean}).ocrGeometryVerified));
  if((raw.pages??[]).some(p=>((p as {extractionProvider?:string}).extractionProvider??'').includes('ocr') && !(p as {ocrGeometryVerified?:boolean}).ocrGeometryVerified))result.warnings.push({code:'OCR_GEOMETRY_REVIEW',severity:'high',message:'An OCR page has not passed dimension, orientation and individual box-confidence verification. Do not apply its extracted form fields.'});
  if(!typedPages.length){result.warnings.push({code:'APPLICATION_LAYOUT_REVIEW',severity:'high',message:'Signed application detected but no reliable page geometry is available; no application values automatically accepted.'});return result;}
  for(const page of typedPages){
    if(type==='AUTO_APPLICATION'&&page.cells.some(c=>/Ontario Application for Automobile Insurance|OAF\s*1/i.test(c.text)))parseOafOne(page,result);
    if(type==='HAB_APPLICATION'&&page.cells.some(c=>/HABITATIONAL INSURANCE APPLICATION|CSIO\s*-\s*Habitational Insurance Application/i.test(c.text)))parseCsioHome(page,result);
  }
  if(type==='AUTO_APPLICATION')for(const page of typedPages)parseOafHistory(page,result);
  // A source with only check-boxes or one text row cannot establish application truth.
  if(!Object.keys(result.data).length&&!result.entities?.some(e=>Object.keys(e.data).length))result.warnings.push({code:'APPLICATION_LAYOUT_REVIEW',severity:'high',message:'Signed form was found but no safely located values could be extracted. Inspect the original pages.'});
  for(const entity of result.entities??[])result.warnings.push(...entity.warnings);
  return result;
}

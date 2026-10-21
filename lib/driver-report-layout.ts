import type { ExtractedPage, FieldEvidence, ParsedEntity, ParsedSource, RawExtractedDocument } from './extraction-types.ts';
import { cleanLayoutText, evidenceOf, joinCells, layoutCells, templateDate, type LayoutCell } from './layout-reader.ts';

const escaped=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const unknown=(s:string)=>!s||/^(?:not available|n\/?a|unknown|\*+)$/i.test(s.trim());
const licence=(s:string)=>{
  const v=s.trim().replace(/\s+Ontario$/i,'').replace(/[ -]/g,'').toUpperCase();
  return /^[A-Z]\d{10,15}$/.test(v)?v:undefined;
};
const amount=(s:string)=>/^\$?\s*\d[\d,]*(?:\.\d{1,2})?$/.test(s)?Number(s.replace(/[$,\s]/g,'')):undefined;
const percent=(s:string)=>/^\d{1,3}%$/.test(s)&&Number(s.slice(0,-1))<=100?Number(s.slice(0,-1)):undefined;
const allLabels=['First Party Driver Date of Birth','First Party Driver Listed on Policy','First Party Driver Excluded','First Party Driver At-Fault','Third Party Driver Insurer Name',
  'Third Party Driver Policy #','Third Party Driver At-Fault','First Party Driver DLN','Third Party Driver DLN','First Party Driver','Third Party Driver',
  'Number of Convictions','Policyholder Name','Policyholder Address','Policy #','Claim #','Coverage','Date Reported','Claim Status','Total Loss','Total Expense',
  'Vehicle','Vehicle Loss','Type of Use / Vehicle Class','Date of Birth','DLN','Report Date','Last Data Update','Requestor','Company','Comment',
  'Licence Number','Expiry Date','Name','Birth Date','Gender','Height','Address','Reference','Demerit Points','Class','Conditions','Status','Issue Date',
  'Requested By','User ID','Requested On','Reply Date','Print Date','Reprint Date','Effective Date','Cancellation Date',
  'Number of Reported Operators','Number of Private Passenger Vehicles'];
const labelPattern = new RegExp('(?:^|\\s)(?:'+allLabels.map(escaped).sort((a,b)=>b.length-a.length).join('|')+')\\s*:', 'i');
interface LabelValue {value:string;cell:LayoutCell;}
/** Bound values to their own line/column. Never read the following arbitrary label as a value. */
function labelled(cells:LayoutCell[],label:string):LabelValue[]{
  const pattern=new RegExp('^'+escaped(label)+'\\s*:\\s*(.*)$','i');
  return cells.flatMap(cell=>{
    const m=cell.text.match(pattern);if(!m)return [];
    const inline=m[1].split(labelPattern)[0].trim();
    if(inline)return [{value:inline,cell:{...cell,text:inline}}];
    const right=cells.filter(c=>c.box.x>=cell.box.x+cell.box.width-1 &&
      Math.abs(c.box.y-cell.box.y)<Math.max(2,cell.box.height*.35)).sort((a,b)=>a.box.x-b.box.x)[0];
    if(!right || labelPattern.test(right.text))return [];
    return [{value:right.text,cell:right}];
  });
}
function one(cells:LayoutCell[],label:string):LabelValue|undefined{
  const values=labelled(cells,label).filter(v=>!unknown(v.value));
  return new Set(values.map(x=>cleanLayoutText(x.value).toUpperCase())).size===1?values[0]:undefined;
}
function source(raw:RawExtractedDocument,type:'MVR'|'DASH'):ParsedSource{
  return {documentId:String(raw.metadata?.fileId??'unidentified'),documentType:type,parsedAt:new Date().toISOString(),
    confidence:.85,data:{},warnings:[],fieldEvidence:{},layoutVersion:1,entities:[]};
}
function setField(target:Pick<ParsedSource,'data'|'fieldEvidence'|'warnings'>,key:string,item:LabelValue|undefined,convert:(v:string)=>unknown=v=>v){
  if(!item)return;
  const value=convert(item.value);
  if(value===undefined || item.cell.confidence<.9){
    target.fieldEvidence[key]=evidenceOf(item.cell);
    target.warnings.push({code:'NEEDS_REVIEW',field:key,severity:'medium',message:`The report's ${key} needs review on page ${item.cell.page}; value withheld.`});return;
  }
  target.data[key]=value;target.fieldEvidence[key]=evidenceOf(item.cell);
}
function cleanDate(s:string,order:'DMY'|'YMD'){return templateDate(s,order);}
/** CGI Ontario abstracts: keep explicit zero convictions separate from missing/unparsed history. */
export function parseMvrLayout(raw:RawExtractedDocument):ParsedSource|undefined{
  const pages=(raw.pages??[]).filter(p=>/ONTARIO\s+Driving\s+Record/i.test(p.text??'') && p.blocks?.length);
  if(!pages.length)return;
  const result=source(raw,'MVR');
  for(const page of pages){
    const cells=layoutCells(page,.8),heading=cells.find(c=>/ONTARIO\s+Driving\s+Record/i.test(c.text));
    const end=cells.find(c=>heading&&c.box.y>heading.box.y&&/END OF REPORT\s*\//i.test(c.text));
    const body=cells.filter(c=>c.box.y>(heading?.box.y??0)&&c.box.y<(end?.box.y??Infinity));
    const entity:ParsedEntity={id:`mvr-p${page.page}`,kind:'DRIVER',label:`MVR subject on page ${page.page}`,data:{},warnings:[],fieldEvidence:{}};
    const fields:[string,string,((s:string)=>unknown)?][]=[
      ['licenceNumber','Licence Number',licence],['driverName','Name'],['dob','Birth Date',s=>cleanDate(s,'DMY')],
      ['expiryDate','Expiry Date',s=>cleanDate(s,'DMY')],['gender','Gender'],
      ['licenceStatus','Status'],['issueDate','Issue Date',s=>cleanDate(s,'DMY')],
      ['requestDate','Requested On',s=>cleanDate(s,'DMY')],['replyDate','Reply Date',s=>cleanDate(s,'DMY')],
      ['demeritPoints','Demerit Points',s=>/^\d{1,2}$/.test(s)?Number(s):undefined],
      ['licenceClass','Class',s=>/^[A-Z]{1,3}\**$/.test(s)?s.replace(/\*+$/,''):undefined],['conditions','Conditions'],
    ];
    for(const [key,label,convert] of fields)setField(entity,key,one(body,label),convert);
    if(entity.data.licenceNumber){entity.data.licenceProvince='ON';entity.fieldEvidence.licenceProvince=heading?evidenceOf(heading):[];}
    if(entity.data.driverName)entity.label=String(entity.data.driverName);
    const countCell=body.find(c=>/^\**\s*Number\s+of\s+Convictions\s*:\s*\d+\s*\**$/i.test(c.text));
    const count=countCell?Number(countCell.text.match(/:\s*(\d+)/)![1]):undefined;
    if(count!==undefined){entity.data.reportedConvictionCount=count;entity.fieldEvidence.reportedConvictionCount=evidenceOf(countCell!);}
    const convictionHeader=body.find(c=>/^(?:DATE\s+)?CONVICTIONS,?\s+DISCHARGES/i.test(c.text));
    const entries:Record<string,unknown>[]=[];const rowEvidence:FieldEvidence[]=[];
    if(convictionHeader){
      const rows=body.filter(c=>c.box.y>convictionHeader.box.y);
      for(const c of rows){
        const date=c.text.match(/^(\d{2}\/\d{2}\/\d{4})(?:\s+(.+))?$/);
        if(!date)continue;
        const description=date[2]?{...c,text:date[2]}:rows.filter(n=>n.box.x>c.box.x+c.box.width && Math.abs(n.box.y-c.box.y)<3).sort((a,b)=>a.box.x-b.box.x)[0];
        if(!description||/^(?:SEARCH|OFFENCE DATE|END OF REPORT)/i.test(description.text))continue;
        const offence=rows.find(n=>n.box.y>c.box.y && n.box.y-c.box.y<25 && /^OFFENCE DATE\s+\d{4}\/\d{2}\/\d{2}$/i.test(n.text));
        const record:Record<string,unknown>={description:description.text,conviction_date:templateDate(date[1],'DMY')};
        if(offence)record.offence_date=templateDate(offence.text.match(/\d{4}\/\d{2}\/\d{2}/)![0],'YMD');
        // Do not invent severity or per-offence points from aggregate demerit points.
        entries.push(record);rowEvidence.push(...evidenceOf(c),...evidenceOf(description),...(offence?evidenceOf(offence):[]));
      }
    }
    if(count===0 && entries.length===0){entity.data.convictions=[];entity.fieldEvidence.convictions=evidenceOf(countCell!);}
    else if(count!==undefined&&count>0&&entries.length===count){entity.data.convictions=entries;entity.fieldEvidence.convictions=rowEvidence;}
    else entity.warnings.push({code:'NEEDS_REVIEW',field:'convictions',severity:'medium',message:'Reported conviction count and extracted detail rows are incomplete or inconsistent; no clean-history assumption.'});
    result.entities!.push(entity);
  }
  // Multiple reports are never reduced to the first or last driver's scalar fields.
  if(result.entities!.length===1){result.data={...result.entities![0].data};result.fieldEvidence={...result.entities![0].fieldEvidence};result.warnings=[...result.entities![0].warnings];}
  else result.warnings.push({code:'NEEDS_REVIEW',severity:'medium',message:'Multiple MVR subjects detected. Review each separate driver group.'});
  return result;
}

/** DASH's detail pages are authoritative observations; summaries are counts, not detail rows. */
export function parseDashLayout(raw:RawExtractedDocument):ParsedSource|undefined{
  const pages=raw.pages??[];
  if(!pages.some(p=>/\bDRIVER\s+REPORT\b/.test(p.text??''))||!pages.some(p=>p.blocks?.length))return;
  const result=source(raw,'DASH');
  let reportLicence:string|undefined,reportName:string|undefined,reportDate:string|undefined;
  let reportIndex=0;const reportSubjects:ParsedEntity[]=[];const claims:Record<string,unknown>[]=[];
  for(const page of pages){
    const cells=layoutCells(page);if(!cells.length)continue;
    const title=cells.find(c=>/^DRIVER REPORT$/i.test(c.text));
    if(title){
      reportIndex++;reportLicence=undefined;reportName=undefined;reportDate=undefined;
      const header=cells.filter(c=>c.box.y>title.box.y && c.box.y<title.box.y+160);
      const dln=one(header,'DLN');reportLicence=dln?licence(dln.value):undefined;
      const rd=one(header,'Report Date');reportDate=rd?.value;
      if(dln){const nameCell=header.filter(c=>c.box.x<page.width!*.45&&c.box.y<dln.cell.box.y&&c.box.y>title.box.y+title.box.height&&
        !/:|REPORT|DATE/i.test(c.text)).sort((a,b)=>b.box.y-a.box.y)[0];reportName=nameCell?.text;}
      const subject:ParsedEntity={id:`dash-subject-${reportIndex}`,kind:'DRIVER',label:reportName??`DASH subject ${reportIndex}`,data:{},fieldEvidence:{},warnings:[]};
      setField(subject,'licenceNumber',dln,licence);setField(subject,'dob',one(header,'Date of Birth'),s=>cleanDate(s,'YMD'));
      setField(subject,'reportDate',rd);
      if(reportName){const c=header.find(c=>c.text===reportName)!;subject.data.driverName=reportName;subject.fieldEvidence.driverName=evidenceOf(c);}
      reportSubjects.push(subject);
    }
    const policy=cells.find(c=>/^Policy #\d+\b/i.test(c.text));
    if(policy){
      const entity:ParsedEntity={id:`dash-policy-r${reportIndex}-p${page.page}`,kind:'POLICY_HISTORY',label:`Policy history on page ${page.page}`,data:{},fieldEvidence:{},warnings:[]};
      const details=cells.filter(c=>c.box.y>policy.box.y&&c.box.y<(cells.find(c=>/^Operator:/i.test(c.text))?.box.y??Infinity));
      for(const [key,label] of [['policyNumber','Policy #'],['policyholder','Policyholder Name'],['effectiveDate','Effective Date'],['expiryDate','Expiry Date'],['cancellationDate','Cancellation Date']] as const)
        setField(entity,key,one(details,label),s=>/Date$/.test(key)?cleanDate(s,'YMD'):s);
      const header=cells.filter(c=>Math.abs(c.box.y-policy.box.y)<5);
      const status=header.find(c=>/^(?:Cancelled\b|Active$|Expired$)/i.test(c.text));
      if(status){entity.data.status=status.text;entity.fieldEvidence.status=evidenceOf(status);}
      const insurer=header.find(c=>c!==policy&&c!==status&&!/^(?:\*|\d{4}-)/.test(c.text));
      if(insurer){entity.data.insurer=insurer.text;entity.fieldEvidence.insurer=evidenceOf(insurer);}
      if(reportLicence)entity.data.reportSubjectLicence=reportLicence;
      result.entities!.push(entity);
    }
    const claim=cells.find(c=>/^Claim #\d+\b/i.test(c.text));
    if(!claim)continue;
    const body=cells.filter(c=>c.box.y>=claim.box.y && !/^Page \d+ of \d+$/i.test(c.text));
    const row:Record<string,unknown>={};const evidence:FieldEvidence[]=[];
    function rowSet(key:string,label:string,convert:(v:string)=>unknown=v=>v){
      const item=one(body,label);if(!item)return;
      const value=convert(item.value);if(value===undefined||item.cell.confidence<.9)return;
      row[key]=value;evidence.push(...evidenceOf(item.cell));
    }
    for(const [key,label] of [['claim_number','Claim #'],['policy_number','Policy #'],['coverage','Coverage'],['status','Claim Status'],['vehicle','Vehicle'],
      ['First Party Driver','First Party Driver'],['Third Party Driver','Third Party Driver']] as const)rowSet(key,label);
    rowSet('loss_amount','Total Loss',amount);rowSet('expense','Total Expense',amount);
    rowSet('first_party_licence','First Party Driver DLN',licence);rowSet('third_party_licence','Third Party Driver DLN',licence);
    rowSet('First Party At-Fault','First Party Driver At-Fault',percent);rowSet('Third Party At-Fault','Third Party Driver At-Fault',percent);
    const loss=body.find(c=>/^Date of Loss\s+\d{4}-\d{2}-\d{2}/i.test(c.text));
    if(loss){row.loss_date=templateDate(loss.text.match(/\d{4}-\d{2}-\d{2}/)![0],'YMD');evidence.push(...evidenceOf(loss));}
    const header=body.filter(c=>Math.abs(c.box.y-claim.box.y)<5);
    const insurer=header.find(c=>c!==claim&&c!==loss&&!/^At-Fault|^\*/i.test(c.text));
    if(insurer){row.insurer=insurer.text;evidence.push(...evidenceOf(insurer));}
    const vin=String(row.vehicle??'').match(/\b[A-HJ-NPR-Z0-9]{17}\b/);
    if(vin)row.vehicle_vin=vin[0];
    const firstMatches=Boolean(reportLicence&&row.first_party_licence===reportLicence);
    const thirdMatches=Boolean(reportLicence&&row.third_party_licence===reportLicence);
    const thirdPerspective=header.some(c=>/^\*THIRD PARTY\*/i.test(c.text));
    const role=firstMatches&&thirdMatches?undefined:thirdMatches?'Third':
      !thirdPerspective&&row.first_party_licence?'First':undefined;
    if(role){row.party_role=role==='First'?'FIRST_PARTY':'THIRD_PARTY';
      row.driver=row[`${role} Party Driver`];row.driver_licence_number=row[role==='First'?'first_party_licence':'third_party_licence'];
      row.at_fault_percent=row[`${role} Party At-Fault`];}
    else row.party_role='UNKNOWN';
    if(reportDate)row.report_date=reportDate;
    row.report_subject_licence=reportLicence;row.__evidence=evidence;
    row.source_record_label=claim.text;
    if(!row.claim_number||!row.loss_date){
      row.review_required=true;
      result.warnings.push({code:'NEEDS_REVIEW',field:'claims',severity:'medium',message:`Claim detail on page ${page.page} has a missing/redacted identifier or loss date. Retain the record without inventing the missing value.`});
    }
    claims.push(row);
  }
  if(reportSubjects.length===1){result.data={...reportSubjects[0].data};result.fieldEvidence={...reportSubjects[0].fieldEvidence};}
  result.entities!.push(...reportSubjects);
  if(reportSubjects.length===1 && reportSubjects[0].data.licenceNumber){result.data.reportSubjectLicence=reportSubjects[0].data.licenceNumber;result.fieldEvidence.reportSubjectLicence=reportSubjects[0].fieldEvidence.licenceNumber;}
  if(claims.length){result.data.claims=claims;result.fieldEvidence.claims=claims.flatMap(c=>c.__evidence as FieldEvidence[]);}
  // A recent-period summary with zero claims never implies the absence of historical detail.
  if(!claims.length)result.warnings.push({code:'NEEDS_REVIEW',field:'claims',severity:'medium',message:'No supported historical claim detail extracted. A recent-summary count is not a verified clean history.'});
  return result;
}

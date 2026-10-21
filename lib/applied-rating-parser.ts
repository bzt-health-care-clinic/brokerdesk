import type { DocumentType, ExtractionWarning, FieldEvidence, ParsedEntity, ParsedSource, RawExtractedDocument } from './extraction-types.ts';
import { LayoutReader, cleanLayoutText, evidenceOf, joinCells, labelKey, templateDate, type LayoutCell } from './layout-reader.ts';

type Kind = 'text' | 'number' | 'money' | 'date' | 'bool' | 'vin' | 'licence' | 'person' | 'year';
interface Spec { key: string; labels: string[]; kind: Kind; }
const spec = (key: string, labels: string, kind: Kind = 'text'): Spec => ({key,labels:labels.split('|'),kind});
const vehicleSpecs: Spec[] = [
  spec('vin','VIN','vin'), spec('vehicleType','Vehicle Type'), spec('bodyType','Body Style'),
  spec('vehicleUse','Primary Use'), spec('annualKm','Annual km','number'),
  spec('businessKm','Business km','number'), spec('dailyKm','Daily km','number'),
  spec('commuteKm','One-way commute|Commute km','number'),
  spec('garagingAddress','Garaging Location'), spec('leased','Leased','bool'),
  spec('cylinders','Cylinders','number'), spec('fuelType','Fuel Type'), spec('hybrid','Hybrid','bool'),
  spec('purchaseCondition','Purchase Condition'), spec('purchaseDate','Purchase Date','date'),
  spec('purchasePrice','Purchase Price','money'), spec('listPriceNew','List Price New','money'),
  spec('winterTires','Winter Tires','bool'), spec('parking','Parking at Night'),
  spec('antiTheftType','Anti-Theft - Device Type'), spec('antiTheftManufacturer','Anti-Theft - Manufacturer'),
];
const driverSpecs: Spec[] = [
  spec('dob','Birth Date|Date of birth','date'), spec('gender','Gender'), spec('maritalStatus','Marital Status'),
  spec('relationship','Relationship to Applicant'), spec('driverTraining','Driver Training','bool'),
  spec('driverTrainingDate','Driver Training Date','date'), spec('outOfCountry','Out of Province / Country Driver','bool'),
  spec('licenceClass','Licence Class'), spec('licenceNumber','Licence Number','licence'),
  spec('licenceProvince','Licence Province'), spec('gDate','Date G','date'), spec('g2Date','Date G2','date'), spec('g1Date','Date G1','date'),
  spec('occupation','Occupation'), spec('insuredSince','Date Insured','date'),
  spec('priorInsurer','Current Carrier'), spec('dateWithCompany','Date with Company','date'),
  spec('retired','Retired','bool'), spec('studentAwayKm','Student Away at School (km)','number'),
];
const propertySpecs: Spec[] = [
  spec('riskAddress','Location'), spec('hydrantDistance','Metres to Hydrant'), spec('firehallDistance','Kilometres to Firehall'),
  spec('coverageType','Coverage Type'), spec('dwellingValue','Dwelling Value','money'), spec('dwellingCoverage','Dwelling Coverage','money'),
  spec('deductible','Deductible','money'), spec('liability','Liability','money'),
  spec('ownerOccupied','Owner Occupied','bool'), spec('yearBuilt','Year Dwelling Built','year'),
  spec('occupiedSince','Occupied Since','date'), spec('numberOfMortgages','Number of Mortgages','number'),
  spec('families','Number of Families','number'), spec('units','Number Of Units','number'),
  spec('structure','Structure'), spec('construction','Construction'), spec('exteriorFinish','Exterior Finish'),
  spec('garage','Garage'), spec('garageCars','# of Cars','number'), spec('inLawSuite','In-law Suite','bool'),
  spec('basementApartment','Basement Apartment','bool'), spec('roof','Type of Roof'), spec('roofYear','Year of Roof','year'),
  spec('plumbing','Type of Plumbing'), spec('plumbingYear','Year of Plumbing','year'),
  spec('electrical','Type of Electrical'), spec('electricalYear','Year of Electrical','year'),
  spec('electricalService','Electrical Service'), spec('electricalPanel','Electrical Panel'),
  spec('storeys','Number of Storeys','number'), spec('livingArea','Total Living Area','number'),
  spec('basementArea','Basement Area','number'), spec('fullBaths','Number of Full Baths','number'),
  spec('halfBaths','Number of Half Baths','number'), spec('dogExposure','Dog','bool'),
  spec('smokeDetectors','Number of Smoke Detectors','number'),
];
const policySpecs: Spec[] = [
  spec('insuredSince','Insured Since','date'), spec('propertyInsuredSince','Property - Insured Since','date'),
  spec('autoInsuredSince','Auto - Insured Since','date'), spec('priorInsurer','Property - Current Insurer'),
  spec('priorAutoInsurer','Auto - Current Insurer'), spec('smokeFree','Smoke-Free Household','bool'),
  spec('nsfCount','Number of NSFs','number'),
];
const personSpecs: Spec[] = [spec('namedInsured','Name','person'),spec('dob','Date of birth','date'),spec('gender','Gender'),spec('retired','Retired','bool')];
const headings = ['Drivers','Coverages','Claims','Convictions','Lapses','Policy Information','Insured Information',
  'Co-Insured Information','Applicant Information','Co-Applicant Information','Telematics Information','Additional Customer Information','Dwelling Information','Primary Heating','Security','Preventative Measures','Extended Coverages'];
const extraLabels = ['Vehicle Type','Single Vehicle MVD','km at Purchase','Anti-Theft - Engraving',
  'Outbuildings','Contents','Single Limit','G.B.R.C.','R.C.C. Included','Last Home Evaluation','Home Evaluation Tool',
  'Roof Renovated','Slope','Impact Resistance','Plumbing Renovated','Electrical Renovated','Finished Basement',
  'Water Heater Year','Water Main Valve Shutoff','Number of Sensors','Septic System','Approved','Year','Renovated','Type','Chimney Type',
  'Burglar Alarm','Fire Alarm','Number of Fire Extinguishers','Sprinkler System','Dead Bolt Locks','Block Watch','Walled Community','Bars on Windows',
  'Alarmed Sump Pump','Sump Pump Pit','Backup / Backflow Valve','Auxiliary Power','Water Deductible','Hail Deductible','Wind Deductible','Hail Coverage','Wind Coverage',
  'Insured with Brokerage Since','Multi-Line Policy','Combined Policy','Multi-Line for all carriers','First-Time Buyer','Date of last NSF',
  'Employer','Date Hired','Full Time','First Name','Middle Name','Last Name','Address','City','Province','Postal Code','Home Phone',
  'Salutation','Middle','Suffix','Consent Given','Type of Consent','Date Owner/Principal','Brokerage Insured','Other Licence Class','Other Licence Date',
  'Applicant lives with Parents','Description','Date','Charge','Vehicle Involved','TP/BI$','TP/PD$','AB$','Coll$','Other PD$','Duration months','Re-Instate Date'];
const dictionary = [...vehicleSpecs,...driverSpecs,...propertySpecs,...policySpecs,...personSpecs]
  .flatMap(s=>s.labels).concat(headings,extraLabels);
const dictionaryKeys = new Set(dictionary.map(labelKey));

function validValue(text: string, kind: Kind): unknown {
  const clean = cleanLayoutText(text);
  if (!clean || clean.length > 260 || dictionaryKeys.has(labelKey(clean))) return undefined;
  if(kind==='vin')return /^[A-HJ-NPR-Z0-9]{17}$/i.test(clean)?clean.toUpperCase():undefined;
  if(kind==='licence')return /^[A-Z0-9][A-Z0-9 -]{5,24}$/i.test(clean)&&/\d{4}/.test(clean)?clean.toUpperCase().replace(/[ -]/g,''):undefined;
  if(kind==='date')return templateDate(clean,'MDY');
  if(kind==='bool')return /^(yes|no)$/i.test(clean)?/^yes$/i.test(clean):undefined;
  if(kind==='number'||kind==='money'||kind==='year'){
    const n=clean.replace(/^\$\s*/,'').replace(/\s*(?:sq\.?\s*ft\.?|km)\s*$/i,'').replace(/,/g,'');
    if(!/^\d+(?:\.\d+)?$/.test(n))return undefined;
    const v=Number(n);return kind==='year'&&(!Number.isInteger(v)||v<1900||v>2100)?undefined:v;
  }
  if(kind==='person'&&(!/[A-Za-z\u00c0-\uFFFF]/.test(clean)||/[\d$]/.test(clean)||/information|insurance|policy|training|licence/i.test(clean)))return undefined;
  return clean;
}
interface Sink {data:Record<string,unknown>;fieldEvidence:Record<string,FieldEvidence[]>;warnings:ExtractionWarning[];}
function put(sink:Sink,key:string,value:unknown,cell:LayoutCell,blocked:Set<string>){
  if(cell.confidence < .9){sink.fieldEvidence[key]=[...(sink.fieldEvidence[key]??[]),...evidenceOf(cell)];sink.warnings.push({code:'NEEDS_REVIEW',field:key,severity:'medium',message:`Low-confidence ${key} on page ${cell.page}; value withheld pending review.`});return;}
  if(value===undefined){sink.fieldEvidence[key]=[...(sink.fieldEvidence[key]??[]),...evidenceOf(cell)];sink.warnings.push({code:'NEEDS_REVIEW',field:key,severity:'medium',message:`The ${key} cell could not be safely interpreted on page ${cell.page}; inspect its original location.`});return;}
  if(blocked.has(key))return;
  if(sink.data[key]!==undefined && JSON.stringify(sink.data[key])!==JSON.stringify(value)){
    delete sink.data[key];blocked.add(key);
    sink.fieldEvidence[key]=[...(sink.fieldEvidence[key]??[]),...evidenceOf(cell)];
    sink.warnings.push({code:'NEEDS_REVIEW',field:key,severity:'medium',message:`Conflicting ${key} cells in the same source group; no value selected.`});return;
  }
  sink.data[key]=value;sink.fieldEvidence[key]=[...(sink.fieldEvidence[key]??[]),...evidenceOf(cell)];
}
function extractSpecs(reader:LayoutReader,sink:Sink,specs:Spec[],from:number,to:number,blocked:Set<string>){
  for(const field of specs)for(const label of reader.find(field.labels,from,to)){
    const candidate=reader.above(label,from);
    if(candidate)put(sink,field.key,validValue(candidate.text,field.kind),candidate,blocked);
  }
}
function rangeFor(reader:LayoutReader,name:string):[number,number]|undefined{
  const start=reader.cells.find(c=>labelKey(c.text)===labelKey(name));
  if(!start)return;
  const end=reader.cells.find(c=>c.box.y>start.box.y+start.box.height && headings.some(h=>labelKey(h)===labelKey(c.text)));
  return [start.box.y+start.box.height,end?.box.y??Infinity];
}
/** Applied's geometric value-above-label tables. No positional text fallback on a known table. */
export function parseAppliedRating(raw:RawExtractedDocument,type:DocumentType):ParsedSource|undefined{
  const text=raw.text??raw.pages?.map(p=>p.text??'').join('\n')??'';
  const knownLayout=/Applied (?:Rating Services|Systems)/i.test(text) ||
    /Vehicle\s+\d+\s+of\s+\d+|Driver\s+\d+\s+of\s+\d+|Primary Dwelling/i.test(text) ||
    /(?:Co-)?Applicant Information/i.test(text)&&/First Name|Last Name/i.test(text);
  if(!knownLayout)return;
  const result:ParsedSource={documentId:String(raw.metadata?.fileId??'unidentified'),documentType:type,
    parsedAt:new Date().toISOString(),confidence:.85,data:{},fieldEvidence:{},warnings:[],entities:[],layoutVersion:1};
  const blocked=new Set<string>();
  const auto=type==='AUTO_APPLICATION'||type==='AUTO_QUOTE';
  for(const page of raw.pages??[]){
    const reader=new LayoutReader(page,dictionary);
    if(!reader.cells.length){result.warnings.push({code:'NEEDS_REVIEW',severity:'medium',message:`Page ${page.page} needs layout coordinates before Applied table values can be extracted.`});continue;}
    // Only explicit entity/table headings establish identity. A VIN elsewhere on the page does not.
    const entityHeaders=reader.cells.filter(c=>/^(?:Vehicle|Driver)\s+\d+\s+of\s+\d+\b|^Primary Dwelling\b/i.test(c.text));
    for(const [index,header] of entityHeaders.entries()){
      const vehicle=/^Vehicle/i.test(header.text),driver=/^Driver/i.test(header.text);
      if(auto&&!vehicle&&!driver||!auto&&(vehicle||driver))continue;
      const kind=vehicle?'VEHICLE':driver?'DRIVER':'PROPERTY';
      const id=`${kind.toLowerCase()}-p${page.page}-${index}`;
      const entity:ParsedEntity={id,kind,label:header.text,excluded:/\bexcluded\b/i.test(header.text),data:{},fieldEvidence:{},warnings:[]};
      const ownBlocked=new Set<string>(),from=header.box.y+header.box.height,to=entityHeaders[index+1]?.box.y??Infinity;
      if(driver){
        const name=header.text.split('|').slice(1).join('|').trim();
        put(entity,'driverName',validValue(name,'person'),header,ownBlocked);
        extractSpecs(reader,entity,driverSpecs,from,to,ownBlocked);
        // Explicit loss/lapse cells remain observations under this driver, not at-fault rulings.
        for(const section of ['Claims','Lapses']){
          const range=rangeFor(reader,section);if(!range)continue;
          const cells:Sink={data:{},fieldEvidence:{},warnings:[]};
          extractSpecs(reader,cells,[spec('description','Description'),spec('date','Date','date'),
            spec('reinstated','Re-Instate Date','date'),spec('durationMonths','Duration months','number'),
            spec('vehicle','Vehicle Involved'),spec('charge','Charge','bool'),spec('collisionLoss','Coll$','money')],range[0],range[1],new Set());
          if(Object.keys(cells.data).length){const key=section==='Claims'?'declaredClaims':'declaredLapses';
            entity.data[key]=[cells.data];entity.fieldEvidence[key]=Object.values(cells.fieldEvidence).flat();}
        }
      }else if(vehicle){
        extractSpecs(reader,entity,vehicleSpecs,from,to,ownBlocked);
        const description=header.text.split('|').slice(1).join('|').trim();
        entity.data.vehicleDescription=description;entity.fieldEvidence.vehicleDescription=evidenceOf(header);
        const year=description.match(/\b(19\d{2}|20\d{2})\b/);
        if(year)put(entity,'year',Number(year[1]),header,ownBlocked);
        // Coverage observations belong to this vehicle only, including exclusions.
        const coverageRange=rangeFor(reader,'Coverages');
        if(coverageRange){
          const rows=reader.cells.filter(c=>c.box.y>=coverageRange[0]&&c.box.y<Math.min(coverageRange[1],to));
          for(const c of rows){
            const match=c.text.match(/^(Bodily Injury|Property Damage|Direct Compensation|All Perils|Collision|Comprehensive|#\d+[^()]*)\s*\(([^()]*)\)$/i);
            if(!match)continue;
            const key=/^Bodily/i.test(match[1])?'liability':/^Direct/i.test(match[1])?'dcpdDeductible':/^All Perils/i.test(match[1])?'allPerilsDeductible':undefined;
            if(key)put(entity,key,validValue(match[2],'money'),c,ownBlocked);
            const coverage=(entity.data.coverages??[]) as unknown[];coverage.push({name:match[1],value:match[2]});
            entity.data.coverages=coverage;entity.fieldEvidence.coverages=[...(entity.fieldEvidence.coverages??[]),...evidenceOf(c)];
          }
        }
        const drivers=rangeFor(reader,'Drivers');
        if(drivers){const assigned=reader.cells.filter(c=>c.box.y>=drivers[0]&&c.box.y<drivers[1]&&/\((?:Prn|Occ)\)/i.test(c.text));
          if(assigned.length){entity.data.declaredOperators=assigned.map(c=>c.text);entity.fieldEvidence.declaredOperators=assigned.flatMap(evidenceOf);}}
      }else{
        extractSpecs(reader,entity,propertySpecs,from,to,ownBlocked);
        if(entity.data.ownerOccupied===true){entity.data.occupancy='Owner Occupied';entity.fieldEvidence.occupancy=entity.fieldEvidence.ownerOccupied;}
        const heating=rangeFor(reader,'Primary Heating');
        if(heating)extractSpecs(reader,entity,[spec('heating','Type'),spec('heatingYear','Year','year')],heating[0],heating[1],ownBlocked);
      }
      result.entities!.push(entity);
    }
    const policyRange=rangeFor(reader,'Policy Information');
    if(policyRange)extractSpecs(reader,result,policySpecs.filter(s=>auto?!['propertyInsuredSince','priorInsurer'].includes(s.key):s.key!=='insuredSince'),policyRange[0],policyRange[1],blocked);
    for(const section of ['Insured Information','Co-Insured Information']){
      const range=rangeFor(reader,section);if(!range)continue;
      const sink:Sink={data:{},fieldEvidence:{},warnings:[]};
      extractSpecs(reader,sink,personSpecs,range[0],range[1],new Set());
      for(const [key,value] of Object.entries(sink.data)){
        const dest=section.startsWith('Co-')?(key==='namedInsured'?'coInsured':'coInsured'+key[0].toUpperCase()+key.slice(1)):key;
        if(result.data[dest]===undefined){result.data[dest]=value;result.fieldEvidence[dest]=sink.fieldEvidence[key];}
        else if(JSON.stringify(result.data[dest])!==JSON.stringify(value)){delete result.data[dest];blocked.add(dest);}
      }
    }
    for(const section of ['Applicant Information','Co-Applicant Information']){
      const range=rangeFor(reader,section);if(!range)continue;
      const parts:LayoutCell[]=[];
      for(const labelName of ['First Name','Middle','Last Name','Suffix']){
        const label=reader.find([labelName],range[0],range[1])[0];
        const cell=label&&reader.above(label,range[0]);
        if(cell&&validValue(cell.text,'person')!==undefined)parts.push(cell);
      }
      // A missing last or first name cannot be silently replaced by a value from another section.
      if(parts.length>=2){const combined=joinCells(parts);put(result,section.startsWith('Co-')?'coInsured':'namedInsured',combined.text,combined,blocked);}
    }
    const carrierHeading=reader.cells.find(c=>/\bNew Business\s*\|.*Effective Date/i.test(c.text));
    if(carrierHeading){
      const carrier=reader.cells.filter(c=>Math.abs(c.box.x-carrierHeading.box.x)<3 &&
        c.box.y<carrierHeading.box.y && carrierHeading.box.y-(c.box.y+c.box.height)<12).sort((a,b)=>b.box.y-a.box.y)[0];
      if(carrier&&!/cantrust|phone|email|@|\d{3}/i.test(carrier.text))put(result,'insurer',carrier.text,carrier,blocked);
      const annual=reader.cells.find(c=>/^Annual Premium$/i.test(c.text)&&c.box.y>carrierHeading.box.y);
      if(annual){const totals=reader.cells.filter(c=>c.box.x>annual.box.x+annual.box.width&&
        Math.abs(c.box.y-annual.box.y)<3&&/^\$[\d,.]+$/.test(c.text));
        if(totals.length===1)put(result,'premium',validValue(totals[0].text,'money'),totals[0],blocked);}
    }
    for(const c of reader.cells){
      const eff=c.text.match(/\bEffective Date:\s*(\d{2}\/\d{2}\/\d{4})\b/i);
      if(eff)put(result,'effectiveDate',templateDate(eff[1],'MDY'),c,blocked);

    }
  }
  if(!result.entities!.length&&!Object.keys(result.data).length)result.warnings.push({code:'NEEDS_REVIEW',severity:'medium',message:'Applied tables detected but no safely scoped vehicle, driver or property groups were extracted.'});
  for(const entity of result.entities!)result.warnings.push(...entity.warnings);
  return result;
}

// Entirely synthetic geometric fixtures. No original client PDFs, names, licences or locations.
import assert from 'node:assert/strict';
import { parserFor, classifyDocument, PARSER_VERSION } from '../lib/document-ingestion.ts';
import { parseAppliedRating } from '../lib/applied-rating-parser.ts';
import { parseMvrLayout, parseDashLayout } from '../lib/driver-report-layout.ts';
import { pdfLayoutPage } from '../lib/pdf-layout.ts';
import { proposedDrivers } from '../lib/proposed-drivers.ts';
import { activeParsedSources, sectionRevision } from '../lib/active-evidence.ts';
import { reconcileDocumentsIntoCase } from '../lib/reconciliation.ts';
import { buildAuditorWorksheet } from '../lib/auditor-worksheet.ts';
import { createBlankAutoCase } from '../lib/case-factories.ts';
import { analyzePdfPackage } from '../lib/package-analysis.ts';
import { refreshParserVersion } from '../lib/local-reparse.ts';

const VIN='1FA6P8TH0L5100001', OTHER_VIN='2T3BFREV0JW100002';
const LICENCE='A11112222233333', OTHER_LICENCE='B44445555566666';
const block=(text,x,y,width=text.length*4.5,confidence=.99)=>({text,confidence,boundingBox:{x,y,width,height:10}});
const page=(number,blocks)=>({page:number,pageNumber:number,width:650,height:850,confidence:.99,
  blocks,text:blocks.map(b=>b.text).join('\n')});
const raw=(pages,id='SYNTHETIC_LAYOUT')=>({pages,text:pages.map(p=>p.text).join('\n'),confidence:.99,metadata:{fileId:id}});
const pair=(value,label,x,y,confidence=.99)=>[block(value,x,y,undefined,confidence),block(label,x,y+15)];
const autoPages=[
 page(1,[block('Applicant Information',25,30),...pair('MIRA','First Name',30,50),...pair('ALPHA','Last Name',220,50),
   block('Co-Applicant Information',25,95),block('First Name',30,130),block('Last Name',220,130)]),
 page(2,[block('Vehicle 1 of 2 | Private Passenger - 2022 SYNTHETIC CAR',25,25),...pair(VIN,'VIN',30,50),
   ...pair('Pleasure','Primary Use',30,90),...pair('12345','Annual km',180,90),
   ...pair('02/03/2022','Purchase Date',30,130),...pair('Yes','Winter Tires',180,130),
   block('Coverages',25,180),block('Bodily Injury (2,000,000)',30,205),block('All Perils (1,000)',270,205)]),
 page(3,[block('Vehicle 2 of 2 | Private Passenger - 2021 SYNTHETIC CAR (Excluded)',25,25),...pair(VIN,'VIN',30,50),
   ...pair('Business','Primary Use',30,90),...pair('50000','Annual km',180,90)]),
 page(4,[block('Driver 1 of 2 | MIRA ALPHA',25,25),...pair(LICENCE,'Licence Number',30,50),
   ...pair('03/12/1980','Birth Date',250,50),...pair('G','Licence Class',30,90)]),
 page(5,[block('Driver 2 of 2 | NOEL BETA',25,25),...pair(OTHER_LICENCE,'Licence Number',30,50),
   ...pair('04/13/1985','Birth Date',250,50),...pair('G2','Licence Class',30,90)])
];
const parsed=await parserFor('AUTO_QUOTE').parse(raw(autoPages));
assert.equal(parsed.data.namedInsured,'MIRA ALPHA');
assert.equal(parsed.data.coInsured,undefined,'An empty co-applicant row is not a repeated primary applicant.');
assert.equal(parsed.entities.length,4);
assert.equal(parsed.entities[0].data.vin,VIN);
assert.equal(parsed.entities[0].data.annualKm,12345);
assert.equal(parsed.entities[0].data.purchaseDate,'2022-02-03');
assert.equal(parsed.entities[0].data.liability,2000000);
assert.equal(parsed.entities[0].fieldEvidence.annualKm[0].page,2);
assert.equal(parsed.entities[1].excluded,true);
assert.equal(parsed.entities[2].data.licenceNumber,LICENCE);
assert.equal(parsed.entities[3].data.licenceNumber,OTHER_LICENCE);
assert.equal(parsed.data.vin,undefined,'Multiple vehicles are not collapsed into a policy-level VIN.');
const noGeometry=parseAppliedRating(raw(autoPages.map(p=>({...p,blocks:undefined}))),'AUTO_QUOTE');
assert.equal(noGeometry.entities.length,0);
assert.equal(noGeometry.data.vin,undefined);
assert(noGeometry.warnings.length>0);
const ambiguous=structuredClone(autoPages[1]);
ambiguous.blocks.find(b=>b.text==='12345').confidence=.4;
ambiguous.blocks.find(b=>b.text===VIN).text='INVALID_VIN';
const refused=parseAppliedRating(raw([ambiguous]),'AUTO_QUOTE');
assert.equal(refused.entities[0].data.annualKm,undefined);
assert.equal(refused.entities[0].data.vin,undefined);
assert.equal(refused.entities[0].fieldEvidence.annualKm[0].page,2);
assert(refused.entities[0].warnings.length>=2);

const home=page(8,[block('Primary Dwelling - Homeowners',20,20),block('Dwelling Information',20,40),
 ...pair('2008','Year Dwelling',30,65),block('Built',30,90),...pair('Detached','Structure',180,65),
 ...pair('Brick Veneer','Exterior Finish',30,125),...pair('2500','Total Living Area',180,125)]);
const hp=await parserFor('HAB_QUOTE').parse(raw([home]));
assert.equal(hp.entities[0].data.yearBuilt,2008);
assert.equal(hp.entities[0].data.structure,'Detached');
assert.equal(hp.entities[0].data.livingArea,2500);
assert.equal(hp.entities[0].fieldEvidence.yearBuilt[0].page,8);
const missing=structuredClone(home);missing.blocks=missing.blocks.filter(b=>b.text!=='2008');
assert.equal(parseAppliedRating(raw([missing]),'HAB_QUOTE').entities[0].data.yearBuilt,undefined,
  'A missing value above a wrapped label cannot take the previous table heading.');
const unknownApplication=await parserFor('AUTO_APPLICATION').parse(raw([page(1,[
 block('Application for Automobile Insurance',20,20),block('Effective Date: Year',20,50),
 block('INSURED',20,100),block('SIGNATURE DATE',20,120)])]));
assert.equal(unknownApplication.data.effectiveDate,undefined);
assert.equal(unknownApplication.data.namedInsured,undefined);
assert(unknownApplication.warnings.length>0);

function mvr(number,licence,name,count){return page(number,[block('MVR Abstracts',20,20),block('ONTARIO Driving Record',150,50),
 block(`***Number of Convictions: ${count} ***`,140,75),
 block('Licence Number:',30,100),block(licence,145,100),block('Expiry Date:',345,100),block('19/12/2030',470,100),
 block('Name:',30,125),block(name,145,125),block('Birth Date:',345,125),block('12/03/1980',470,125),
 block('Demerit Points: 00',30,150),block('Class: G***',220,150),block('Conditions: */N',420,150),
 block('Status: LICENCED',30,175),block('Issue Date: 21/03/2000',345,175),
 block('Requested On: 07/10/2026',30,190),block('Reply Date: 07/10/2026',345,190)]);}
// A title match cannot force a different MVR table grammar. The existing
// labelled ISO-date variant must still expose a manually confirmable driver.
const alternateMvr=page(1,[block('MVR - Ontario Driving Record',20,20),
  block('Report ID SYN-ALT',20,45),block('Name ALPHA,MIRA',20,65),
  block('Licence Number '+LICENCE,20,85),block('Reply Date 2026-10-07',20,105),
  block('Licence Class G',20,125),block('Number of Convictions 0',20,145)]);
assert.equal(parseMvrLayout(raw([alternateMvr])),undefined);
const alternateParsed=await parserFor('MVR').parse(raw([alternateMvr]));
assert.equal(alternateParsed.data.driverName,'ALPHA,MIRA');
assert.equal(alternateParsed.data.licenceNumber,LICENCE);
assert.equal(alternateParsed.data.replyDate,'2026-10-07');
assert.equal(proposedDrivers([{id:'SYNTHETIC_LAYOUT',documentType:'MVR',parsed:alternateParsed}],[]).length,1,
  'Non-CGI MVR identity must keep the Driver review and confirmation UI available.');
const clean=mvr(9,LICENCE,'ALPHA,MIRA',0),positive=mvr(10,OTHER_LICENCE,'BETA,NOEL',1);
positive.blocks.push(block('DATE CONVICTIONS, DISCHARGES AND OTHER ACTIONS',30,220),block('07/08/2024',30,245),
 block('SYNTHETIC SPEEDING RECORD',160,245),block('OFFENCE DATE 2024/08/01',160,262));
positive.text=positive.blocks.map(b=>b.text).join('\n');
const mp=parseMvrLayout(raw([clean]));
assert.equal(mp.data.licenceNumber,LICENCE);assert.equal(mp.data.dob,'1980-03-12');
assert.equal(mp.data.expiryDate,'2030-12-19');assert.deepEqual(mp.data.convictions,[]);
assert.equal(mp.data.licenceClass,'G');assert.equal(mp.data.requestDate,'2026-10-07');
assert.equal(mp.fieldEvidence.convictions[0].page,9);
const multiple=parseMvrLayout(raw([clean,positive]));
assert.equal(multiple.data.licenceNumber,undefined);assert.equal(multiple.entities.length,2);
assert.equal(multiple.entities[1].data.convictions[0].conviction_date,'2024-08-07');
assert.equal(multiple.entities[1].data.convictions[0].offence_date,'2024-08-01');
assert.equal(multiple.entities[1].data.convictions[0].severity,undefined);
const inconsistent=structuredClone(positive);inconsistent.blocks.find(b=>/Number of Convictions/.test(b.text)).text='***Number of Convictions: 2 ***';
inconsistent.text=inconsistent.blocks.map(b=>b.text).join('\n');
assert.equal(parseMvrLayout(raw([inconsistent])).data.convictions,undefined);

const dashHeader=page(11,[block('DRIVER REPORT',230,20),block('ALPHA,MIRA',30,45),block(`DLN: ${LICENCE} Ontario`,30,65),
 block('Date of Birth: 1980-03-12',30,80),block('Report Date: 2026-10-07',350,45),
 block('Number of Claims in Last 6 Years: 0',30,100)]);
const prior=page(12,[block('Policy #1',30,25),block('2020-01-01 to 2025-01-01',120,25),block('SYNTHETIC INSURER',320,25),
 block('Cancelled - non-payment',470,25),block('Policy #: TESTPOLICY',30,60),block('Policyholder Name: OTHER PERSON',30,80),
 block('Effective Date: 2020-01-01',320,60),block('Expiry Date: 2025-01-01',320,80),block('Cancellation Date: 2024-09-01',320,100),
 block('Number of Reported Operators: 1',30,120),block('Operator: OTHER PERSON',30,145)]);
const claim=(p,n,third=false)=>page(p,[block(`Claim #${n}`,30,25),block('Date of Loss 2018-02-03',110,25),block('SYNTHETIC INSURER',280,25),
 ...(third?[block('*THIRD PARTY*',430,25)]:[]),block('At-Fault : 100%',535,25),
 block(`Claim #: ${third?'******':'TESTCLAIM1'}`,30,60),block('Policy #: TESTPOLICY',30,80),block('Coverage: CL',350,60),
 block('Claim Status: Closed',350,80),block('Total Loss: $1234.50',30,105),block('Total Expense: $12.00',30,125),
 block(`Vehicle: 2022 SYNTHETIC CAR - ${VIN}`,30,150),
 block(`First Party Driver: ${third?'OTHER PERSON':'ALPHA,MIRA'}`,30,180),
 block(`First Party Driver DLN: ${third?OTHER_LICENCE:LICENCE} Ontario`,30,200),block('First Party Driver At-Fault: 100%',30,220),
 block(`Third Party Driver: ${third?'ALPHA,MIRA':'******'}`,30,250),
 block(`Third Party Driver DLN: ${third?LICENCE:'******'}`,30,270),block('Third Party Driver At-Fault: 0%',30,290)]);
const dp=parseDashLayout(raw([dashHeader,prior,claim(13,1),claim(14,2,true)]));
assert.equal(dp.data.claims.length,2,'Recent zero count does not remove historical details.');
assert.equal(dp.data.insurer,undefined,'Historical or requestor company is not the current insurer.');
assert.equal(dp.entities.find(e=>e.kind==='POLICY_HISTORY').data.status,'Cancelled - non-payment');
assert.equal(dp.data.claims[0].driver_licence_number,LICENCE);assert.equal(dp.data.claims[0].at_fault_percent,100);
assert.equal(dp.data.claims[0].party_role,'FIRST_PARTY');
assert.equal(dp.data.claims[1].party_role,'THIRD_PARTY');assert.equal(dp.data.claims[1].at_fault_percent,0);
assert.equal(dp.data.claims[1].claim_number,undefined);assert.equal(dp.data.claims[1].review_required,true);
assert.equal(dp.data.claims[0].__evidence.find(e=>e.text.includes('1234')).page,13);

// Scope survives source reconciliation. Excluded VIN copies cannot overwrite the active car.
const stamp=new Date().toISOString();
const section={id:'SECTION',physicalFileId:'SYNTHETIC_LAYOUT',documentType:'AUTO_QUOTE',title:'Synthetic',startPage:1,endPage:5,
 presenceStatus:'FOUND',parseStatus:'PARSED',validationStatus:'VALID',classificationSource:'MANUAL',createdAt:stamp,updatedAt:stamp};
const scoped={...parsed,parsedAt:stamp,logicalDocumentId:section.id,sourceRevision:sectionRevision(section)};
const record={id:'SYNTHETIC_LAYOUT',fileName:'SYNTHETIC-layout.pdf',mimeType:'application/pdf',size:1,
 sourceHash:'same',currentSourceHash:'same',documentType:'AUTO_QUOTE',state:'PARSED',
 classification:{documentType:'AUTO_QUOTE',confidence:1,reason:'synthetic'},logicalDocuments:[section],parsedSources:[scoped]};
const sources=activeParsedSources(record);assert.equal(sources.filter(s=>s.entityId).length,3);
assert(!sources.some(s=>s.data.annualKm===50000),'Excluded source observations cannot become active facts.');
const item=createBlankAutoCase();item.vehicles=[{id:'CAR',vin:VIN,year:2022,make:'SYNTHETIC',model:'CAR',annual_km:0,commute_km:0,primary_use:''}];
item.drivers=[];
const reconciled=reconcileDocumentsIntoCase(item,[record]);
assert.equal(reconciled.vehicles[0].annual_km,0,'Do not silently overwrite a Case entry; Worksheet must show sourced data separately.');
const names=reconciled.field_sources.filter(f=>f.canonicalField==='driverName');
assert.equal(names.length,2,'Unassigned drivers in the same PDF retain independent source identities.');
assert.notEqual(names[0].field,names[1].field);
const worksheet=buildAuditorWorksheet(reconciled,[record]);
const annualRow=worksheet.sections.flatMap(s=>s.rows).find(r=>r.id==='vehicle-0-annual');
assert.equal(annualRow.value,'12345');
assert.equal(annualRow.status,'extracted','An unconfirmed factory zero cannot mask valid source data.');
assert(worksheet.sections.some(s=>s.title.startsWith('EXCLUDED -')));
assert(worksheet.sections.some(s=>s.title.includes('Driver 2 of 2')));
assert(worksheet.sections.flatMap(s=>s.rows).filter(r=>r.evidence.some(e=>e.entityId)).every(r=>r.evidence.every(e=>e.documentId===record.id&&e.page)));
assert.equal(activeParsedSources({...record,currentSourceHash:'changed'}).length,0);
assert.equal(classifyDocument('combined-auto.pdf','application/pdf',autoPages[1].text).documentType,'AUTO_QUOTE');
assert.equal(classifyDocument('combined-auto.pdf','application/pdf',dashHeader.text).documentType,'DASH');
assert.equal(classifyDocument('combined-auto.pdf','application/pdf',clean.text).documentType,'MVR');

const converted=pdfLayoutPage([{str:'VIN',transform:[10,0,0,10,30,100],width:20,height:10,hasEOL:true},
 {str:VIN,transform:[10,0,0,10,30,120],width:85,height:10}],{width:600,height:800,transform:[1,0,0,-1,0,800]},1);
assert.equal(converted.blocks[1].boundingBox.y,670);
assert.equal(converted.blocks[1].boundingBox.x,30);
assert.equal(converted.text,`VIN\n${VIN}`);
let geometryReads=0,ocrCalls=0;
const file=new File(['SYNTHETIC PDF PLACEHOLDER'],'synthetic-auto-quote.pdf',{type:'application/pdf'});
const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
const adapter={async open(){return{pageCount:1,async embeddedPage(){geometryReads++;return autoPages[1];},async embeddedText(){return autoPages[1].text;},
 async renderPage(){throw Error('must not OCR native text');},close(){}}}};
const result=await analyzePdfPackage({...record,id:'synthetic-package',fileName:file.name,sourceHash:hash,logicalDocuments:undefined,
 parsedSources:undefined,packagePages:[{...autoPages[1],page:1,pageNumber:1,blocks:undefined,extractionProvider:'embedded_pdf_text',extractionStatus:'COMPLETE',classification:record.classification,sourceHash:'cached'}]},file,adapter,
 {async extract(){ocrCalls++;throw Error('No external OCR');}},{maxOcrBytes:1024000});
assert.equal(geometryReads,1,'Old text-only cache must not silently bypass layout extraction.');assert.equal(ocrCalls,0);
assert(result.packagePages[0].blocks.length>0);
const mixedSections=[{...section,id:'applied-section',startPage:2,endPage:2,classificationSource:'MANUAL'},
  {...section,id:'mvr-section',documentType:'MVR',startPage:9,endPage:9,classificationSource:'MANUAL'}];
const mixedCache={...record,parserVersion:5,extractionVersion:2,sectionAnalysisVersion:2,logicalDocuments:mixedSections,
  packagePages:[{...autoPages[1],extractionStatus:'COMPLETE',classification:{documentType:'AUTO_QUOTE'}},
    {...clean,extractionStatus:'COMPLETE',classification:{documentType:'MVR'}}],
  parsedSources:[{...scoped,logicalDocumentId:'applied-section',data:{annualKm:'WRONG LEGACY FIELD'}}]};
const refreshedMixed=await refreshParserVersion(mixedCache);
assert.equal(refreshedMixed.parserVersion,PARSER_VERSION);
assert.equal(refreshedMixed.parsedSources.find(s=>s.documentType==='AUTO_QUOTE').entities[0].data.annualKm,12345,
  'A mixed report upgrade must reparse the Applied section too, not only MVR/DASH.');
console.log('Synthetic Applied geometry, MVR/DASH identity, exclusions and source-page regressions: PASS');

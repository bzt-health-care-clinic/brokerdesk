// Synthetic applicant, vehicle and OCR layouts only; never include private source PDFs.
import assert from 'node:assert/strict';
import {parseSignedApplication} from '../lib/signed-application-layout.ts';
import {trustedOcrPage} from '../lib/ocr-page-geometry.ts';
import {analyzePdfPackage} from '../lib/package-analysis.ts';
import {reconcileDocumentsIntoCase} from '../lib/reconciliation.ts';
import {createBlankAutoCase} from '../lib/case-factories.ts';
const vin1='1HGBH41JXMN109186',vin2='1HGCM82633A004352';
const b=(text,x,y,width=Math.max(5,text.length*2.5),confidence=.99)=>({text,confidence,boundingBox:{x,y,width,height:9}});
const page=(n,blocks)=>({page:n,pageNumber:n,width:600,height:800,confidence:.99,blocks,text:blocks.map(b=>b.text).join('\n')});
const raw=pages=>({pages,text:pages.map(p=>p.text).join('\n'),metadata:{fileId:'synthetic-signed'},confidence:.99});
const chars=(value,y)=>[...value].map((c,i)=>b(c,42+i*7.3,y,3));
const auto=page(3,[b('Ontario Application for Automobile Insurance',72,7),
 b("Applicant's Name & Primary Address",43,93,132),b('Name and Address',24,113,60),b('SAMPLE INSURED',24,123,70),
 b('Policy Period',43,190,80),b('Effective Date:',23,204,80),b('Year',115,204,25),
 b('2026',119,220,18),b('10',150,220,10),b('22',181,220,10),
 b('Described Automobile',43,238,160),b('1.',23,256,8),b('2022',48,256,15),b('TOYOTA',114,256,37),b('RAV4',200,256,25),
 b('2.',23,266,8),b('2021',48,266,15),b('HONDA',114,266,37),b('CIVIC',200,266,25),
 b('Vehicle Identification No.',47,294,115),b('1.',23,312,8),...chars(vin1,312),b('2.',23,323,8),...chars(vin2,323),
 b('Estimated Annual',49,346,91),b('Driver Information – list all drivers',46,492,240),
 b("Name as shown on Driver's Licence",45,510,105),b("Driver's Licence Number",235,510,90),b('Date of Birth',398,505,70),
 b('1.',23,525,8),b('SAMPLE INSURED',120,525,85),b('S11111111111111',272,525,60),
 b('1980',376,525,17),b('10',416,525,12),b('22',449,525,12),b('Special Notes:',23,665,100)]);
const parsed=parseSignedApplication(raw([auto]),'AUTO_APPLICATION');
assert.equal(parsed.data.namedInsured,'SAMPLE INSURED');
assert.equal(parsed.data.effectiveDate,'2026-10-22');
assert.equal(parsed.entities.filter(e=>e.kind==='VEHICLE').length,2);
assert.deepEqual(parsed.entities.filter(e=>e.kind==='VEHICLE').map(e=>e.data.vin),[vin1,vin2]);
assert.equal(parsed.entities.find(e=>e.kind==='DRIVER').data.dob,'1980-10-22');
assert(parsed.entities.every(e=>Object.values(e.fieldEvidence).flat().every(proof=>proof.page===3 && proof.boundingBox)));
assert.equal(parsed.entities[0].data.vehicleUse,undefined,'Checkbox positions cannot be interpreted from selectable text.');
const history=page(4,[b('Previous Accidents and Insurance Claims',80,245,260),
 b('Date',103,282,25),b('1',35,302,6),b('2019',72,302,21),b('07',108,302,12),b('28',139,302,12),
 b('History of Convictions',87,381,170),b('Date Convicted',66,407,90),
 b('2',35,428,6),b('2025',54,428,21),b('11',86,428,12),b('06',112,428,12),b('Synthetic offence',129,428,85)]);
const withHistory=parseSignedApplication(raw([auto,history]),'AUTO_APPLICATION');
const insuredOne=withHistory.entities.find(e=>e.kind==='DRIVER'&&e.id.endsWith('-1'));
assert.equal(insuredOne.data.declaredClaims[0].date,'2019-07-28');
assert.equal(insuredOne.fieldEvidence.declaredClaims[0].page,4);
const insuredTwo=withHistory.entities.find(e=>e.kind==='DRIVER'&&e.id.endsWith('-2'));
assert.equal(insuredTwo.data.declaredConvictions[0].description,'Synthetic offence');
assert.equal(insuredTwo.fieldEvidence.declaredConvictions[0].page,4);
assert.equal(insuredOne.data.declaredConvictions,undefined);
const withoutBoxes=parseSignedApplication(raw([{...auto,blocks:undefined}]),'AUTO_APPLICATION');
assert.equal(withoutBoxes.data.namedInsured,undefined);
assert(!withoutBoxes.entities.length);
assert(withoutBoxes.warnings.some(w=>w.code==='APPLICATION_LAYOUT_REVIEW'));
const ambiguous=structuredClone(auto);ambiguous.blocks=ambiguous.blocks.filter(c=>!(c.text==='2022'&&c.boundingBox.y===256));
const noYear=parseSignedApplication(raw([ambiguous]),'AUTO_APPLICATION');
assert.equal(noYear.entities.find(e=>e.data.vin===vin1).data.year,undefined,'Missing year cannot be copied from the next car.');
const home1=page(1,[b('HABITATIONAL INSURANCE APPLICATION',157,22,226),
 b("APPLICANT'S FULL NAME AND POSTAL ADDRESS",38,80,232),b('NAME',21,96,15),b('CASE EXAMPLE',53,99,65),
 b("BROKER'S NAME AND POSTAL ADDRESS",325,80,220),b('NAME',308,96,15),b('OTHER BROKER INC',339,99,102),
 b('POLICY PERIOD',38,268,100),b('EFFECTIVE DATE',21,283,44),b('2026/10/22',70,286,52),
 b('EXPIRY DATE',308,283,43),b('2027/10/22',356,286,52),b('INSURED SINCE',194,520,47),b('2023/03/09',254,516,52)]);
const home2=page(2,[b('HABITATIONAL INSURANCE APPLICATION',157,22,226),
 b('RISK ADDRESS',38,55,74),b('ADDRESS',21,71,32),b('10 MOCK ROAD',62,71,95),
 b('CITY,',385,71,30),b('SYNTHETIC',420,71,56),b('Z9Z9Z9',530,72,40),
 b('RATING INFORMATION',38,95,120),b('YEAR BUILT',21,109,30),b('2018',70,108,19),
 b('FAMILIES',149,112,28),b('1',181,108,5),b('TOTAL LIVING AREA',265,105,50),b('1500',328,108,22),
 b('STRUCTURE TYPE',21,160,47),b('Detached',110,161,48),b('SMOKERS?',534,109,40),b('YES',575,105,17)]);
const hp=parseSignedApplication(raw([home1,home2]),'HAB_APPLICATION');
assert.equal(hp.data.namedInsured,'CASE EXAMPLE');
assert.equal(hp.data.propertyInsuredSince,'2023-03-09');
assert.equal(hp.entities[0].data.yearBuilt,2018);
assert.equal(hp.entities[0].data.livingArea,1500);
assert.equal(hp.entities[0].data.families,1);
assert.equal(hp.entities[0].data.smokeFree,undefined);
assert(hp.entities[0].warnings.some(w=>w.code==='CHECKBOX_REVIEW'));
const gc=(x,y,width,height,text,confidence=.98)=>({text,confidence,boundingBox:{x,y,width,height}});
const ocrPage={page:1,width:1200,height:1600,rotation:0,blocks:[gc(100,200,220,20,'HABITATIONAL INSURANCE APPLICATION'),gc(20,225,100,20,'NAME'),gc(140,225,140,20,'SAMPLE PERSON')]};
const valid=trustedOcrPage(ocrPage,{page:1,width:600,height:800},3);
assert.equal(valid.trusted,true);assert.equal(valid.page,3);assert.equal(valid.blocks[1].boundingBox.x,10);
assert.equal(valid.blocks[1].boundingBox.y,112.5);
assert.equal(trustedOcrPage({...ocrPage,rotation:90},{page:1,width:600,height:800},1).trusted,false);
assert.equal(trustedOcrPage({...ocrPage,width:undefined},{page:1,width:600,height:800},1).trusted,false);
assert.equal(trustedOcrPage({...ocrPage,blocks:[{...ocrPage.blocks[0],confidence:undefined}]},{page:1,width:600,height:800},1).trusted,false);
assert.equal(trustedOcrPage({...ocrPage,blocks:[{...ocrPage.blocks[0],boundingBox:{x:5000,y:20,width:100,height:10}}]},{page:1,width:600,height:800},1).trusted,false);

const file=new File([new Uint8Array([1,2,3,4])],'signed-home-scan.pdf',{type:'application/pdf'});
const fakeAdapter={async open(){return {pageCount:1,async embeddedPage(){return {page:1,width:600,height:800,text:'',blocks:[]};},async embeddedText(){return '';},async renderPage(){return new File([new Uint8Array([3,4])],'page-1.jpg',{type:'image/jpeg'});},close(){}}}};
const fakeOcr={async extract(){return {text:'HABITATIONAL INSURANCE APPLICATION\nNAME: SAMPLE PERSON',pages:[ocrPage],confidence:.98,metadata:{provider:'ocr_space'}};}};
const starting={id:'synthetic-scan',fileName:file.name,mimeType:'application/pdf',size:file.size,documentType:'HAB_APPLICATION',classification:{documentType:'HAB_APPLICATION',confidence:.95,reason:'synthetic'},state:'UPLOADED'};
const extracted=await analyzePdfPackage(starting,file,fakeAdapter,fakeOcr,{maxOcrBytes:10000});
assert.equal(extracted.packagePages.length,1);assert.equal(extracted.packagePages[0].ocrGeometryVerified,true);
assert.equal(extracted.packagePages[0].blocks[1].boundingBox.x,10);
assert.equal(extracted.state,'NEEDS_REVIEW','OCR never becomes a broker-confirmed signed application.');
const badOcr=await analyzePdfPackage(starting,file,fakeAdapter,{async extract(){return {...await fakeOcr.extract(),pages:[{...ocrPage,width:undefined}]};}},{maxOcrBytes:10000});
assert.equal(badOcr.packagePages[0].ocrGeometryVerified,false);
assert.equal(badOcr.packagePages[0].blocks.length,0);
assert.equal(badOcr.state,'NEEDS_REVIEW');
const unavailable=await analyzePdfPackage(starting,file,fakeAdapter,{async extract(){throw Error('Local OCR unavailable');}},{maxOcrBytes:10000});
assert.equal(unavailable.packagePages[0].extractionStatus,'FAILED');
assert.equal(unavailable.state,'NEEDS_REVIEW');
const caseData=createBlankAutoCase();
caseData.vehicles=[{id:'vehicle-1',vin:vin1,year:2022,make:'MOCK',model:'CAR',annual_km:0,commute_km:0}];
const ocrSource={documentId:'scan',documentType:'AUTO_QUOTE',parsedAt:new Date().toISOString(),confidence:.99,
 data:{vin:vin1,annualKm:8888},fieldEvidence:{vin:[{page:1,text:vin1,provider:'ocr_space',confidence:.99}],annualKm:[{page:1,text:'8888',provider:'ocr_space',confidence:.99}]},warnings:[]};
const active={id:'scan',fileName:'scan.pdf',documentType:'AUTO_QUOTE',state:'PARSED',parsed:ocrSource};
const after=reconcileDocumentsIntoCase(caseData,[active]);
assert.equal(after.vehicles[0].annual_km,0,'Unconfirmed OCR cannot silently write a policy vehicle field.');
assert(after.field_sources.some(f=>f.canonicalField==='annualKm' && f.evidenceReview));
console.log('Signed CSIO / OAF1 geometry, safe checkbox handling, confidence-scored OCR coordinates, failure cases and OCR reconciliation gate: PASS');

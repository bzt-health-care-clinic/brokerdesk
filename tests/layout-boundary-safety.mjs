// Invented fixtures only. No real client values, PDF text or images.
import assert from 'node:assert/strict';
import {parseAppliedRating} from '../lib/applied-rating-parser.ts';
import {parseMvrLayout,parseDashLayout} from '../lib/driver-report-layout.ts';
const block=(text,x,y,width=100,confidence=.99)=>({text,confidence,boundingBox:{x,y,width,height:10}});
const page=(blocks,n=1)=>({page:n,pageNumber:n,width:650,height:900,text:blocks.map(b=>b.text).join('\n'),blocks,confidence:.99});
const raw=pages=>({text:pages.map(p=>p.text).join('\n'),pages,confidence:.99,metadata:{fileId:'TEST-BOUNDARIES'}});
const header=(text,y)=>block(text,25,y,520);
const cell=(label,value,x,y)=>[block(value,x,y),block(label,x,y+13)];
const firstDriver=[header('Driver 1 of 2 | ALPHA MIRA',15),...cell('Licence Number','A12345678901234',25,40),
 header('Claims',85),...cell('Description','Collision',25,105),...cell('Date','02/01/2020',210,105),
 header('Lapses',145),...cell('Description','Non payment',25,165),...cell('Date','03/02/2021',210,165)];
const secondDriver=[header('Driver 2 of 2 | BETA NOEL',230),...cell('Licence Number','B12345678901234',25,255),
 header('Claims',300),...cell('Description','Comprehensive',25,320),...cell('Date','04/03/2022',210,320),
 ...cell('Description','Glass',25,365),...cell('Date','05/04/2023',210,365),
 header('Convictions',405),...cell('Description','Synthetic moving violation',25,425),...cell('Date','06/05/2024',260,425),
 header('Lapses',465),...cell('Description','No vehicle',25,485),...cell('Date','07/06/2025',210,485)];
const parsed=parseAppliedRating(raw([page([...firstDriver,...secondDriver])]),'AUTO_QUOTE');
assert.equal(parsed.entities.length,2);
assert.equal(parsed.entities[0].data.declaredClaims[0].description,'Collision');
assert.deepEqual(parsed.entities[1].data.declaredClaims.map(x=>x.description),['Comprehensive','Glass']);
assert.equal(parsed.entities[1].data.declaredLapses[0].description,'No vehicle');
assert.equal(parsed.entities[1].data.declaredConvictions[0].description,'Synthetic moving violation');
assert.equal(parsed.entities[0].data.declaredLapses[0].date,'2021-03-02');
assert(parsed.entities[1].fieldEvidence.declaredClaims.every(e=>e.page===1&&e.boundingBox));
const vehicles=parseAppliedRating(raw([page([
 header('Vehicle 1 of 2 | 2020 SYNTHETIC CAR',15),...cell('VIN','1HGBH41JXMN109186',25,40),
 header('Drivers',80),header('ALPHA MIRA (Prn)',105),header('Coverages',130),header('Bodily Injury (1,000,000)',155),
 header('Vehicle 2 of 2 | 2021 SYNTHETIC CAR',220),...cell('VIN','1HGCM82633A004352',25,245),
 header('Drivers',285),header('BETA NOEL (Prn)',310),header('Coverages',335),header('Bodily Injury (2,000,000)',360)
])]),'AUTO_QUOTE');
assert.equal(vehicles.entities[1].data.liability,2000000);
assert.deepEqual(vehicles.entities[1].data.declaredOperators,['BETA NOEL (Prn)']);
const partialApplicant=page([header('Applicant Information',10),...cell('First Name','Mira',25,35),...cell('Middle','Anne',200,35),block('Last Name',380,48)]);
assert.equal(parseAppliedRating(raw([partialApplicant]),'AUTO_QUOTE').data.namedInsured,undefined,
 'First+middle is not a full name when surname is absent.');
const mvrBlocks=(y,lic,name,conf=.99)=>[header('ONTARIO Driving Record',y),
 block('***Number of Convictions: 0 ***',100,y+20,220,conf),
 block('Licence Number: '+lic,30,y+50,220),block('Expiry Date: 01/01/2030',350,y+50,240),
 block('Name: '+name,30,y+70,200),block('Class: G',350,y+70),
 block('*** END OF REPORT / FIN DU RAPPORT ***',100,y+100,360)];
const mv=parseMvrLayout(raw([page([...mvrBlocks(10,'A12345678901234','ALPHA,MIRA'),...mvrBlocks(300,'B12345678901234','BETA,NOEL')])]));
assert.equal(mv.entities.length,2);assert.equal(mv.entities[1].data.driverName,'BETA,NOEL');
assert.equal(mv.data.licenceNumber,undefined);
const low=parseMvrLayout(raw([page(mvrBlocks(10,'A12345678901234','ALPHA,MIRA',.4))]));
assert.equal(low.data.convictions,undefined);assert(low.warnings.some(w=>/low confidence/i.test(w.message)));
const dashHead=page([header('DRIVER REPORT',10),block('ALPHA,MIRA',30,35),
 block('DLN: A12345678901234 Ontario',30,55,270),block('Report Date: 2026-01-01',360,35,220)]);
const claim=(y,n,first)=>[header('Claim #'+n,y),block('Date of Loss 2020-01-01',150,y,200),
 block('Claim #: CLAIM-'+n,30,y+25),block('First Party Driver: OTHER PERSON',30,y+45,280),
 block('First Party Driver DLN: '+first,30,y+65,280),block('First Party Driver At-Fault: 100%',30,y+85,300)];
const dash=parseDashLayout(raw([dashHead,page([...claim(10,1,'B12345678901234'),...claim(250,2,'A12345678901234')],2)]));
assert.equal(dash.data.claims.length,2);
assert.equal(dash.data.claims[0].party_role,'UNKNOWN');
assert.equal(dash.data.claims[0].at_fault_percent,undefined,'A different driver cannot inherit the report subject attribution.');
assert.equal(dash.data.claims[1].party_role,'FIRST_PARTY');
assert.equal(dash.data.claims[1].at_fault_percent,100);
const orphan=parseDashLayout(raw([page(claim(10,1,'B12345678901234'),7)]));
assert.equal(orphan.data.claims[0].party_role,'UNKNOWN');
assert(orphan.warnings.length);
console.log('Layout boundary safety: same-page groups, repeated records, partial names, uncertain MVR zero, DASH attribution: PASS');

// Unknown grouped identity must not bind merely because the Case has one person/car.
const {buildAuditorWorksheet}=await import('../lib/auditor-worksheet.ts');
const {createBlankAutoCase,createBlankHabCase}=await import('../lib/case-factories.ts');
const {reconcileDocumentsIntoCase}=await import('../lib/reconciliation.ts');
const sectionRecord=parsed=>({id:parsed.documentId,fileName:'synthetic-boundaries.pdf',sourceHash:'SAME',currentSourceHash:'SAME',
 documentType:parsed.documentType,mimeType:'application/pdf',state:'PARSED',
 logicalDocuments:[{id:'SEC',physicalFileId:parsed.documentId,documentType:parsed.documentType,presenceStatus:'FOUND',startPage:1,endPage:9}],
 parsedSources:[{...parsed,logicalDocumentId:'SEC'}]});
const caseOne=createBlankAutoCase();
caseOne.vehicles=[{id:'ONE-CAR',vin:'1HGBH41JXMN109186',year:2020,make:'SYNTHETIC',model:'CAR',annual_km:0,commute_km:0}];
caseOne.drivers=[{id:'ONE-DRIVER',name:'ALPHA MIRA',licence_number:'A12345678901234',licence_class:'',telematics:{enabled:false},convictions:[]}];
const unassigned={documentId:'SYN-UNKNOWN',documentType:'AUTO_QUOTE',confidence:.95,parsedAt:new Date().toISOString(),data:{},fieldEvidence:{},warnings:[],
 entities:[{id:'unknown-car',kind:'VEHICLE',label:'Unidentified vehicle',data:{annualKm:7777},fieldEvidence:{annualKm:[{page:2,text:'7777'}]},warnings:[]},
 {id:'unknown-person',kind:'DRIVER',label:'Unidentified driver',data:{licenceClass:'G'},fieldEvidence:{licenceClass:[{page:3,text:'G'}]},warnings:[]}]};
const ws=buildAuditorWorksheet(caseOne,[sectionRecord(unassigned)]);
const wsrow=id=>ws.sections.flatMap(s=>s.rows).find(r=>r.id===id);
assert.equal(wsrow('vehicle-0-annual').status,'missing');
assert.equal(wsrow('driver-0-class').status,'missing');
assert(ws.sections.some(s=>s.title.includes('Unidentified driver')),'Unassigned observations remain visible in their own group.');

const mixedReports=parseDashLayout(raw([
 dashHead,page(claim(10,1,'A12345678901234'),2),
 page([header('DRIVER REPORT',10),block('BETA,NOEL',30,35),block('DLN: B12345678901234 Ontario',30,55,270)],3),
 page(claim(10,2,'B12345678901234'),4)]));
caseOne.drivers.push({...caseOne.drivers[0],id:'TWO-DRIVER',name:'BETA NOEL',licence_number:'B12345678901234'});
const multi=reconcileDocumentsIntoCase(caseOne,[sectionRecord(mixedReports)]);
assert.equal(multi.claims.length,2);
assert.equal(multi.claims[0].report_subject_id,'ONE-DRIVER');
assert.equal(multi.claims[1].report_subject_id,'TWO-DRIVER');
const bothOnOne=page([
 ...dashHead.blocks,...claim(120,1,'A12345678901234'),
 header('DRIVER REPORT',400),block('BETA,NOEL',30,425),block('DLN: B12345678901234 Ontario',30,445,270),
 ...claim(500,2,'B12345678901234')]);
const samePageReports=parseDashLayout(raw([bothOnOne]));
assert.equal(samePageReports.data.claims.length,2);
assert.equal(samePageReports.data.claims[0].report_subject_licence,'A12345678901234');
assert.equal(samePageReports.data.claims[1].report_subject_licence,'B12345678901234');
const policies=parseDashLayout(raw([page([
 header('Policy #1',10),block('Policy #: SYN-OLD-1',30,35,180),block('Effective Date: 2020-01-01',30,55,220),
 header('Policy #2',200),block('Policy #: SYN-OLD-2',30,225,180),block('Effective Date: 2021-01-01',30,245,220)
]) ]));
assert.deepEqual(policies.entities.filter(e=>e.kind==='POLICY_HISTORY').map(e=>e.data.policyNumber),['SYN-OLD-1','SYN-OLD-2']);

const contradictory=parseMvrLayout(raw([page([...mvrBlocks(10,'A12345678901234','ALPHA,MIRA'),
 block('Number of Convictions: 1',30,50,220)])]));
assert.equal(contradictory.data.convictions,undefined);
const ambiguous=page([...mvrBlocks(10,'A12345678901234','ALPHA,MIRA').filter(b=>!b.text.includes('END OF REPORT')),
 header('CONVICTIONS, DISCHARGES',140),block('01/01/2020',25,165,90,.3),block('Uncertain offence',160,165,130,.3)]);
assert.equal(parseMvrLayout(raw([ambiguous])).data.convictions,undefined,'Low-confidence detail rows cannot be ignored to justify zero convictions.');
const homeCase=createBlankHabCase();homeCase.habitational_risk.risk_address='10 EXAMPLE RD';
const foreignProperty={...unassigned,documentId:'SYN-HOME',documentType:'HAB_QUOTE',entities:[{
 id:'different-property',kind:'PROPERTY',label:'Other property',data:{riskAddress:'20 OTHER RD',yearBuilt:1965},
 fieldEvidence:{riskAddress:[{page:1,text:'20 OTHER RD'}],yearBuilt:[{page:1,text:'1965'}]},warnings:[]}]};
const homeSheet=buildAuditorWorksheet(homeCase,[sectionRecord(foreignProperty)]);
assert.equal(homeSheet.sections.flatMap(s=>s.rows).find(r=>r.id==='property-year').evidence.length,0);
assert.notEqual(reconcileDocumentsIntoCase(homeCase,[sectionRecord(foreignProperty)]).habitational_risk.year_built,1965);
console.log('Source association safety: no single-subject shortcuts, per-report claim subject and property identity: PASS');
const {applyPolicyChangeState}=await import('../lib/policy-change.ts');
const editCase=createBlankAutoCase();editCase.drivers=[{...caseOne.drivers[0],id:undefined}];editCase.vehicles=caseOne.vehicles;
editCase.policy_change={requested_changes:[{type:'DELETE_DRIVER'}]};
assert.equal(applyPolicyChangeState(editCase).drivers.length,1,'Absent subject identifier cannot delete a driver.');
editCase.policy_change.requested_changes=[{type:'DELETE_DRIVER',subject_id:'INVALID',subject_name:'ALPHA MIRA'}];
assert.equal(applyPolicyChangeState(editCase).drivers.length,1,'Invalid explicit ID cannot fall back to another named person.');
editCase.policy_change.requested_changes=[{type:'DRIVER_REASSIGNMENT',subject_name:'ALPHA MIRA'}];
assert.equal(applyPolicyChangeState(editCase).drivers[0].assigned_vehicle,undefined);
console.log('Policy Change identity guards: missing IDs and assignments remain unconfirmed: PASS');

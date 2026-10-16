// Synthetic, document-bound names: punctuation-order normalization, OCR copy hints,
// absent co_insured and server-side identity authorization semantics.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../local-server/database.mjs";
import { resolveDataPaths } from "../local-server/paths.mjs";
import { LocalRepositories } from "../local-server/repositories.mjs";
import { createBlankHabCase, createBlankPolicyChangeCase } from "../lib/case-factories.ts";
import { sameNamedPersons, insuredPersonNames } from "../lib/intake-person-evidence.ts";
import { parsedPolicyholderSuggestions, appendSuggestedPolicyholder } from "../lib/intake-name-suggestions.ts";
import { evaluateIntakeProfile } from "../lib/intake-profile.ts";
import { parserFor } from "../lib/document-ingestion.ts";

assert(sameNamedPersons(["DOE, JOHN"], ["JOHN DOE"]));
assert(sameNamedPersons(["John  Doe"], ["DOE, JOHN."]));
assert(sameNamedPersons(["ANN LEE", "BOB CHEN"], ["CHEN, BOB", "LEE, ANN"]));
assert(sameNamedPersons(["O'NEIL-MARY"], ["MARY O’NEIL"]));
assert(!sameNamedPersons(["JOHN DOE"], ["JOHN DOE JR"]));
assert(!sameNamedPersons(["JOHN DOE"], ["JANE DOE"]));
assert(!sameNamedPersons(["JOHN DOE", "JOHN DOE"], ["JOHN DOE", "JOHN DOE"]));
assert(!sameNamedPersons(["JOHN DOE", "DOE, JOHN"], ["JOHN DOE", "DOE, JOHN"]));
assert(!sameNamedPersons([], []));
assert(!sameNamedPersons([""], [""]));
assert(!sameNamedPersons(["!!!"], ["!!!"]));
assert(!sameNamedPersons(["JOHN DOE"], ["JOHN DOE", "ANN LEE"]));
assert(!sameNamedPersons(["JOHN DOE"], ["JOHN"]));
assert(!sameNamedPersons([null], [null]));

// Quote parsing must also expose the second applicant; suggestions remain manual hints.
const autoParsed=await parserFor("AUTO_QUOTE").parse({
  text:"Named Insured: DOE, JOHN\nCo-Insured: LEE, ANN",pages:[],confidence:.95
});
assert.equal(autoParsed.data.namedInsured,"DOE, JOHN");
assert.equal(autoParsed.data.coInsured,"LEE, ANN");
const habParsed=await parserFor("HAB_QUOTE").parse({
  text:"Named Insured: DOE, JOHN\nSecond Named Insured: LEE, ANN",pages:[],confidence:.95
});
assert.equal(habParsed.data.namedInsured,"DOE, JOHN");
assert.equal(habParsed.data.coInsured,"LEE, ANN");

const section=(id,documentType)=>({id:id+"SEC",physicalFileId:id,documentType,
  title:"Synthetic source",startPage:1,endPage:1,presenceStatus:"FOUND",
  parseStatus:"PARSED",validationStatus:"VALID",classificationSource:"MANUAL"});
const appRecord={
  id:"P-APP",fileName:"signed_application.pdf",sourceHash:"HASH-APP",
  currentSourceHash:"HASH-APP",documentType:"HAB_APPLICATION",
  logicalDocuments:[section("P-APP","HAB_APPLICATION")],
  parsedSources:[{documentId:"P-APP",logicalDocumentId:"P-APPSEC",
    documentType:"HAB_APPLICATION",data:{namedInsured:"DOE, JOHN",coInsured:"LEE, ANN"}}]
};
const quoteRecord={
  id:"P-QUOTE",fileName:"quote.pdf",sourceHash:"HASH-Q",
  currentSourceHash:"HASH-Q",documentType:"HAB_QUOTE",
  logicalDocuments:[section("P-QUOTE","HAB_QUOTE")],
  parsedSources:[{documentId:"P-QUOTE",logicalDocumentId:"P-QUOTESEC",
    documentType:"HAB_QUOTE",data:{namedInsured:"John Doe"}}]
};
assert.deepEqual(parsedPolicyholderSuggestions([appRecord,quoteRecord],
  "P-APP","P-APPSEC","HAB_APPLICATION"),[
  {name:"DOE, JOHN",role:"Named insured"},{name:"LEE, ANN",role:"Co-insured"}]);
assert.deepEqual(parsedPolicyholderSuggestions([appRecord,quoteRecord],
  "P-QUOTE","P-QUOTESEC","HAB_QUOTE"),[
  {name:"John Doe",role:"Named insured"}]);
assert.deepEqual(parsedPolicyholderSuggestions([appRecord,quoteRecord],
  "P-APP","P-QUOTESEC","HAB_APPLICATION"),[]);
assert.deepEqual(parsedPolicyholderSuggestions([{...appRecord,currentSourceHash:"TAMPERED"}],
  "P-APP","P-APPSEC","HAB_APPLICATION"),[]);
assert.deepEqual(parsedPolicyholderSuggestions([{...appRecord,withdrawnSectionRanges:[{startPage:1,endPage:1}]}],
  "P-APP","P-APPSEC","HAB_APPLICATION"),[]);
assert.equal(appendSuggestedPolicyholder("", "DOE, JOHN"),"DOE, JOHN");
assert.equal(appendSuggestedPolicyholder("JOHN DOE", "DOE, JOHN"),"JOHN DOE");
assert.equal(appendSuggestedPolicyholder("JOHN DOE", "LEE, ANN"),"JOHN DOE\nLEE, ANN");
assert.equal(appendSuggestedPolicyholder("JOHN DOE","!!!"),"JOHN DOE");

const root=mkdtempSync(join(tmpdir(),"brokerdesk-synthetic-named-people-"));
const paths=resolveDataPaths({...process.env,BROKERDESK_DATA_DIR:root});
const db=openDatabase(paths.database);
const repo=new LocalRepositories(db,paths);
function addDoc(item,id,type) {
  const bytes=Buffer.from("Synthetic source file "+id);
  repo.saveDocument(item.case_id,{id,fileName:id+".pdf",mimeType:"application/pdf",
    size:bytes.length,documentType:type,
    classification:{documentType:type,confidence:1,reason:"synthetic"},
    state:"PARSED",logicalDocuments:[section(id,type)]},bytes,id+".pdf");
}
try {
  const home=createBlankHabCase();
  home.policy.company="Intact";
  home.policy.effective_date="2026-10-16";
  home.policy.client_code="SYNNAMES";
  home.insured={name:"DOE, JOHN"}; // historical entry with no co_insured field
  assert.deepEqual(insuredPersonNames(home),["DOE, JOHN"]);
  repo.upsertCase({case:home},"CREATE_CASE");
  addDoc(home,"SIGNED_APP","HAB_APPLICATION");addDoc(home,"QUOTED","HAB_QUOTE");
  repo.saveSignedCase(home.case_id,{
    ...repo.getCase(home.case_id),
    signed_document_id:"SIGNED_APP",signed_logical_document_id:"SIGNED_APPSEC"
  },"SIGNED_VERIFIED");
  const compared={verified:true,applicationDocumentId:"SIGNED_APP",
    applicationLogicalDocumentId:"SIGNED_APPSEC",quoteDocumentId:"QUOTED",
    quoteLogicalDocumentId:"QUOTEDSEC",applicationNames:["DOE, JOHN"],quoteNames:["JOHN DOE."]};
  const saved=repo.saveNamedInsuredComparison(home.case_id,compared);
  assert.equal(saved.named_insured_comparison.application_names[0],"DOE, JOHN"); // unchanged presentation
  assert.equal(saved.named_insured_comparison.quote_names[0],"JOHN DOE.");
  assert(!evaluateIntakeProfile(saved,repo.listDocuments(home.case_id)).blockers
    .some(issue=>["INTAKE_INSURED_NAME_EVIDENCE","INTAKE_INSURED_NAME_MISMATCH"].includes(issue.code)));
  repo.saveNamedInsuredComparison(home.case_id,{...compared,quoteNames:["JANE DOE"]});
  assert(evaluateIntakeProfile(repo.getCase(home.case_id),repo.listDocuments(home.case_id)).blockers
    .some(issue=>issue.code==="INTAKE_INSURED_NAME_MISMATCH"));
  assert.throws(()=>repo.saveNamedInsuredComparison(home.case_id,{
    ...compared,applicationNames:["JOHN DOE","DOE, JOHN"]}),
    /unique document-specific/);

  // Server and intake must both accept absent co_insured for signed single-name cancellation.
  const change=createBlankPolicyChangeCase();
  change.policy.company="Intact";change.policy.client_code="SYNCHANGE";
  change.policy.effective_date="2026-10-16";
  change.insured={name:"DOE, JOHN"};
  change.policy_change.transaction_types=["CANCELLATION"];
  change.policy_change.requested_action="Cancellation";
  change.policy_change.change_effective_date="2026-10-16";
  repo.upsertCase({case:change},"CREATE_CASE");
  addDoc(change,"CANCEL_REQ","CANCELLATION_REQUEST");
  const first={name:"John Doe",documentId:"CANCEL_REQ",logicalDocumentId:"CANCEL_REQSEC",
    signaturePage:1,verified:true};
  const single=repo.saveTransactionAuthorization(change.case_id,{
    verified:true,documentId:"CANCEL_REQ",logicalDocumentId:"CANCEL_REQSEC",signers:[first]});
  assert.equal(repo.transactionAuthorizationStillValid(single),true);
  assert(!evaluateIntakeProfile(single,repo.listDocuments(change.case_id)).blockers.some(issue=>
    ["INTAKE_POLICYHOLDER_IDENTITY","INTAKE_CHANGE_AUTHORIZATION","INTAKE_POLICYHOLDER_SIGNATURES"]
      .includes(issue.code)));

  // Joint policy names and their signatures can both use a different order.
  const joint={...single,insured:{name:"DOE, JOHN",co_insured:[{name:"LEE, ANN"}]}};
  repo.upsertCase({case:joint});
  const next=repo.saveTransactionAuthorization(change.case_id,{
    verified:true,documentId:"CANCEL_REQ",logicalDocumentId:"CANCEL_REQSEC",
    signers:[first,{...first,name:"Ann Lee"}]});
  assert(repo.transactionAuthorizationStillValid(next));
  assert.deepEqual(insuredPersonNames(next),["DOE, JOHN","LEE, ANN"]);
  assert(!evaluateIntakeProfile(next,repo.listDocuments(change.case_id)).blockers
    .some(issue=>issue.code==="INTAKE_POLICYHOLDER_SIGNATURES"));
  repo.upsertCase({case:{...next,insured:{
    name:"DOE, JOHN",co_insured:[{name:"JOHN DOE"}]}}});
  assert.equal(repo.getCase(change.case_id).transaction_authorization,undefined);
  assert.equal(insuredPersonNames(repo.getCase(change.case_id)).length,0);
  console.log("BrokerDesk document name-token and single/joint insured regressions: PASS");
} finally {
  db.close();rmSync(root,{recursive:true,force:true});
}

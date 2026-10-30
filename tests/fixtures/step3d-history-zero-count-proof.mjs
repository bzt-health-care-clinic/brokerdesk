/**
 * Test-only adapter for Step 3D's old zero-history fixtures.
 *
 * The caller MUST supply an actual synthetic report page carrying the explicit
 * full-report count declaration. This function never invents a page number or
 * generates evidence from pulledDate, an empty list, or a six-year summary.
 * Not used in production.
 */
const labelFor={
  reportedConvictionCount:"TOTAL REPORTED CONVICTIONS: 0",
  reportedClaimCount:"TOTAL REPORTED CLAIMS (ENTIRE REPORT): 0"
};
const validHash=h=>/^[a-f0-9]{64}$/i.test(h||"");
export function bindSyntheticZeroHistoryProof(context,{key,page}={}) {
 const label=labelFor[key];
 if(!label)throw Error("Count proof key must identify the exact reported count.");
 if(!Number.isSafeInteger(page)||page<1)throw Error("Explicit physical page required.");
 const {record={},observation={}}=context??{};
 if(observation.data?.[key]!==0)
  throw Error(`Fixture must declare ${key}: 0 explicitly.`);
 if(!record.id||observation.documentId!==record.id
   ||!validHash(record.sourceHash)||record.sourceHash!==context.hash)
  throw Error("Verified physical source record and matching SHA-256 required.");
 const pageData=(record.packagePages??[]).find(p=>(p.page??p.pageNumber)===page);
 if(!pageData||typeof pageData.text!=="string"||!pageData.text.includes(label))
  throw Error(`Synthetic page ${page} must contain the literal ${label}`);
 const logicalId=observation.logicalDocumentId;
 const sections=record.logicalDocuments??[];
 if(sections.length){
  const section=sections.find(s=>(s.id??s.logicalDocumentId)===logicalId);
  if(!section||section.presenceStatus!=="FOUND"
   ||page<section.startPage||page>section.endPage)
   throw Error("Count proof is not in the active logical report section.");
 }
 if((record.withdrawnSectionRanges??[]).some(r=>page>=r.startPage&&page<=r.endPage))
  throw Error("Cannot use withdrawn physical page.");
 const actualType=key==="reportedConvictionCount"?"MVR":"DASH";
 if(observation.documentType!==actualType)
  throw Error("Count field does not match the physical report type.");
 return {
  ...context,
  observation:{
   ...observation,
   fieldEvidence:{
    ...observation.fieldEvidence,
    [key]:[{page,documentId:record.id,logicalDocumentId:logicalId,
      sourceHash:record.sourceHash,documentType:actualType,text:label}]
   }
  }
 };
}

/**
 * Broker-reviewed MVR / DASH summaries. This validates STRUCTURE, not whether
 * a report is genuine; physical hashes and report age are checked separately.
 * Do not translate an unreadable report into a clean history.
 */
const plain=x=>x!==null&&typeof x==="object"&&!Array.isArray(x) &&
  (Object.getPrototypeOf(x)===Object.prototype||Object.getPrototypeOf(x)===null);
const text=(x,max=300)=>typeof x==="string"&&x.trim().length>0&&x.length<=max;
const day=x=>{
 if(typeof x!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(x))return false;
 const d=new Date(x+"T00:00:00Z");
 return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===x;
};
export function validateReportSummary(value,type) {
 const issues=[];
 if(!plain(value))return ["Summary must be a nonempty structured object."];
 if(type==="mvr"){
   if(typeof value.hasConvictions!=="boolean")
     issues.push("hasConvictions must explicitly be Yes or No.");
   if(!Array.isArray(value.convictions))
     issues.push("convictions must be an array, including [] for an explicit No.");
   else {
     if(value.hasConvictions===true && value.convictions.length===0)
       issues.push("Convictions=Yes requires at least one offence.");
     if(value.hasConvictions===false && value.convictions.length!==0)
       issues.push("Convictions=No contradicts listed offences.");
     if(value.convictions.length>100)issues.push("Too many convictions.");
     for(const [i,c] of value.convictions.entries()){
       if(!plain(c)||!day(c.offenceDate)||!text(c.description)||
           !text(c.classification,100))
         issues.push(`Conviction ${i+1} needs offenceDate, description and classification.`);
     }
   }
 } else if(type==="dash"){
   if(typeof value.hasClaims!=="boolean")
     issues.push("hasClaims must explicitly be Yes or No.");
   if(!Array.isArray(value.claims))
     issues.push("claims must be an array, including [] for an explicit No.");
   else {
     if(value.hasClaims===true && value.claims.length===0)
       issues.push("Claims=Yes requires at least one claim.");
     if(value.hasClaims===false && value.claims.length!==0)
       issues.push("Claims=No contradicts listed claims.");
     if(value.claims.length>100)issues.push("Too many claims.");
     for(const [i,c] of value.claims.entries()){
       if(!plain(c)||!text(c.claimNumber,120)||!day(c.lossDate)||
          !text(c.driver,200)||
          typeof c.atFaultPercent!=="number" ||
          !Number.isFinite(c.atFaultPercent)||
          c.atFaultPercent<0||c.atFaultPercent>100)
         issues.push(`Claim ${i+1} needs claimNumber, lossDate, driver and 0-100 atFaultPercent.`);
     }
   }
 } else issues.push("Unknown report type.");
 return issues;
}

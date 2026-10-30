import type { InsuranceCase, Vehicle } from "./insurance-types.ts";
import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { activeParsedSources } from "./active-evidence.ts";
import { currentPhysicalFile, sectionWithdrawn } from "./ownership-receipt.ts";
import { ownershipNeedsSourceVerification } from "./pdf-page-ocr-status.ts"; // Step 5B-03

const normalizedVin=(v:unknown)=>String(v??"").toUpperCase().replace(/[\s-]/g,"");
/** Step 5B-02: a section subjectId does not prove VIN; unreadable scans stay blocked. */
export function hasOwnershipSectionForVehicle(vehicle:Vehicle,records:UploadedDocumentRecord[]):boolean {
  const vin=normalizedVin(vehicle.vin);
  if(!vehicle.id || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ||
    normalizedVin(vehicle.ownership?.vin)!==vin)return false;
  return records.some(record=>{
    if(!currentPhysicalFile(record))return false;
    const sections=(record.logicalDocuments??[]).filter(section=>
      section.documentType==="OWNERSHIP" &&
      section.presenceStatus==="FOUND" &&
      !sectionWithdrawn(record,section));
    if(!sections.length)return false;
    // OCR is derived data, not VIN attestation. Never silently auto-verify.
    if (ownershipNeedsSourceVerification(record,sections)) return false;
    const parsed=activeParsedSources(record);
    return sections.some(section=>{
      // An explicit different subject is never available to this vehicle.
      if(section.subjectId && section.subjectId!==vehicle.id)return false;
      const observed=parsed.filter(source=>
        source.documentType==="OWNERSHIP" &&
        (!source.logicalDocumentId || source.logicalDocumentId===section.id))
        .map(source=>normalizedVin(source.data?.vin))
        .filter(Boolean);
      // Both "no VIN" and "correct VIN plus conflicting VIN" fail closed.
      return observed.includes(vin) && observed.every(candidate=>candidate===vin);
    });
  });
}
/** Manual broker attestation is only meaningful while exact source files/sections exist. */
export function confirmVehicleOwnership(
  item:InsuranceCase,id:string,checked:boolean,records:UploadedDocumentRecord[]
):InsuranceCase {
  return {...item,vehicles:item.vehicles.map(vehicle=>{
    if(vehicle.id!==id)return vehicle;
    if(checked){
      const vin=normalizedVin(vehicle.vin);
      // Step 5B-02: one VIN/physical proof cannot confirm two rated vehicles.
      if(item.vehicles.filter(candidate=>normalizedVin(candidate.vin)===vin).length!==1 ||
        !hasOwnershipSectionForVehicle(vehicle,records))return vehicle;
    }
    if(!vehicle.ownership)return vehicle;
    return {...vehicle,ownership:{...vehicle.ownership,received:checked}};
  })};
}

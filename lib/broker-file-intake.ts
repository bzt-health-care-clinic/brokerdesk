import type { InsuranceCase, Vehicle } from "./insurance-types.ts";
import type { UploadedDocumentRecord } from "./extraction-types.ts";
import { activeParsedSources } from "./active-evidence.ts";

const normalizedVin=(v:unknown)=>String(v??"").toUpperCase().replace(/[\s-]/g,"");
/** No filename/checklist shortcut. An active, hashed ownership section must match this VIN or be explicitly associated. */
export function hasOwnershipSectionForVehicle(vehicle:Vehicle,records:UploadedDocumentRecord[]):boolean {
  const vin=normalizedVin(vehicle.vin);
  if(!vehicle.id || !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))return false;
  return records.some(record=>{
    if(!record.sourceHash || record.staleExtraction ||
      record.currentSourceHash==="MISSING"||
      record.currentSourceHash&&record.currentSourceHash!==record.sourceHash)return false;
    const sections=(record.logicalDocuments??[]).filter(section=>
      section.documentType==="OWNERSHIP"&&section.presenceStatus==="FOUND"&&
      !(record.withdrawnSectionRanges??[]).some(range=>
        (section.startPage??1)<=range.endPage&&
        (section.endPage??section.startPage??1)>=range.startPage));
    const parsed=activeParsedSources(record);
    return sections.some(section=>
      section.subjectId===vehicle.id ||
      parsed.some(source=>source.documentType==="OWNERSHIP"&&
        normalizedVin(source.data?.vin)===vin&&
        (!source.logicalDocumentId||source.logicalDocumentId===section.id)));
  });
}
/** Manual broker attestation is only meaningful while exact source files/sections exist. */
export function confirmVehicleOwnership(
  item:InsuranceCase,id:string,checked:boolean,records:UploadedDocumentRecord[]
):InsuranceCase {
  return {...item,vehicles:item.vehicles.map(vehicle=>{
    if(vehicle.id!==id)return vehicle;
    if(checked&&!hasOwnershipSectionForVehicle(vehicle,records))return vehicle;
    if(!vehicle.ownership)return vehicle;
    return {...vehicle,ownership:{...vehicle.ownership,received:checked}};
  })};
}

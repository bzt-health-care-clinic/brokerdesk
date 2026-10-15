// Only spelling aliases belong here; different insurance concepts stay separate.
const aliases: Record<string, string> = {
  registered_owner: "registeredOwner", owner_address: "ownerAddress",
  prior_insurer: "priorInsurer", property_insured_since: "propertyInsuredSince",
  continuously_insured_since: "continuouslyInsuredSince",
  continuousInsuranceSince: "continuouslyInsuredSince",
};
export const canonicalFieldKey = (key: string) => aliases[key] ?? key;

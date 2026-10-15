import type { DocumentType } from "./extraction-types.ts";

export interface AssociationGroupRule {
  id: string;
  name: string;
  requiredDocuments: DocumentType[];
  requireIdentityMatch: boolean;
  requireApplicationSignature: boolean;
  requireApplicationDate: boolean;
}

export interface CarrierRuleConfig {
  carrier: string;
  groupDiscountFirst: boolean;
  groupDiscountEvidence?: Record<string, { requireApplication: boolean; requireDiploma: boolean }>;
}

export const ASSOCIATION_RULES: Record<string, AssociationGroupRule> = {
  CTSAC: {
    id: "CTSAC",
    name: "Chinese Teachers and Scholars Association in Canada",
    requiredDocuments: ["CTSAC_MEMBERSHIP_APPLICATION", "DIPLOMA"],
    requireIdentityMatch: true,
    requireApplicationSignature: true,
    requireApplicationDate: true,
  },
};

export const CARRIER_RULES: CarrierRuleConfig[] = [
  { carrier: "Definity", groupDiscountFirst: true, groupDiscountEvidence: { CTSAC: { requireApplication: true, requireDiploma: true } } },
  { carrier: "Economical", groupDiscountFirst: true, groupDiscountEvidence: { CTSAC: { requireApplication: true, requireDiploma: true } } },
];

const normalized = (value: string) => value.trim().toLowerCase();
export function carrierRuleFor(carrier: string) { return CARRIER_RULES.find((rule) => normalized(rule.carrier) === normalized(carrier)); }

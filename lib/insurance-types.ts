export type CaseType =
  | "new_auto"
  | "new_home"
  | "new_condo"
  | "new_tenant"
  | "auto_policy_change"
  | "home_policy_change"
  | "audit_review"
  | "uw_referral_review";

export type CaseStatus =
  | "new"
  | "in_review"
  | "missing_documents"
  | "needs_confirmation"
  | "refer_uw"
  | "ready_to_key_in"
  | "keyed"
  | "incomplete"
  | "completed"
  | "on_hold";

export type DocumentCategory =
  | "signed_application"
  | "quote"
  | "ownership"
  | "mvr"
  | "dash"
  | "previous_policy"
  | "bill_of_sale"
  | "lease_agreement"
  | "finance_document"
  | "winter_tire_proof"
  | "void_cheque"
  | "mortgage_document"
  | "signed_change_form"
  | "prior_policy_coverage"
  | "current_policy_coverage"
  | "underwriter_email"
  | "claims_email"
  | "ctsac_membership_application"
  | "degree_certificate"
  | "diploma"
  | "vehicle_photo"
  | "payment_authorization"
  | "cancellation_request"
  | "supporting_document";

export interface CaseDocument {
  id: string;
  name: string;
  category: DocumentCategory;
  required: boolean;
  received: boolean;
  conflict?: boolean;
}

export type FieldSourceName =
  | "signed_application"
  | "quote"
  | "ownership"
  | "mvr"
  | "dash"
  | "previous_policy"
  | "portal"
  | "lease_agreement"
  | "client_confirmation"
  | "auto_application"
  | "auto_quote"
  | "hab_application"
  | "hab_quote"
  | "prior_auto_policy"
  | "prior_property_policy"
  | "policy_change"
  | "portal_screenshot"
  | "mortgage_document"
  | "manual";

export interface FieldSourceValue {
  logicalDocumentId?: string;
  sourceRevision?: string;
  originalKey?: string;
  correctedValue?: unknown;
  source: FieldSourceName;
  value: unknown;
  documentId?: string;
  confidence?: number;
  evidence?: { page?: number; text?: string; confidence?: number; provider?: string; physicalFileName?: string }[];
}

export interface FieldSource {
  canonicalField?: string;
  subjectType?: string;
  subjectId?: string;
  lineOfBusiness?: string;
  associationReview?: boolean;
  evidenceReview?: boolean;
  withdrawnValues?: FieldSourceValue[];
  appliedTargets?: { path: string[]; value: unknown; previousValue: unknown }[];
  field: string;
  values: FieldSourceValue[];
  resolved_value: unknown | null;
  status: "matched" | "conflict" | "missing" | "resolved";
  resolved_by_user?: string;
  resolved_at?: string;
  resolution_note?: string;
}

export interface Policy {
  id?: string;
  company: string;
  client_code: string;
  quote_number: string;
  binder_number: string | null;
  policy_number?: string;
  effective_date: string;
  expiry_date: string;
  auto_quote_number?: string;
  hab_quote_number?: string;
  mailing_address?: string;
  risk_address?: string;
}

export interface Person {
  name: string;
  dob?: string | null;
  gender?: string | null;
}

export interface Insured extends Person {
  co_insured: Person[];
}

export interface PartyAddress {
  name: string;
  address: string;
}

export interface Ownership {
  received: boolean;
  registered_owner: string;
  additional_owners?: string[];
  address: string;
  plate?: string;
  year: number | null;
  make: string;
  model: string;
  vin: string;
  leased: boolean | null;
  lessor: PartyAddress | null;
  lienholder: PartyAddress | null;
}

export interface Conviction {
  description: string;
  offence_date?: string;
  conviction_date?: string;
  speed_over_limit?: number;
  severity: string;
  demerit_points: number | null;
}

export interface Driver {
  id?: string;
  name: string;
  dob?: string | null;
  gender?: string | null;
  marital_status?: string;
  relationship: string;
  principal: boolean;
  percentage_use: number;
  licence_number: string;
  licence_class: string;
  licence_province?: string;
  licence_expiry?: string;
  g1_date: string;
  g2_date: string;
  g_date: string;
  mvr_issue_date?: string;
  mvr_received: string;
  mvr_requested?: string;
  mvr_release_date?: string;
  mvr_reply_date?: string;
  licence_conditions?: string[];
  licence_status?: string;
  assigned_vehicle?: string;
  driver_training: boolean;
  retired: boolean;
  convictions: Conviction[];
  mvr_convictions?: Conviction[];
  mvr_demerit_points?: number | null;
  demerit_points: number | null;
  telematics: {
    enabled: boolean;
    app: string;
    phone: string;
    email: string;
    discount_percent: number;
  };
}

export interface Vehicle {
  id?: string;
  ownership?: Ownership;
  year: number;
  make: string;
  model: string;
  vin: string;
  owned: boolean;
  leased: boolean;
  purchase_condition?: string;
  purchase_date?: string;
  purchase_price?: number | null;
  list_price_new?: number | null;
  primary_use: string;
  annual_km: number;
  commute_km: number;
  business_use_percent: number;
  carpool?: boolean;
  rideshare?: boolean;
  delivery?: boolean;
  winter_tires: boolean;
  parking: string;
  garaging_address: string;
  lessor?: PartyAddress | null;
  lienholder?: PartyAddress | null;
}

export interface PriorInsurance {
  insurer: string;
  policy_number: string;
  effective_date: string;
  expiry_date: string;
  insured_since: string;
  years_prior_insurance: number | null;
  date_with_company?: string;
  continuous_insurance?: string;
  previous_vehicle?: string;
  previous_vehicle_vin?: string;
  previous_use?: string;
  previous_annual_km?: number;
  previous_commute_km?: number;
  previous_business_use_percent?: number;
}

export interface Claim {
  id: string;
  loss_date: string;
  insurer: string;
  policy_number: string;
  claim_number: string;
  coverage: string;
  loss_amount: number | null;
  expense?: number | null;
  vehicle?: string;
  driver?: string;
  at_fault_percent: number | null;
  status: string;
  portal_present?: boolean;
  party_role?: "FIRST_PARTY" | "THIRD_PARTY" | "UNKNOWN";
  reported_party_role?: string;
  driver_id?: string;
  vehicle_id?: string;
  driver_licence_number?: string;
  vehicle_vin?: string;
  report_id?: string;
  report_subject_id?: string;
  association_status?: "ASSIGNED" | "UNASSIGNED";
  evidence_review?: boolean;
  possible_duplicate_ids?: string[];
  source_active?: boolean;
  source?: { documentId: string; logicalDocumentId?: string; sourceRevision?: string; evidence: import("./extraction-types.ts").FieldEvidence[]; original: Record<string, unknown> };
}

export interface CoverageRow {
  name: string;
  application: string | null;
  quote: string | null;
  prior_policy: string | null;
  portal: string | null;
  required?: boolean;
}

export interface Coverage {
  liability?: number;
  dcpd_deductible?: number;
  all_perils_deductible?: number;
  endorsements: string[];
  comparison: CoverageRow[];
}

export interface HabitationalRisk {
  id?: string;
  policy_type?: string;
  risk_address: string;
  occupancy?: string;
  occupied_since?: string;
  structure?: string;
  construction?: string;
  exterior_finish?: string;
  year_built?: number;
  families?: number;
  units?: number;
  living_area?: number;
  basement_area?: number;
  finished_basement_percent?: number;
  bedrooms?: number;
  bathrooms?: number;
  garage?: string;
  roof?: string;
  plumbing?: string;
  electrical?: string;
  heating?: string;
  water_heater?: string;
  smoke_detectors?: boolean;
  deadbolts?: boolean;
  security?: boolean;
  sprinklers?: boolean;
  hydrant?: string;
  firehall?: string;
  smoke_free?: boolean;
  swimming_pool?: boolean;
  dog_animal_exposure?: string;
  rental?: boolean;
  airbnb?: boolean;
  rooming_house?: boolean;
  vacant?: boolean;
  business_use?: string;
}

export interface Mortgage {
  number_of_mortgages: number | null;
  mortgagees: PartyAddress[];
  nature_of_interest?: string;
  loss_payees?: PartyAddress[];
}

export interface Payment {
  plan: string;
  annual_premium: number | null;
  tax: number | null;
  fees: number | null;
  total_cost: number | null;
  monthly_amount: number | null;
  number_of_installments?: number | null;
  down_payment?: number | null;
}

export interface Premium {
  quoted_annual: number | null;
  portal_annual: number | null;
  difference: number | null;
  difference_percent: number | null;
}

export type AlertSeverity = "high" | "medium" | "info";
export type AlertCode =
  | "SOURCE_CONFLICT"
  | "EVIDENCE_REVIEW"
  | "OWNERSHIP_MISSING"
  | "OWNER_MISMATCH"
  | "VIN_MISMATCH"
  | "VEHICLE_MISMATCH"
  | "COINSURED_REVIEW"
  | "LESSOR_MISMATCH"
  | "LIENHOLDER_MISMATCH"
  | "PRIOR_INSURER_CONFLICT"
  | "PRIOR_POLICY_ACTIVE"
  | "CLAIM_MISSING"
  | "CLAIM_DRIVER_MISMATCH"
  | "MVR_CONVICTION_MISMATCH"
  | "LICENCE_DATE_CONFLICT"
  | "TELEMATICS_PHONE_MISSING"
  | "TELEMATICS_EMAIL_MISSING"
  | "COVERAGE_MISSING"
  | "ENDORSEMENT_MISSING"
  | "PREMIUM_DISCREPANCY"
  | "PROPERTY_INSURED_SINCE_CONFLICT"
  | "MORTGAGE_MISSING"
  | "PAYMENT_MISMATCH"
  | "SUPPORTING_DOCUMENT_MISSING";

export type Phase3AlertCode =
  | "QUOTE_NUMBER_LINE_OF_BUSINESS_CONFLICT"
  | "EFFECTIVE_DATE_CONFLICT"
  | "GROUP_DISCOUNT_DOCUMENT_MISSING"
  | "CTSAC_APPLICATION_MISSING"
  | "CTSAC_APPLICATION_INCOMPLETE"
  | "CTSAC_MEMBERSHIP_PENDING"
  | "CTSAC_MEMBERSHIP_DECLINED"
  | "CTSAC_STATUS_UNCONFIRMED"
  | "DIPLOMA_MISSING"
  | "DIPLOMA_UNREADABLE"
  | "DIPLOMA_NAME_MISMATCH"
  | "GROUP_DISCOUNT_IDENTITY_UNCONFIRMED"
  | "GROUP_DISCOUNT_SELECTION_UNCONFIRMED"
  | "GROUP_DISCOUNT_VALIDATED"
  | "MVR_RECEIVED_DATE_MISSING"
  | "REQUIRED_DRIVER_MISSING";

export interface Alert {
  id: string;
  code: AlertCode | Phase3AlertCode;
  severity: AlertSeverity;
  message: string;
  field?: string;
  sourceValues?: FieldSourceValue[];
  resolved: boolean;
}

export interface PolicyChange {
  name_change?: { previous_legal_name: string; requested_legal_name: string; effective_date: string; supporting_document_id?: string; broker_confirmed: boolean };
  requested_action: string;
  vehicle_or_property: string;
  vin?: string;
  add: string[];
  remove: string[];
  keep: string[];
  confirm: string[];
  transaction_intent?: TransactionIntent;
  transaction_types?: PolicyChangeTransactionType[];
  change_effective_date?: string;
  current_policy_state?: Record<string, unknown>;
  requested_changes?: PolicyChangeItem[];
  resulting_policy_state?: Record<string, unknown>;
  endorsement_changes?: EndorsementChange[];
  requested_effective_date?: string;
  processing_date?: string;
  is_backdated?: boolean;
  backdate_reason?: string;
  uw_required?: boolean;
  uw_status?: UwStatus;
  notes?: string;
}

export type TransactionIntent = "ADD" | "DELETE" | "SUBSTITUTE" | "AMEND" | "RESTORE_COVERAGE" | "REMOVE_COVERAGE" | "DRIVER_ADD" | "DRIVER_DELETE" | "ADDRESS_CHANGE" | "OTHER";
export type PolicyChangeTransactionType = "VEHICLE_SUBSTITUTION" | "ADD_VEHICLE" | "DELETE_VEHICLE" | "ADD_DRIVER" | "DELETE_DRIVER" | "DRIVER_REASSIGNMENT" | "NAME_CHANGE" | "ADDRESS_CHANGE" | "VEHICLE_USE_CHANGE" | "ANNUAL_KM_CHANGE" | "COMMUTE_CHANGE" | "COVERAGE_CHANGE" | "DEDUCTIBLE_CHANGE" | "LESSOR_CHANGE" | "LIENHOLDER_CHANGE" | "PAYMENT_CHANGE" | "CANCELLATION" | "ENDORSEMENT_CHANGE" | "OPCF16_ADD" | "OPCF16_REMOVE" | "OPCF16_REINSTATE" | "OPCF17_ADD" | "OPCF17_REMOVE" | "OPCF17_REINSTATE" | "OTHER_POLICY_CHANGE";
export type UwStatus = "NOT_REQUIRED" | "PENDING" | "REFERRED" | "APPROVED" | "DECLINED";
export interface PolicyChangeItem { id?: string; type: PolicyChangeTransactionType; field?: string; previous_value?: unknown; new_value?: unknown; effective_date?: string; source?: string; subject_id?: string; subject_name?: string; notes?: string; }
export interface EndorsementChange { endorsement: string; action: "ADD" | "REMOVE" | "REINSTATE" | "CHANGE"; vehicle?: string; previous_status?: string; new_status?: "REQUESTED" | "ADDED" | "REMOVED" | "REINSTATED" | "DECLINED" | "NOT_ELIGIBLE"; effective_date?: string; requested_by?: string; supporting_document_required?: boolean; uw_status?: UwStatus; reason?: string; }
export type GroupDiscountValidationStatus = "NOT_APPLICABLE" | "NOT_CONFIRMED" | "NOT_SELECTED" | "MISSING_DOCUMENTS" | "NEEDS_REVIEW" | "PENDING_MEMBERSHIP" | "VALIDATED" | "FAILED";
export type IdentityMatchStatus = "MATCH" | "PARTIAL_MATCH" | "CONFLICT" | "NEEDS_CONFIRMATION";

export interface CtsacApplicationData {
  chinese_name?: string;
  english_name?: string;
  phone?: string;
  email?: string;
  wechat?: string;
  city_province?: string;
  employer_institution?: string;
  position_title?: string;
  field_specialty?: string;
  highest_degree?: string;
  university?: string;
  applicant_signature?: string;
  application_date?: string;
  internal_status?: "approved" | "pending" | "declined" | "not_confirmed";
  member_number?: string;
  review_date?: string;
}

export interface DiplomaData {
  holder_name?: string;
  date_of_birth?: string;
  university?: string;
  degree?: string;
  major?: string;
  issue_date?: string;
  certificate_number?: string;
  country_institution?: string;
  readable?: boolean;
}

export interface GroupDiscountValidation {
  selectionConfirmed?: boolean;
  membershipDecision?: { value: CtsacApplicationData["internal_status"]; support: string; evidenceReview: boolean };
  activeEvidence?: { application: string[]; diploma: string[] };
  withdrawnEvidence?: { ctsac_application?: CtsacApplicationData; diploma?: DiplomaData };
  selected: boolean;
  association?: string;
  discount_percent?: number;
  ctsac_application?: CtsacApplicationData;
  diploma?: DiplomaData;
  identity_status?: IdentityMatchStatus;
  status: GroupDiscountValidationStatus;
}

export interface ClientConfirmedFact {
  field: string;
  value: unknown;
  previous_value?: unknown;
  confirmed_by: string;
  confirmed_at: string;
  note?: string;
}

export interface BrokerOverride {
  alert_code: Alert["code"];
  reason: string;
  confirmed_by: string;
  confirmed_at: string;
}

export interface GeneratedNote {
  type: "portal" | "uw" | "audit" | "policy_change";
  subject?: string;
  text: string;
  max_characters?: number;
}

export interface InsuranceCase {
  factConfirmations?: Record<string, { confirmed: boolean; by?: string; at?: string }>;
  provenanceWarnings?: string[];
  case_id: string;
  case_type: CaseType;
  status: CaseStatus;
  validationStatus?: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETE";
  label: string;
  policy: Policy;
  insured: Insured;
  ownership?: Ownership;
  drivers: Driver[];
  vehicles: Vehicle[];
  prior_insurance: PriorInsurance;
  claims: Claim[];
  withdrawn_claims?: Claim[];
  coverage: Coverage;
  habitational_risk?: HabitationalRisk;
  mortgage?: Mortgage;
  premium: Premium;
  payment: Payment;
  policy_change?: PolicyChange;
  field_sources: FieldSource[];
  documents: CaseDocument[];
  alerts: Alert[];
  uw_referral_pending?: boolean;
  signed?: boolean;
  signed_verified_at?: string;
  signed_document_id?: string;
  group_discount?: GroupDiscountValidation;
  client_confirmed_facts?: ClientConfirmedFact[];
  broker_overrides?: BrokerOverride[];
}

export interface RuleConfig {
  claimBoundaryInclusive?: boolean;
  ratingPeriodYears: number;
  premiumDifferenceDollars: number;
  premiumDifferencePercent: number;
  portalNoteMaxCharacters: number;
}

export const DEFAULT_RULE_CONFIG: RuleConfig = {
  ratingPeriodYears: 6,
  premiumDifferenceDollars: 50,
  premiumDifferencePercent: 0.02,
  portalNoteMaxCharacters: 200,
};

export interface DocumentExtractor {
  extract(file: File): Promise<unknown>;
}

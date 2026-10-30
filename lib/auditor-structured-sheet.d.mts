export interface SourceReviewedRow {
  id: string;
  label: string;
  value: string;
  originalValue: unknown;
  evidencePresent: boolean;
}
export interface SourceReviewedSection {
  id: string;
  title: string;
  rows: SourceReviewedRow[];
}
export interface SourceReviewedSheet {
  brokerReview: "BROKER_CONFIRMED";
  sourceReviewHash?: string | null;
  sections: SourceReviewedSection[];
}
export interface StructuredRow {
  id: string;
  label: string;
  value: string;
  evidencePresent: boolean;
}
export interface StructuredTableRow {
  id: string;
  values: string[];
}
export interface StructuredTable {
  id: string;
  title: string;
  columns: string[];
  rows: StructuredTableRow[];
}
export interface StructuredGroup {
  id: string;
  title: string;
  rows: StructuredRow[];
  tables: StructuredTable[];
}
export interface StructuredSection {
  id: string;
  title: string;
  groups: StructuredGroup[];
}
export interface StructuredView {
  sourceReviewHash: string | null | undefined;
  sections: StructuredSection[];
}
export function buildStructuredAuditorSheet(sheet:SourceReviewedSheet):StructuredView;
export function structuredGroupText(group:StructuredGroup):string;
export function structuredSectionText(section:StructuredSection):string;
export function structuredSheetText(view:StructuredView):string;

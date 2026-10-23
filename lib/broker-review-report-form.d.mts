export type ReportKind = "mvr" | "dash";
export type Presence = "" | "yes" | "no";
export interface ReportRow {
  _sourceIndex?: number | null;
  offenceDate?: string;
  description?: string;
  classification?: string;
  claimNumber?: string;
  lossDate?: string;
  driver?: string;
  vehicle?: string;
  atFaultPercent?: string;
}
export interface ReportForm {
  presence: Presence;
  rows: ReportRow[];
}
export function reportKind(fieldId: string): ReportKind | null;
export function reportToForm(value: unknown, kind: ReportKind): ReportForm;
export function emptyReportRow(kind: ReportKind): ReportRow;
export function formToReport(form: ReportForm, oldValue: unknown, kind: ReportKind):
  {value: Record<string, unknown> | null; issues: string[]};

export const DOCUMENT_PANEL_MIN = 320;
export const DOCUMENT_PANEL_DEFAULT = 400;
export const DOCUMENT_PANEL_MAX = 620;

export const clampDocumentPanelWidth = (width: number) => Math.min(DOCUMENT_PANEL_MAX, Math.max(DOCUMENT_PANEL_MIN, Math.round(width)));

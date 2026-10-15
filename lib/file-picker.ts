export const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.jpg,.jpeg,.png,.txt,.json,.csv,.xml,application/pdf,image/jpeg,image/png";

export function openDocumentPicker(input: Pick<HTMLInputElement, "click"> | null) {
  input?.click();
}

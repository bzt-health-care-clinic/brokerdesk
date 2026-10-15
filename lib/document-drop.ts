const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png", "txt", "json", "csv", "xml"]);

export function isSupportedDocumentName(name: string) {
  const extension = name.toLowerCase().split(".").pop();
  return Boolean(extension && SUPPORTED_DOCUMENT_EXTENSIONS.has(extension));
}

export function acceptedDroppedFiles(files: Iterable<File>) {
  return Array.from(files).filter((file) => isSupportedDocumentName(file.name));
}

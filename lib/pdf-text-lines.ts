/** Preserve PDF.js line endings rather than flattening report labels and values. */
export function pdfTextLines(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = "";
  for (const item of items) {
    if (item.str) text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return text;
}

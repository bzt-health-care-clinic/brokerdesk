import type { ExtractedBlock, ExtractedPage } from './extraction-types.ts';
import { pdfTextLines } from './pdf-text-lines.ts';
import { cleanLayoutText } from './layout-reader.ts';
interface PdfTextItem { str?: string; transform?: number[]; width?: number; height?: number; hasEOL?: boolean; }
interface PdfViewport { width: number; height: number; transform: number[]; }
/** Convert the same PDF.js TextItems used in the browser, retaining their geometric provenance. */
export function pdfLayoutPage(items: PdfTextItem[], viewport: PdfViewport, pageNumber: number): ExtractedPage {
  const [a,b,c,d,e,f] = viewport.transform;
  const blocks: ExtractedBlock[] = [];
  for (const item of items) {
    const t = item.transform;
    if (!item.str?.trim() || !t || t.length !== 6) continue;
    const x = a*t[4] + c*t[5] + e, baseline = b*t[4] + d*t[5] + f;
    const height = Math.hypot(c*t[3] + a*t[2], d*t[3] + b*t[2]) || item.height || 0;
    // Rotated text is retained in plain text but not silently treated as a horizontal table cell.
    const horizontal = Math.abs(b*t[0] + d*t[1]) < Math.abs(a*t[0] + c*t[1]) * .05;
    if (!horizontal || height <= 0 || !(item.width! > 0)) continue;
    blocks.push({ text: item.str, confidence: .99, boundingBox: {
      x, y: baseline-height, width: item.width! * Math.hypot(a,b), height,
    }});
  }
  return { page: pageNumber, pageNumber, width: viewport.width, height: viewport.height,
    text: pdfTextLines(items).split(/\r?\n/).map(cleanLayoutText).filter(Boolean).join("\n"), blocks, confidence: .99 };
}

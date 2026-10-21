import type { BoundingBox, ExtractedPage, FieldEvidence } from './extraction-types.ts';

export interface LayoutCell { text: string; box: BoundingBox; page: number; confidence: number; ids: number[]; }
export const cleanLayoutText = (value: string) => value.normalize('NFKC').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
export const labelKey = (value: string) => cleanLayoutText(value).replace(/[.:]+$/, '').toLowerCase();
const bottom = (cell: LayoutCell) => cell.box.y + cell.box.height;
export function evidenceOf(cell: LayoutCell): FieldEvidence[] {
  return [{ page: cell.page, text: cell.text, boundingBox: { ...cell.box }, confidence: cell.confidence }];
}
export function joinCells(cells: LayoutCell[]): LayoutCell {
  const x = Math.min(...cells.map(c => c.box.x)), y = Math.min(...cells.map(c => c.box.y));
  return { text: cells.map(c => c.text).join(' '), page: cells[0].page,
    box: { x, y, width: Math.max(...cells.map(c => c.box.x + c.box.width)) - x,
      height: Math.max(...cells.map(bottom)) - y },
    confidence: Math.min(...cells.map(c => c.confidence)), ids: cells.flatMap(c => c.ids) };
}
/** Coordinates must be top-left based in the same units as page width and height. */
export function layoutCells(page: ExtractedPage, fragmentGap = .38): LayoutCell[] {
  const blocks: LayoutCell[] = (page.blocks ?? []).flatMap((b, index) => {
    const box = b.boundingBox, text = cleanLayoutText(b.text);
    if (!text || !box || !Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0) return [];
    return [{ text, box: { ...box }, page: page.pageNumber ?? page.page,
      confidence: b.confidence ?? page.confidence ?? 0, ids: [index] }];
  }).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const rows: LayoutCell[][] = [];
  for (const cell of blocks) {
    const row = rows.find(r => Math.abs(r[0].box.y - cell.box.y) <= Math.min(r[0].box.height, cell.box.height) * .32);
    if (row) row.push(cell); else rows.push([cell]);
  }
  // Join text fragments, not neighbouring table columns. Whitespace widths alone are not evidence.
  return rows.flatMap(row => {
    const runs: LayoutCell[][] = [];
    for (const cell of row.sort((a, b) => a.box.x - b.box.x)) {
      const last = runs.at(-1)?.at(-1);
      const gap = last ? cell.box.x - (last.box.x + last.box.width) : Infinity;
      if (last && gap >= -.5 && gap <= Math.min(last.box.height, cell.box.height) * fragmentGap) runs.at(-1)!.push(cell);
      else runs.push([cell]);
    }
    return runs.map(joinCells);
  }).sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

export class LayoutReader {
  readonly cells: LayoutCell[];
  readonly labels: LayoutCell[] = [];
  constructor(page: ExtractedPage, dictionary: readonly string[]) {
    this.cells = layoutCells(page);
    const wanted = new Set(dictionary.map(labelKey));
    for (const first of this.cells) {
      let chain = [first];
      for (let depth = 0; depth < 4; depth++) {
        const combined = joinCells(chain);
        if (wanted.has(labelKey(combined.text))) this.labels.push(combined);
        const last = chain.at(-1)!;
        const next = this.cells.filter(c => !chain.includes(c) && c.box.y > last.box.y + last.box.height * .45 &&
          c.box.y - bottom(last) < last.box.height * .8 &&
          Math.abs(c.box.x - first.box.x) < Math.max(2, first.box.height * .22))
          .sort((a, b) => a.box.y - b.box.y)[0];
        if (!next) break;
        chain = [...chain, next];
      }
    }
  }
  find(labels: readonly string[], from = -Infinity, to = Infinity): LayoutCell[] {
    const wanted = new Set(labels.map(labelKey));
    return this.labels.filter(c => wanted.has(labelKey(c.text)) && c.box.y >= from && c.box.y < to)
      .sort((a, b) => a.box.y - b.box.y);
  }
  isLabel(cell: LayoutCell): boolean { return this.labels.some(l => cell.ids.some(id => l.ids.includes(id))); }
  above(label: LayoutCell, floor = -Infinity): LayoutCell | undefined {
    const xTolerance = Math.max(2.2, Math.min(label.box.height, 14) * .27);
    const candidates = this.cells.filter(c => c.box.y >= floor && bottom(c) <= label.box.y + 2 &&
      label.box.y - bottom(c) <= Math.max(14, Math.min(label.box.height, 16) * 1.5) &&
      Math.abs(c.box.x - label.box.x) <= xTolerance).sort((a, b) => bottom(b) - bottom(a));
    const nearest = candidates[0];
    if (!nearest || this.isLabel(nearest)) return undefined;
    let chain = [nearest];
    for (let i = 0; i < 2; i++) {
      const current = chain[0];
      const prior = this.cells.filter(c => c.box.y >= floor && c !== current &&
        bottom(c) <= current.box.y + 2 && current.box.y - bottom(c) <= 3 &&
        Math.abs(c.box.x - label.box.x) <= xTolerance).sort((a, b) => bottom(b) - bottom(a))[0];
      if (!prior || this.isLabel(prior) || chain.includes(prior)) break;
      chain = [prior, ...chain];
    }
    return joinCells(chain);
  }
}

/** Strict normalization for known template date orders; never guess US vs Canadian date order. */
export function templateDate(value: string, order: 'MDY' | 'DMY' | 'YMD'): string | undefined {
  const parts = value.trim().match(/^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})$/);
  if (!parts) return undefined;
  const nums = parts.slice(1).map(Number);
  const [year, month, day] = order === 'YMD' ? nums : order === 'MDY' ? [nums[2], nums[0], nums[1]] : [nums[2], nums[1], nums[0]];
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
}

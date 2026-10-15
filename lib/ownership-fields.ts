import type { FieldEvidence, RawExtractedDocument } from "./extraction-types.ts";

const labels = {
  registeredOwner: /^(?:REGISTERED OWNER|NAME\s*(?:\/\s*NOM)?|NOM)\b/i,
  ownerAddress: /^(?:OWNER ADDRESS|ADDRESS\s*(?:\/\s*ADRESSE)?|ADRESSE)\b/i,
  plate: /^(?:PLATE\s*(?:\/\s*PLAQUE)?|PLAQUE)\b/i,
  year: /^(?:YEAR\s*(?:\/\s*ANN[ÉE]E)?|ANN[ÉE]E)\b/i,
  make: /^(?:MAKE\s*(?:\/\s*MARQUE)?|MARQUE)\b/i,
  model: /^(?:MODEL\s*\/\s*MOD[ÈE]LE|MODEL|MOD[ÈE]LE)\b/i,
};
type Field = keyof typeof labels;
type Line = FieldEvidence & { text: string };
const instruction = /(?:please\s+print|office\s+use|[àa]\s*l['’]usage\s+du\s+bureau|street\s+name|city\s*\/\s*town|postal\s+code|code\s+postal|signature|detach|d[ée]tach|change\s*(?:,|of\s+address)|changement|lot\s*\/\s*conc|^province$|^permit\b|^certificate\b|^certificat\b|^rue$|^ville$)/i;
const otherLabel = /^(?:V\.?I\.?N\.?|BODY TYPE|COLOUR|COLOR|LESSOR|LIEN\s*HOLDER|VEHICLE CLASS|CLASS|STATUS|TYPE)\b/i;
const status = /^(?:PAS|FIT|UNFIT|COM|MOT|TRK|TRL)(?:\s*[-/]\s*(?:FIT|UNFIT|PAS|COM|MOT|TRK|TRL))*$/i;
const clean = (text: string) => text.replace(/^[\s:/#|.-]+/, "").trim();
const boundary = (text: string) => instruction.test(text) || otherLabel.test(text) || Object.values(labels).some(pattern => pattern.test(text)) && !/^MODEL\s+\d/i.test(text);
function plausible(field: Field, value: string) {
  if (!value || instruction.test(value) || status.test(value)) return false;
  if (field === "registeredOwner") return !boundary(value) && /\p{L}/u.test(value) && !/\d/.test(value);
  if (field === "ownerAddress") return /\b\d+[A-Z]?\s+\p{L}|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b\p{L}+[\s,]+(?:ON|ONTARIO)\b|\b(?:RR|PO BOX|RURAL ROUTE)\s*\d/iu.test(value);
  if (field === "plate") return /^[A-Z0-9][A-Z0-9 -]{1,8}[A-Z0-9]$/i.test(value) && !boundary(value);
  if (field === "year") return /^(?:19|20)\d{2}$/.test(value);
  return /\p{L}/u.test(value) && (!boundary(value) || field === "model" && /^MODEL\s+\d/i.test(value));
}

export function ownershipFields(raw: RawExtractedDocument, text: string) {
  const positioned: Line[] = (raw.pages ?? []).flatMap(page => (page.blocks ?? []).filter(b => b.boundingBox && b.boundingBox.width > 0 && b.boundingBox.height > 0).map(b => ({ ...b, page: page.pageNumber ?? page.page, confidence: b.confidence ?? page.confidence ?? raw.confidence })));
  // Providers may return individual words. Join adjacent words on a row, preserving column gaps.
  const rows: Line[] = [];
  for (const block of positioned.sort((a,b) => a.page! - b.page! || a.boundingBox!.y - b.boundingBox!.y || a.boundingBox!.x - b.boundingBox!.x)) {
    const box = block.boundingBox!;
    const row = rows.find(r => r.page === block.page && Math.abs(r.boundingBox!.y - box.y) < Math.min(r.boundingBox!.height, box.height) * .5 && box.x >= r.boundingBox!.x + r.boundingBox!.width && box.x - r.boundingBox!.x - r.boundingBox!.width < box.height * 1.5);
    if (row) { row.text += ` ${block.text}`; row.boundingBox = { ...row.boundingBox!, width: box.x + box.width - row.boundingBox!.x, height: Math.max(box.height, row.boundingBox!.height) }; row.confidence = row.confidence === undefined || block.confidence === undefined ? undefined : Math.min(row.confidence, block.confidence); }
    else rows.push({ ...block, boundingBox: { ...box } });
  }
  const lines: Line[] = rows.length ? rows : text.split("\n").map(value => ({ text: value, confidence: raw.confidence, page: raw.pages?.find(p => p.text?.includes(value))?.page }));
  const data: Record<string, string> = {}; const evidence: Record<string, FieldEvidence[]> = {}; const unresolved: string[] = [];
  for (const field of Object.keys(labels) as Field[]) {
    const candidates: { value: string; evidence: Line[] }[] = [];
    for (let index = 0; index < lines.length; index++) {
      const label = lines[index]; if (instruction.test(label.text)) continue;
      const match = label.text.match(labels[field]); if (!match || field === "model" && /^MODEL\s+\d/i.test(label.text)) continue;
      const inline = clean(label.text.slice(match[0].length));
      let nearby: Line[];
      if (rows.length) {
        const box = label.boundingBox!;
        const right = lines.filter(l => l !== label && l.page === label.page && Math.abs(l.boundingBox!.y - box.y) < box.height * .6 && l.boundingBox!.x >= box.x + box.width && l.boundingBox!.x - box.x - box.width < box.height * 8).sort((a,b) => a.boundingBox!.x - b.boundingBox!.x);
        const below = lines.filter(l => l !== label && l.page === label.page && l.boundingBox!.y >= box.y + box.height * .7 && l.boundingBox!.y - box.y <= box.height * (field === "ownerAddress" ? 7 : 3) && Math.abs(l.boundingBox!.x - box.x) <= box.height * 2).sort((a,b) => a.boundingBox!.y - b.boundingBox!.y);
        nearby = right.length && !boundary(right[0].text) ? [right[0]] : below;
      } else nearby = lines.slice(index + 1, index + (field === "ownerAddress" ? 4 : 2));
      const values: Line[] = inline ? [{ ...label, text: inline }] : [];
      if (!inline || field === "ownerAddress") for (const line of nearby) { if (boundary(line.text)) break; values.push(line); if (field !== "ownerAddress") break; }
      const value = values.map(l => clean(l.text)).join(", ");
      if (plausible(field, value)) candidates.push({ value, evidence: values });
    }
    const distinct = new Map(candidates.map(c => [c.value.toUpperCase().replace(/\s+/g, " "), c]));
    if (distinct.size === 1) { const candidate = [...distinct.values()][0]; data[field] = candidate.value; evidence[field] = candidate.evidence; }
    else unresolved.push(field);
  }
  return { data, evidence, unresolved };
}

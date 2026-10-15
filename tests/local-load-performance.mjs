import assert from "node:assert/strict";
import { compactPackageRecord } from "../local-server/repositories.mjs";

const pageText = "Ontario ownership OCR text ".repeat(200);
const record = {
  id: "package",
  packagePages: [1, 2, 3].map((page) => ({ page, text: pageText, extractionStatus: "COMPLETE" })),
  raw: { text: pageText.repeat(3), rawText: pageText.repeat(3), normalizedText: pageText.repeat(3), pages: [1, 2, 3].map((page) => ({ page, text: pageText })), metadata: { provider: "page_package_pipeline" } },
};
const before = JSON.stringify(record).length;
const compacted = compactPackageRecord(record);
const after = JSON.stringify(compacted.record).length;
assert.equal(compacted.changed, true);
assert.equal(compacted.record.packagePages.length, 3);
assert.equal(compacted.record.raw.text, undefined);
assert.equal(compacted.record.raw.pages, undefined);
assert.ok(after < before * .4, `Expected compact record below 40% of original size, got ${Math.round(after / before * 100)}%`);
assert.equal(compactPackageRecord(compacted.record).changed, false);
console.log(`Local load performance targeted: passed (${Math.round((1 - after / before) * 100)}% fixture reduction).`);

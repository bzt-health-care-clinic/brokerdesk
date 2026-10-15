import assert from "node:assert/strict";

assert.equal(typeof window, "undefined");
assert.equal(typeof document, "undefined");
assert.equal(typeof localStorage, "undefined");

const sharedModules = [
  "../lib/package-analysis.ts",
  "../lib/ocr-providers.ts",
  "../lib/document-ingestion.ts",
  "../lib/extraction-types.ts",
  "../lib/local-repositories.ts",
  "../lib/institution-directory.ts",
  "../lib/file-picker.ts",
  "../lib/document-filenames.ts",
  "../lib/document-drop.ts",
  "../lib/new-case.ts",
  "../lib/case-factories.ts",
  "../lib/reconciliation.ts",
  "../lib/rule-engine.ts",
  "../lib/validation-workflow.ts",
  "../lib/policy-change.ts",
] as const;

for (const modulePath of sharedModules) {
  const loaded = await import(modulePath);
  assert.ok(loaded, `${modulePath} must import without browser globals`);
}

console.log(`Node import safety: passed (${sharedModules.length} shared modules).`);

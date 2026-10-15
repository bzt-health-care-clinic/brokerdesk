import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LOCAL_ENV_PATH, PROJECT_ROOT, loadLocalEnvironment, parseEnvFile } from "../local-server/env-loader.mjs";
import { ocrSpaceHealth } from "../local-server/ocr-space.mjs";

const root = mkdtempSync(join(tmpdir(), "brokerdesk-env-test-"));
try {
  const envFile = join(root, ".env.local"); writeFileSync(envFile, '# comment\nOCRSPACE_API_KEY="file-secret"\nOCRSPACE_MAX_PDF_PAGES=3\n', "utf8");
  const fromFile = { NODE_ENV: "test" }; const loaded = loadLocalEnvironment({ environment: fromFile, path: envFile, warn: () => {} }); assert.equal(loaded.configured, true); assert.equal(fromFile.OCRSPACE_API_KEY, "file-secret"); assert.equal(ocrSpaceHealth(fromFile).state, "ONLINE");
  const absent = { NODE_ENV: "test" }; assert.equal(loadLocalEnvironment({ environment: absent, path: join(root, "missing.env"), warn: () => {} }).exists, false); assert.equal(ocrSpaceHealth(absent).state, "NOT_CONFIGURED");
  const override = { NODE_ENV: "test", OCRSPACE_API_KEY: "process-secret" }; loadLocalEnvironment({ environment: override, path: envFile, warn: () => {} }); assert.equal(override.OCRSPACE_API_KEY, "process-secret");
  const malformed = join(root, "malformed.env"); writeFileSync(malformed, 'OCRSPACE_API_KEY="unterminated\nnot valid\n', "utf8"); const warnings = []; const malformedEnv = { NODE_ENV: "test" }; const result = loadLocalEnvironment({ environment: malformedEnv, path: malformed, warn: (message) => warnings.push(message) }); assert.equal(result.warnings, 2); assert.equal(malformedEnv.OCRSPACE_API_KEY, undefined); assert.equal(warnings.length, 1);
  const unreadable = join(root, "directory.env"); mkdirSync(unreadable); assert.doesNotThrow(() => loadLocalEnvironment({ environment: { NODE_ENV: "test" }, path: unreadable, warn: () => {} }));
  assert.deepEqual(parseEnvFile("A=one\nB=\"two\"\n# ignored\n\n").values, { A: "one", B: "two" });
  assert.equal(PROJECT_ROOT, resolve(process.cwd())); assert.equal(LOCAL_ENV_PATH, resolve(process.cwd(), ".env.local"));
  const health = ocrSpaceHealth({ NODE_ENV: "test", OCRSPACE_API_KEY: "never-return-this" }); assert.equal(JSON.stringify(health).includes("never-return-this"), false); assert.equal("apiKey" in health, false);
  for (const file of ["lib/ocr-providers.ts", "components/ingestion-panel.tsx", "app/page.tsx"]) assert.equal(readFileSync(file, "utf8").includes("OCRSPACE_API_KEY"), false);
  assert.match(readFileSync(".gitignore", "utf8"), /^\.env\*/m); assert.match(readFileSync("scripts/run-local.mjs", "utf8"), /local-server\/server\.mjs/); assert.match(readFileSync("local-server/server.mjs", "utf8"), /loadLocalEnvironment\(\)/);
  console.log("Environment loader targeted: passed.");
} finally { rmSync(root, { recursive: true, force: true }); }

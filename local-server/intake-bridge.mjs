import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const runner = join(dirname(fileURLToPath(import.meta.url)), "intake-eval.mjs");
export function authoritativeIntake(item, documents) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 24) throw Object.assign(new Error("BDZIP pilot requires Node.js 24 for the same authoritative underwriting rules on both computers."), { status: 503 });
  let output;
  try {
    output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning",
      "--experimental-transform-types", runner], {
      input: JSON.stringify({ case: item, documents }),
      timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true,
    });
  } catch (error) {
    // Do not surface source document text, client identifiers, or raw stdin in
    // errors. The error contains no document data by design.
    throw Object.assign(new Error("Intake engine did not complete; no package was accepted. Check Node 24 and application installation."), { status: 503 });
  }
  try { return JSON.parse(output.toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid response from local intake engine."), { status: 503 }); }
}

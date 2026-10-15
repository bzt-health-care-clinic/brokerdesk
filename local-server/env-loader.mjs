import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LOCAL_ENV_PATH = resolve(PROJECT_ROOT, ".env.local");

export function parseEnvFile(text) {
  const values = {}; const warnings = [];
  for (const [index, original] of String(text).replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = original.trim(); if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) { warnings.push(`line ${index + 1}`); continue; }
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else if (/^["']/.test(value)) { warnings.push(`line ${index + 1}`); continue; }
    values[match[1]] = value;
  }
  return { values, warnings };
}

export function loadLocalEnvironment({ environment = process.env, path = LOCAL_ENV_PATH, warn = console.warn } = {}) {
  if (!existsSync(path)) return { exists: false, configured: Boolean(environment.OCRSPACE_API_KEY), warnings: 0 };
  try {
    const parsed = parseEnvFile(readFileSync(path, "utf8")); let loaded = 0;
    for (const [key, value] of Object.entries(parsed.values)) if (environment[key] === undefined) { environment[key] = value; loaded += 1; }
    if (parsed.warnings.length) warn(`BrokerDesk configuration warning: ignored ${parsed.warnings.length} malformed .env.local line(s).`);
    return { exists: true, configured: Boolean(environment.OCRSPACE_API_KEY), loaded, warnings: parsed.warnings.length };
  } catch {
    warn("BrokerDesk configuration warning: .env.local could not be read; continuing with process environment and safe defaults.");
    return { exists: true, configured: Boolean(environment.OCRSPACE_API_KEY), loaded: 0, warnings: 1 };
  }
}

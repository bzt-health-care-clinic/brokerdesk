import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";

export function resolveDataPaths(environment = process.env) {
  const configured = environment.BROKERDESK_DATA_DIR?.trim();
  const base = configured
    ? resolve(configured)
    : resolve(environment.LOCALAPPDATA || environment.XDG_DATA_HOME || join(homedir(), "AppData", "Local"), "BrokerDesk");
  const paths = { base, database: join(base, "brokerdesk.db"), documents: join(base, "documents"), backups: join(base, "backups"), temp: join(base, "temp") };
  for (const directory of [paths.base, paths.documents, paths.backups, paths.temp]) mkdirSync(directory, { recursive: true });
  return paths;
}

export function inside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  return target === base || target.startsWith(`${base}${sep}`);
}

export function safeId(value, label = "id") {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function safeRelativePath(value) {
  if (!value || isAbsolute(value) || value.includes("..")) throw new Error("Invalid relative path");
  return value.replaceAll("\\", "/");
}

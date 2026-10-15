import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fullRuntime = process.argv.includes("--full");
const children = [
  spawn(process.execPath, ["local-server/server.mjs"], { cwd: root, stdio: "inherit", windowsHide: true }),
  spawn(process.execPath, ["scripts/run-framework.mjs", "dev"], { cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env, ...(fullRuntime ? {} : { BROKERDESK_FAST_LOCAL: "true" }) } }),
];
function stop(code = 0) { for (const child of children) if (!child.killed) child.kill(); process.exit(code); }
for (const child of children) child.on("exit", (code) => { if (code && code !== 0) stop(code); });
process.on("SIGINT", () => stop()); process.on("SIGTERM", () => stop());

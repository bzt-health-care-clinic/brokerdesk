// Bounded capability/smoke entrypoint, not a replacement for scenarios A–E.
// Run: node tests/browser-acceptance-preflight.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { platform, release } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(root, 'tests/.acceptance-runs');
await mkdir(base, { recursive: true });
const run = await mkdtemp(resolve(base, 'run-'));
const children = [];
const logs = {};
const frontendOrigin = 'http://127.0.0.1:5183';
const backendOrigin = 'http://127.0.0.1:47841';
const results = { status: 'BLOCKED', run, runnerOS: `${platform()} ${release()}`, BROWSER_EXECUTED: false, STUBBED_OCR: 'NOT_RUN', LIVE_OCR: 'NOT_RUN', liveOcrCalls: 0, stubbedOcrCalls: 0, checks: [], scenarios: 'A–E NOT_RUN; this entrypoint is preflight/smoke only' };
let browser;
const env = { ...process.env, BROKERDESK_DATA_DIR: resolve(run, 'data'), BROKERDESK_LOCAL_API_PORT: new URL(backendOrigin).port, BROKERDESK_LOCAL_FRONTEND_ORIGIN: frontendOrigin, BROKERDESK_FAST_LOCAL: 'true', NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL: backendOrigin, OCRSPACE_API_KEY: '', OCRSPACE_API_URL: 'http://127.0.0.1:47842/disabled' };
async function freePort(port) {
  await new Promise((ok, fail) => { const s = createServer(); s.once('error', fail); s.listen(port, '127.0.0.1', () => s.close(ok)); });
}
function start(name, args) {
  logs[name] = '';
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', d => { logs[name] += d; });
  child.stderr.on('data', d => { logs[name] += d; });
  child.on('error', e => { logs[name] += `\n${e.code}: ${e.message}`; });
  return child;
}
async function ready(url, child, name) {
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (child.exitCode !== null || /spawn EPERM/.test(logs[name])) throw new Error(`${name} startup blocked; see ${name}.log`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`${name} readiness timeout`);
}
try {
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    try { await access(resolve(root, file)); throw new Error('Use a clean acceptance checkout without application environment files'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await freePort(Number(new URL(backendOrigin).port)); await freePort(Number(new URL(frontendOrigin).port));
  const backend = start('backend', ['local-server/server.mjs']);
  await ready(`${backendOrigin}/health`, backend, 'backend');
  results.checks.push({ name: 'backend', status: 'PASS' });
  const frontend = start('frontend', ['scripts/run-framework.mjs', 'dev', '--port', new URL(frontendOrigin).port, '--hostname', new URL(frontendOrigin).hostname]);
  await ready(frontendOrigin, frontend, 'frontend');
  results.checks.push({ name: 'frontend', status: 'PASS' });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  results.BROWSER_EXECUTED = true;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return [frontendOrigin, backendOrigin].includes(url.origin) && !url.pathname.startsWith('/ocr-space') ? route.continue() : route.abort();
  });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(frontendOrigin, { waitUntil: 'networkidle', timeout: 45000 });
    await page.screenshot({ path: resolve(run, 'smoke.png'), fullPage: true });
    const originCheck = await fetch(`${backendOrigin}/bootstrap`, { headers: { Origin: frontendOrigin } });
    results.checks.push({ name: 'browser-script-errors', status: errors.length ? 'FAILED' : 'PASS', errors });
    results.checks.push({ name: 'separate-port-origin', status: originCheck.ok ? 'PASS' : 'FAILED', httpStatus: originCheck.status });
    results.status = errors.length || !originCheck.ok ? 'FAILED' : 'PREFLIGHT_PASS_ACCEPTANCE_NOT_RUN';
  } finally { await context.tracing.stop({ path: resolve(run, 'smoke-trace.zip') }); }
} catch (e) { results.reason = e.message; }
finally {
  if (browser) await browser.close();
  for (const child of children) if (child.exitCode === null && child.signalCode === null) await new Promise(resolveStop => { const timer = setTimeout(resolveStop, 8000); child.once('exit', () => { clearTimeout(timer); resolveStop(); }); child.kill(); });
  for (const [name, text] of Object.entries(logs)) await writeFile(resolve(run, `${name}.log`), text);
  await writeFile(resolve(run, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.status}: ${run}`);
  process.exitCode = results.status === 'PREFLIGHT_PASS_ACCEPTANCE_NOT_RUN' ? 0 : 1;
}

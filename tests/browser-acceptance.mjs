// Exact entrypoint: node tests/browser-acceptance.mjs
// Serial Playwright API runner, zero retries. No browser execution during syntax checks.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { platform, release } from 'node:os';
import { createRuntime, root, frontend, backend } from './acceptance/runtime.mjs';
import { names, runScenario } from './acceptance/scenarios.mjs';
import { diagnosticSummary, appendJobSummary } from './acceptance/reporting.mjs';

const base = resolve(root, 'tests/.acceptance-runs'); await mkdir(base, { recursive: true });
const run = await mkdtemp(resolve(base, 'suite-')); const output = resolve(run, 'artifacts'); await mkdir(output);
const report = { status: 'BLOCKED', BROWSER_EXECUTED: false, STUBBED_OCR: 'NOT_RUN', LIVE_OCR: 'NOT_RUN', liveOcrCalls: 0, stubbedOcrCalls: 0, runnerOS: `${platform()} ${release()}`, command: 'node tests/browser-acceptance.mjs', scenarios: Object.entries(names).map(([id, name]) => ({ id, name, status: 'IMPLEMENTED_NOT_RUN', checks: [], workers: [], errors: [], failedRequests: [] })) };
let rt, browser, timedOut = false, preflightLog = '', finalPrinted = false;
async function finishReporting() {
  if (finalPrinted) return;
  finalPrinted = true;
  console.log(diagnosticSummary(report, output, preflightLog));
  await appendJobSummary(report, output).catch(e => console.error(`Job summary unavailable: ${e.message}`));
}
const escape = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
async function persist() {
  report.stubbedOcrCalls = rt?.calls.length ?? 0;
  report.STUBBED_OCR = report.stubbedOcrCalls ? 'EXECUTED_TEST_BOUNDARY_ONLY' : 'NOT_RUN';
  report.ocrRequests = rt?.calls ?? [];
  report.legacyCloudRequests = rt?.cloudCalls ?? [];
  report.legacyCloudCallCount = rt?.cloudCalls.length ?? 0;
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  const body = `# BrokerDesk A–E acceptance\n\n${report.status}\n\nOS: ${report.runnerOS}\n\nBROWSER_EXECUTED: ${report.BROWSER_EXECUTED}; STUBBED_OCR: ${report.STUBBED_OCR}; LIVE_OCR: NOT_RUN (0 requests).\n\n${report.scenarios.map(s => `- ${s.id} ${s.name}: ${s.status}\n${s.checks.map(c => `  - ${c.status}: ${c.name}${c.error ? ` — ${c.error}` : ''}`).join('\n')}`).join('\n')}\n\nSynthetic fixtures only. Backend process restarts are not OS restarts. DOM drop is not Windows Explorer drag validation. Unsupported extraction is reported separately from workflow checks. No real-client accuracy claim.\n`;
  await writeFile(resolve(output, 'browser-test-report.md'), body);
  await writeFile(resolve(output, 'report.html'), `<!doctype html><meta charset="utf-8"><title>BrokerDesk acceptance</title><pre>${escape(body)}</pre>`);
}
const deadline = setTimeout(async () => {
  timedOut = true; report.status = 'FAILED'; report.reason = '15-minute bounded suite timeout';
  for (const s of report.scenarios) if (s.status === 'RUNNING') s.status = 'FAILED_TIMEOUT';
  try {
    await persist();
    await browser?.close().catch(e => { report.cleanupError = e.message; });
    await rt?.close().catch(e => { report.cleanupError = [report.cleanupError, e.message].filter(Boolean).join('; '); });
    await persist();
    await finishReporting();
  } finally { process.exit(1); }
}, 15 * 60 * 1000);
try {
  // Preflight failures cannot become acceptance passes. No retries.
  const code = await new Promise(resolveExit => {
    const p = spawn(process.execPath, ['tests/browser-acceptance-preflight.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    p.stdout.on('data', b => { preflightLog += b; }); p.stderr.on('data', b => { preflightLog += b; });
    p.once('error', e => { preflightLog += e.message; resolveExit(1); }); p.once('exit', resolveExit);
  });
  await writeFile(resolve(output, 'preflight.log'), preflightLog);
  report.preflight = code === 0 ? 'PASS' : 'FAILED';
  if (code !== 0) { report.reason = 'Preflight failed; A–E BLOCKED'; for (const s of report.scenarios) s.status = 'BLOCKED'; }
  else {
    rt = await createRuntime(); await rt.start();
    const { chromium } = await import('playwright'); browser = await chromium.launch({ headless: true }); report.BROWSER_EXECUTED = true;
    for (const scenario of report.scenarios) {
      let context, page, tracingStarted = false;
      scenario.status = 'RUNNING'; await persist();
      try {
        await rt.reset(scenario.id);
        context = await browser.newContext({ viewport: { width:1440,height:1000 }, serviceWorkers: 'block' });
        await context.route('**/*', route => { const url = new URL(route.request().url()); return [frontend,backend].includes(url.origin) ? route.continue() : route.abort('blockedbyclient'); });
        // More-specific Playwright route has precedence over the loopback guard.
        // Only the synthetic OCR transport is intercepted; UI and storage stay real.
        await context.route('**/local-ocr**', route => {
          const url = new URL(route.request().url());
          if (url.origin === backend && ['/local-ocr','/local-ocr/health'].includes(url.pathname))
            return rt.handleLocalOcr(route);
          return route.fallback();
        });
        await context.tracing.start({ screenshots:true, snapshots:true, sources:false }); tracingStarted = true;
        page = await context.newPage(); page.setDefaultTimeout(12000); page.setDefaultNavigationTimeout(60000);
        page.on('worker', worker => scenario.workers.push(worker.url()));
        page.on('pageerror', e => scenario.errors.push({ kind:'pageerror', message:e.message }));
        page.on('console', m => { if (m.type() === 'error') scenario.errors.push({ kind:'console', message:m.text() }); });
        page.on('requestfailed', r => scenario.failedRequests.push({ url:r.url(), reason:r.failure()?.errorText }));
        page.on('response', r => { if (r.status() >= 400) scenario.failedRequests.push({ url:r.url(), status:r.status(), expectedProviderFailure: scenario.id === 'C' && r.url() === `${backend}/local-ocr` && rt.calls.at(-1)?.expectedFailure === true }); });
        await runScenario(scenario.id, page, rt, scenario);
      }
      catch (e) { scenario.checks.push({ name:'Scenario setup/continuation', status:'FAILED', error:e.stack }); }
      finally {
        const unexpected = scenario.failedRequests.filter(r => !r.expectedProviderFailure);
        const unexpectedErrors = scenario.errors.filter(e => !(scenario.id === 'C' && rt.calls.some(c => c.expectedFailure) && /^Failed to load resource: the server responded with a status of 502/.test(e.message)));
        scenario.checks.push({ name:'No unhandled scripts, worker failures or unexpected failed requests', status: unexpectedErrors.length || unexpected.length ? 'FAILED' : 'PASS' });
        scenario.checks.push({ name:'No legacy cloud OCR requests', status: rt.cloudCalls.length ? 'FAILED' : 'PASS' });
        scenario.status = scenario.checks.some(c => c.status !== 'PASS') ? 'FAILED' : 'ACTUAL_BROWSER_PASS';
        await persist();
        if (page) await page.screenshot({ path:resolve(output, `${scenario.id}-final.png`), fullPage:true }).catch(e => { scenario.checks.push({ name:'Final screenshot', status:'FAILED', error:e.message }); scenario.status='FAILED'; });
        if (tracingStarted) await context.tracing.stop({ path:resolve(output, `${scenario.id}-trace.zip`) }).catch(e => { scenario.checks.push({ name:'Trace capture', status:'FAILED', error:e.message }); scenario.status='FAILED'; });
        if (context) await context.close().catch(e => { scenario.checks.push({ name:'Browser context cleanup', status:'FAILED', error:e.message }); scenario.status='FAILED'; });
        await persist();
      }
    }
    report.status = report.scenarios.every(s => s.status === 'ACTUAL_BROWSER_PASS') ? 'ACTUAL_BROWSER_PASS' : 'FAILED';
  }
} catch(e) { report.reason = e.stack || e.message; report.status = report.BROWSER_EXECUTED ? 'FAILED' : 'BLOCKED'; await persist(); }
finally {
  clearTimeout(deadline);
  await persist();
  await browser?.close().catch(e => { report.cleanupError = e.message; report.status='FAILED'; });
  await rt?.close().catch(e => { report.cleanupError = [report.cleanupError, e.message].filter(Boolean).join('; '); report.status='FAILED'; });
  if (rt) report.additionalArtifacts = rt.artifacts;
  await persist(); await finishReporting(); process.exitCode = !timedOut && report.status === 'ACTUAL_BROWSER_PASS' ? 0 : 1;
}

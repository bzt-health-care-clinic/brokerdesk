import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { diagnosticSummary, appendJobSummary, safeDiagnostic } from './reporting.mjs';

const scenario = id => ({ id, status: 'BLOCKED', checks: [], errors: [], failedRequests: [] });
const report = {
  status: 'FAILED', BROWSER_EXECUTED: true, STUBBED_OCR: 'NOT_RUN', LIVE_OCR: 'NOT_RUN',
  preflight: 'PASS', reason: 'Browser setup failed', cleanupError: 'Process shutdown failed',
  scenarios: ['A', 'B', 'C', 'D', 'E'].map(scenario),
};
report.scenarios[0].status = 'FAILED';
report.scenarios[0].checks.push({ name: 'Synthetic assertion', status: 'FAILED', error: 'Expected two distinct drivers; got one' });
report.scenarios[0].errors.push({ kind: 'pageerror', message: 'Synthetic page exception' });
report.scenarios[0].failedRequests.push({ url: 'http://127.0.0.1:47841/health?token=private', reason: 'net::ERR_FAILED' });

const output = diagnosticSummary(report, 'tests/.acceptance-runs/suite-synthetic/artifacts');
assert.match(output, /FAILED Synthetic assertion: Expected two distinct drivers; got one/);
assert.match(output, /Primary failure: Browser setup failed/);
assert.match(output, /Cleanup error: Process shutdown failed/);
assert.match(output, /A: FAILED[\s\S]*E: BLOCKED/);
assert.match(output, /Synthetic page exception/);
assert.doesNotMatch(output, /token=private/);

const preflight = { ...report, status: 'BLOCKED', BROWSER_EXECUTED: false, preflight: 'FAILED', reason: 'Preflight failed', cleanupError: undefined };
const preflightOutput = diagnosticSummary(preflight, 'synthetic', 'Error: frontend startup blocked\nsecret=example');
assert.match(preflightOutput, /Preflight log: Error: frontend startup blocked/);
assert.doesNotMatch(preflightOutput, /secret=example/);
assert.equal(safeDiagnostic('password=hunter2'), 'password=[REDACTED]');

const workflow = await readFile(new URL('../../.github/workflows/browser-acceptance-readiness.yml', import.meta.url), 'utf8');
const allowlist = workflow.split('          path: |\n')[1].split(/\n\s*-/)[0];
for (const path of [
  'run-*/results.json', 'run-*/backend.log', 'run-*/frontend.log', 'run-*/smoke.png', 'run-*/smoke-trace.zip',
  'suite-*/artifacts/results.json', 'suite-*/artifacts/browser-test-report.md', 'suite-*/artifacts/report.html',
  'suite-*/artifacts/preflight.log', 'suite-*/artifacts/*-final.png', 'suite-*/artifacts/*-trace.zip',
  'ae-*/artifacts/*.log', 'ae-*/artifacts/E-*.png',
]) assert(allowlist.includes(`tests/.acceptance-runs/${path}`), `Missing artifact path ${path}`);
assert.match(workflow, /include-hidden-files: true/);
assert.match(workflow, /if-no-files-found: error/);
assert.match(workflow, /if: always\(\)/);
assert.doesNotMatch(allowlist, /(?:data-|node_modules|\.env|\*\*|\.sqlite|\.db)/);

const dir = await mkdtemp(resolve(tmpdir(), 'brokerdesk-reporting-'));
const previous = process.env.GITHUB_STEP_SUMMARY;
try {
  process.env.GITHUB_STEP_SUMMARY = resolve(dir, 'summary.md');
  await appendJobSummary(report, 'synthetic');
  await appendJobSummary(preflight, 'synthetic');
  const summary = await readFile(process.env.GITHUB_STEP_SUMMARY, 'utf8');
  assert.equal((summary.match(/### BrokerDesk A–E acceptance/g) || []).length, 2);
  assert.match(summary, /Failed scenarios: A/);
  assert.match(summary, /Primary failure: Browser setup failed/);
} finally {
  if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
  else process.env.GITHUB_STEP_SUMMARY = previous;
  await rm(dir, { recursive: true, force: true });
}
console.log('PASS: synthetic reporting, separate setup/cleanup reasons, preflight excerpt, appended job summary');

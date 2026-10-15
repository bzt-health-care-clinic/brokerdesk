import { appendFile } from 'node:fs/promises';

const limit = (value, max = 240) => {
  const text = String(value ?? '').split(/\r?\n/, 1)[0]
    .replace(/https?:\/\/[^\s)]+/g, raw => { try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL]'; } })
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\x00-\x1f\x7f]/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
export const safeDiagnostic = limit;

const primaryReason = report => report.reason || report.scenarios
  .flatMap(s => s.checks.filter(c => c.status === 'FAILED').map(c => `${s.id} ${c.name}: ${c.error || 'failed'}`))[0]
  || (report.cleanupError ? 'Cleanup failed' : report.status);

export function diagnosticSummary(report, output, preflightLog = '') {
  const lines = [
    `Overall: ${limit(report.status)}`,
    `BROWSER_EXECUTED: ${Boolean(report.BROWSER_EXECUTED)}`,
    `STUBBED_OCR: ${limit(report.STUBBED_OCR)}; LIVE_OCR: ${limit(report.LIVE_OCR)}`,
    `Preflight: ${limit(report.preflight || 'NOT_RUN')}`,
    `Primary failure: ${limit(primaryReason(report))}`,
  ];
  for (const s of report.scenarios) {
    lines.push(`${limit(s.id)}: ${limit(s.status)}`);
    const failures = s.checks.filter(c => c.status === 'FAILED');
    for (const c of failures.slice(0, 12)) lines.push(`  FAILED ${limit(c.name, 100)}: ${limit(c.error || 'No error message recorded')}`);
    if (failures.length > 12) lines.push(`  …${failures.length - 12} additional failed checks in results.json`);
    const events = [...s.errors.map(e => `${e.kind}: ${e.message}`), ...s.failedRequests.filter(r => !r.expectedProviderFailure).map(r => `network: ${r.status || r.reason || 'failed'} ${r.url}`)];
    for (const event of events.slice(0, 4)) lines.push(`  ${limit(event)}`);
    if (events.length > 4) lines.push(`  …${events.length - 4} additional page/worker/network events in results.json`);
  }
  if (report.preflight === 'FAILED') {
    const excerpt = preflightLog.split(/\r?\n/).filter(line => /preflight diagnostic|error|failed|blocked|timeout|timed out|not found/i.test(line)).slice(-6);
    for (const line of excerpt) lines.push(`Preflight log: ${limit(line)}`);
    lines.push('Full preflight.log retained in allowlisted artifacts.');
  }
  lines.push(`Cleanup error: ${limit(report.cleanupError || 'none')}`);
  lines.push(`Report directory: ${output}`);
  return lines.join('\n');
}

export async function appendJobSummary(report, output) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const failed = report.scenarios.filter(s => s.status === 'FAILED' || s.status === 'FAILED_TIMEOUT');
  const safe = value => limit(value).replaceAll('|', '\\|').replaceAll('`', "'");
  const markdown = `\n### BrokerDesk A–E acceptance\n\n- Outcome: ${safe(report.status)}\n- Browser executed: ${Boolean(report.BROWSER_EXECUTED)}\n- Stubbed OCR: ${safe(report.STUBBED_OCR)}; live OCR: ${safe(report.LIVE_OCR)}\n- Preflight: ${safe(report.preflight || 'NOT_RUN')}\n- Primary failure: ${safe(primaryReason(report))}\n- Failed scenarios: ${failed.length ? failed.map(s => safe(s.id)).join(', ') : 'none'}\n- Cleanup error: ${safe(report.cleanupError || 'none')}\n- Report directory: ${safe(output)}\n`;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
}

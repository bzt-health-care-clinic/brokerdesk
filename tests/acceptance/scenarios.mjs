import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { api, backend, frontend, expected, fixture, sha, poll } from './runtime.mjs';
import { acceptedSuggestionsPersisted, newPageDuring, responseDuring, selectedCaseMatches } from './harness-state.mjs';

export const names = {
  A: 'Case lifecycle and persistence', B: 'Searchable PDF, two drivers, report boundaries',
  C: 'Actual PDF worker, scan and mixed package', D: 'Active evidence, manual sections and rename',
  E: 'UI errors, controls and known pending findings',
};
export async function runScenario(id, page, rt, result) {
  const step = async (name, fn, category = 'workflow') => {
    try { await fn(); result.checks.push({ name, category, status: 'PASS' }); }
    catch (e) { result.checks.push({ name, category, status: 'FAILED', error: e.message }); }
  };
  const cases = () => api('/cases');
  const saved = caseId => api(`/cases/${caseId}`);
  const docs = caseId => api(`/cases/${caseId}/documents`);
  const card = doc => page.locator('.ingestion-record').filter({ has: page.locator('.record-top').filter({ hasText: doc.currentFileName ?? doc.fileName }) });
  async function prompts(action, answer) {
    const errors = []; const handler = async d => { try { const value = answer(d.message(), d.defaultValue()); if (value === null) await d.dismiss(); else await d.accept(String(value)); } catch (e) { errors.push(e); await d.dismiss(); } };
    page.on('dialog', handler); try { await action(); } finally { page.off('dialog', handler); } if (errors.length) throw errors[0];
  }
  async function newCase(type = 'New Auto', label = `${id} synthetic acceptance`) {
    const before = await cases(); await page.getByRole('button', { name: type, exact: true }).click();
    await page.getByRole('button', { name: /^(New case|Create a new case)$/ }).click();
    const record = await poll(async () => (await cases()).find(x => !before.some(b => b.id === x.id)), 'one UI-created case');
    await page.locator('.case-title-actions').getByRole('button', { name: 'Rename', exact: true }).waitFor();
    await prompts(() => page.locator('.case-title-actions').getByRole('button', { name: 'Rename', exact: true }).click(), () => label);
    await poll(async () => (await saved(record.id)).label === label, 'case rename persisted'); return record.id;
  }
  async function selectCase(caseId) {
    const c = await saved(caseId); await page.locator('.local-case-list').getByRole('button').filter({ hasText: c.label }).click();
    await poll(async () => {
      const active = page.locator('.local-case-list button[aria-current="page"]');
      if (await active.count() !== 1) return false;
      return selectedCaseMatches(await active.locator('strong').textContent(), await page.locator('.case-title .eyebrow').textContent(), c.label, caseId);
    }, 'selected case identity and active state');
  }
  async function upload(caseId, files, drop = false) {
    const before = (await docs(caseId)).map(d => d.id);
    if (drop) {
      const bytes = [...await readFile(fixture(files[0]))];
      const dt = await page.evaluateHandle(({ bytes, name }) => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })); return transfer; }, { bytes, name: files[0] });
      await page.locator('.upload-zone').dispatchEvent('drop', { dataTransfer: dt }); await dt.dispose();
    } else {
      const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: 'Upload documents', exact: true }).click();
      await (await chooser).setFiles(files.map(fixture));
    }
    await poll(async () => { const list = (await docs(caseId)).filter(d => !before.includes(d.id)); return list.length === files.length && list.every(d => !d.packageProgress || ['COMPLETE','PARTIAL'].includes(d.packageProgress.status)) && list; }, 'upload and real package processing', 90000);
    await page.locator('.upload-zone').getAttribute('aria-busy').then(async busy => { if (busy === 'true') await page.locator('.upload-zone[aria-busy="false"]').waitFor({ timeout: 90000 }); });
    return (await docs(caseId)).filter(d => !before.includes(d.id));
  }
  async function bytesKept(doc, original) {
    const db = new DatabaseSync(resolve(rt.data, 'brokerdesk.db'), { readOnly: true });
    try { const row = db.prepare('SELECT relative_path FROM documents WHERE id=?').get(doc.id); assert(row); const disk = await readFile(resolve(rt.data, row.relative_path)); assert.equal(sha(disk), sha(await readFile(fixture(original)))); }
    finally { db.close(); }
    const r = await fetch(`${backend}/documents/${doc.id}/file`); assert.equal(r.status, 200); assert.equal(sha(Buffer.from(await r.arrayBuffer())), sha(await readFile(fixture(original))));
  }
  async function reparse(caseId, doc) {
    const before = rt.calls.length;
    const put = await responseDuring(page, r => r.url() === `${backend}/documents/${doc.id}` && r.request().method() === 'PUT',
      () => card(doc).getByRole('button', { name: 'Reparse saved text (local)', exact: true }).click()); assert(put.ok());
    await poll(async () => (await docs(caseId)).find(d => d.id === doc.id), 'reparsed saved record'); assert.equal(rt.calls.length, before);
  }
  async function acceptSuggestions(caseId, doc) {
    if ((doc.suggestedSections ?? []).some(s => s.suggestionStatus === 'PENDING')) {
      const target = `${backend}/documents/${doc.id}`;
      const observed = { requests: 0, statuses: [], failures: [] };
      const matches = request => request.url() === target && request.method() === 'PUT';
      const onRequest = request => { if (matches(request)) observed.requests++; };
      const onResponse = response => { if (matches(response.request())) observed.statuses.push(response.status()); };
      const onFailure = request => { if (matches(request)) observed.failures.push(request.failure()?.errorText ?? 'unknown failure'); };
      page.on('request', onRequest); page.on('response', onResponse); page.on('requestfailed', onFailure);
      try {
        await card(doc).getByRole('button', { name: 'Accept all', exact: true }).click();
        return await poll(async () => {
          const after = (await docs(caseId)).find(savedDoc => savedDoc.id === doc.id);
          return acceptedSuggestionsPersisted(doc, after) && after;
        }, 'accepted sections persisted', 60000);
      } catch (error) {
        throw new Error(`Accept all did not persist: ${error.message}; PUT requests=${observed.requests}, statuses=${observed.statuses.join(',') || 'none'}, failures=${observed.failures.join(',') || 'none'}`, { cause: error });
      } finally {
        page.off('request', onRequest); page.off('response', onResponse); page.off('requestfailed', onFailure);
      }
    }
    return (await docs(caseId)).find(d => d.id === doc.id);
  }
  async function associate(caseId, doc, section, driver) {
    const c = await saved(caseId); const index = c.drivers.findIndex(d => d.id === driver.id); assert(index >= 0);
    await card(doc).locator('summary').filter({ hasText: /^Manage sections$/ }).click();
    const row = card(doc).locator('.section-manager:not(.suggested-sections) article').filter({ hasText: section.startPage === section.endPage ? `Page ${section.startPage} ·` : `Pages ${section.startPage}–${section.endPage}` });
    const response = await responseDuring(page, r => r.url() === `${backend}/documents/${doc.id}` && r.request().method() === 'PUT',
      () => prompts(() => row.getByRole('button', { name: 'Edit', exact: true }).click(), (m, fallback) => m.startsWith('Driver or vehicle') ? driver.name : m.startsWith('Subject type') ? 'DRIVER' : m.startsWith('Associate section') ? String(index + 1) : fallback)); assert(response.ok());
    await card(doc).locator('summary').filter({ hasText: /^Manage sections$/ }).click();
  }
  async function reports(caseId, uploaded, mixed = false) {
    const accepted = [];
    for (const doc of uploaded) accepted.push(await acceptSuggestions(caseId, doc));
    await page.getByRole('tab', { name: 'Driver', exact: true }).click();
    const proposals = page.getByRole('button', { name: /^Confirm driver / });
    for (let attempts = 0; attempts < 10 && await proposals.count(); attempts++) {
      const before = (await saved(caseId)).drivers.length;
      await prompts(() => proposals.first().click(), () => '');
      await poll(async () => (await saved(caseId)).drivers.length > before, 'broker-confirmed proposed driver persisted');
    }
    assert.equal(await proposals.count(), 0, 'Unresolved or ambiguous MVR driver proposals remain visible for review');
    for (const doc of accepted) {
      for (const section of (doc.logicalDocuments ?? []).filter(s => ['MVR','DASH'].includes(s.documentType))) {
        const c = await saved(caseId);
        const offset = section.documentType === 'MVR' ? (mixed ? section.startPage - 11 : section.startPage - 1) : (mixed ? (section.startPage - 5) / 3 : (section.startPage - 1) / 3);
        const subject = expected.test_subjects[offset];
        const driver = subject && c.drivers.find(d => d.licence_number?.replace(/[^A-Z0-9]/g,'') === subject.licence.replace(/[^A-Z0-9]/g,''));
        if (!driver) { result.checks.push({ name: `Association UI prerequisite ${section.documentType} page ${section.startPage}`, status: 'FAILED', category: 'usability', error: 'No uniquely confirmed driver for the report licence; association remains unassigned.' }); continue; }
        await associate(caseId, doc, section, driver);
      }
    }
  }
  async function assertMvr(caseId) {
    const c = await poll(async () => { const v = await saved(caseId); return v.drivers?.some(d => d.mvr_reply_date) && v; }, 'normalized MVR mapping');
    await page.getByRole('tab', { name: 'Driver', exact: true }).click();
    for (let i = 0; i < 2; i++) {
      const truth = expected.mvr_expected[i], identity = expected.test_subjects[i];
      const d = c.drivers.find(d => d.licence_number?.replace(/[^A-Z0-9]/g,'') === identity.licence.replace(/[^A-Z0-9]/g,'')); assert(d, 'Distinct driver required');
      assert.equal(d.mvr_reply_date, truth.replyDate); assert.equal(d.mvr_demerit_points, truth.demeritPoints); assert.equal(d.mvr_convictions?.length, truth.convictionCount);
      const panel = page.locator('.data-section').filter({ has: page.getByRole('heading', { name: d.name, exact: true }) });
      // Fall back to the actual heading's section ancestor, not app state injection.
      const text = await (await panel.count() ? panel : page.getByRole('heading', { name: d.name, exact: true }).locator('xpath=ancestor::section[1]')).innerText();
      assert(text.includes(truth.replyDate));
      const demerits = panel.locator('.key-row').filter({ has: page.locator('dt').filter({ hasText: /^MVR demerit points$/ }) });
      assert((await demerits.locator('dd').innerText()).startsWith(String(truth.demeritPoints)), 'Demerits visible under the correct driver');
      if (truth.convictions) { assert(text.includes(truth.convictions[0].offenceDate)); assert(text.includes(truth.convictions[0].convictionDate)); }
    }
  }
  await page.goto(frontend); await page.getByRole('heading', { name: 'No case selected' }).waitFor();
  if (id === 'A') {
    await step('Empty database and selectors create nothing', async () => {
      assert.deepEqual(await cases(), []);
      for (const type of ['New HAB','Policy Change','New Auto','New Auto']) { await page.getByRole('button', { name: type, exact: true }).click(); assert.deepEqual(await cases(), []); }
    });
    const first = await newCase();
    await step('Exactly one clean production case', async () => { assert.equal((await cases()).length, 1); const c = await saved(first); assert.equal(c.drivers.length, 0); assert.equal(c.vehicles.length, 0); assert.equal(c.claims.length, 0); assert(!c.policy.quote_number); assert(!c.policy.effective_date); assert.equal(c.validationStatus, 'NOT_STARTED'); });
    const second = await newCase('New Auto', 'A second synthetic case');
    const order = (await cases()).map(c => c.id); await selectCase(first);
    const note = 'Synthetic acceptance manual note, retained across backend restart.';
    await page.getByPlaceholder('Generate a concise note from this case.').fill(note);
    await poll(async () => (await api(`/cases/${first}/notes`)).portal === note, 'note saved');
    await step('Older-case edit does not reorder list', async () => { assert.deepEqual((await cases()).map(c => c.id), order); const labels = await page.locator('.local-case-list button strong').allTextContents(); assert.deepEqual(labels, (await cases()).map(c => c.label)); });
    await step('Note survives refresh and actual backend restart', async () => { await page.reload(); await page.getByPlaceholder('Generate a concise note from this case.').waitFor(); assert.equal(await page.getByPlaceholder('Generate a concise note from this case.').inputValue(), note); result.restart = await rt.restart(); await page.reload(); await page.getByPlaceholder('Generate a concise note from this case.').waitFor(); assert.equal(await page.getByPlaceholder('Generate a concise note from this case.').inputValue(), note); });
    await step('Delete both cases; final empty state stays empty', async () => { for (const caseId of [first,second]) { await selectCase(caseId); await prompts(() => page.locator('.delete-case').click(), () => ''); await poll(async () => !(await cases()).some(c => c.id === caseId), 'case removed'); } await page.getByRole('heading', { name: 'No case selected' }).waitFor(); await page.reload(); await page.getByRole('heading', { name: 'No case selected' }).waitFor(); assert.deepEqual(await cases(), []); });
  }
  if (id === 'B') {
    const caseId = await newCase(); const count = rt.calls.length;
    const uploaded = await upload(caseId, ['01_auto_quote_text.pdf','03_mvr_two_drivers_text.pdf','04_dash_two_reports_text.pdf']);
    await step('Searchable PDFs use real embedded extraction and zero provider calls', async () => { assert.equal(rt.calls.length, count); for (const d of uploaded) { assert(d.packagePages.length); assert(d.packagePages.every(p => p.extractionProvider === 'embedded_pdf_text' && p.text)); await bytesKept(d, d.originalFileName); } });
    await step('Two three-page DASH reports and two one-page MVRs', async () => { for (const [name,type,ranges] of [['04_dash_two_reports_text.pdf','DASH',[[1,3],[4,6]]],['03_mvr_two_drivers_text.pdf','MVR',[[1,1],[2,2]]]]) { const d = uploaded.find(d => d.originalFileName === name); const sections = d.suggestedSections?.length ? d.suggestedSections : d.logicalDocuments; assert.deepEqual(sections.filter(s => s.documentType === type).map(s => [s.startPage,s.endPage]), ranges); assert.equal(new Set(sections.map(s => s.id)).size, sections.length); } }, 'extraction');
    await step('Explicit UI associations (or actionable usability failure)', () => reports(caseId, uploaded));
    await step('Subject-specific MVR values displayed', () => assertMvr(caseId), 'extraction');
    await step('Historical claims and party roles preserved', async () => {
      const c = await saved(caseId); for (const truth of expected.claims_expected) { const claim = c.claims.find(c => c.claim_number === truth.claimId); assert(claim, `Missing claim ${truth.claimId}`); assert.equal(claim.loss_date, truth.lossDate); assert.equal(claim.party_role, truth.partyRole ?? truth.subjectPartyRole); assert.equal(claim.at_fault_percent, truth.faultPercent ?? truth.subjectFaultPercent); }
      const thirdParty = c.claims.find(c => c.claim_number === expected.claims_expected[1].claimId);
      assert.equal(thirdParty.party_role, 'THIRD_PARTY');
      // Do not invent a separate first-party claim row. If supplied as a separate
      // row it must stay unknown; source wording must retain the unknown fact.
      const unknown = c.claims.filter(c => c.party_role === 'FIRST_PARTY' && c.loss_date === '2025-10-10'); assert(unknown.every(c => c.at_fault_percent == null));
      const dash = uploaded.find(d => d.originalFileName === '04_dash_two_reports_text.pdf');
      assert.match(dash.packagePages.map(p => p.text).join(' '), /first.party[\s\S]{0,100}(unknown|not (?:available|provided|specified)|unconfirmed)/i);
      await page.getByRole('tab', { name: 'Claims', exact: true }).click(); assert((await page.locator('.tab-body').innerText()).includes('2017-09-28'));
    }, 'extraction');
    await step('One intended effective date in claim review and summary', async () => { const c = await saved(caseId); assert.equal(c.policy.effective_date, expected.policy_assessment_date); await page.getByRole('tab', { name: 'Claims', exact: true }).click(); assert((await page.locator('.tab-body').innerText()).includes(expected.policy_assessment_date)); await page.getByRole('button', { name: /Start key-in/i }).click(); assert((await page.getByRole('dialog').innerText()).includes(expected.policy_assessment_date)); await page.keyboard.press('Escape'); }, 'extraction');
  }
  if (id === 'C') {
    const caseId = await newCase(); const count = rt.calls.length;
    const [scan] = await upload(caseId, ['02_ownership_scan.pdf']);
    await step('Real PDF.js worker/render to external provider boundary', async () => { assert.equal(rt.calls.length-count, 1); assert(rt.calls[count].width > 600); assert.equal(scan.packagePages[0].extractionProvider, 'ocr_space'); assert.equal(scan.packagePages[0].page, 1); assert(result.workers.some(url => /pdf.*worker/i.test(url) || /^blob:https?:\/\//i.test(url)), 'No PDF.js worker observed (asset or Vite blob worker)'); await bytesKept(scan, '02_ownership_scan.pdf'); const opened = await newPageDuring(page.context(), () => card(scan).getByRole('button', { name: 'Open', exact: true }).click()); try { await poll(async () => opened.url().includes(`/documents/${scan.id}/file`), 'scanned PDF popup URL', 10000); } finally { await opened.close(); } });
    const mixedCount = rt.calls.length; const [mixed] = await upload(caseId, ['05_mixed_auto_package.pdf']);
    await step('Twelve real pages, only physical page 4 sent to provider', async () => { assert.equal(mixed.packagePages.length, 12); assert.deepEqual(mixed.packagePages.filter(p => p.extractionProvider === 'ocr_space').map(p => p.page), [4]); assert.equal(rt.calls.length-mixedCount, 1); assert.match(rt.calls[mixedCount].name, /-page-4.jpg$/); assert.equal(mixed.packagePages.filter(p => p.extractionProvider === 'embedded_pdf_text').length, 11); await bytesKept(mixed, '05_mixed_auto_package.pdf'); });
    await step('Mixed report sections and physical provenance', async () => { const sections = mixed.suggestedSections?.length ? mixed.suggestedSections : mixed.logicalDocuments; for (const truth of expected.mixed_package_expected_sections.filter(s => ['MVR','DASH_AUTOPLUS'].includes(s.type))) assert(sections.some(s => s.documentType === (truth.type === 'DASH_AUTOPLUS' ? 'DASH' : truth.type) && s.startPage === truth.pages[0] && s.endPage === truth.pages[1])); for (const source of mixed.parsedSources ?? []) for (const e of Object.values(source.fieldEvidence).flat()) if (e.page) assert(e.page >= 1 && e.page <= 12); }, 'extraction');
    await step('Mixed subjects remain distinct or visibly unassigned', () => reports(caseId, [mixed], true), 'extraction');
    await step('Unsigned application is not granted signed validity', async () => { const c = await saved(caseId); assert.notEqual(c.signed, true); const d = (await docs(caseId)).find(d => d.id === mixed.id); assert(!d.logicalDocuments.some(s => s.documentType === 'AUTO_APPLICATION' && s.validationStatus === 'VALID')); });
    await step('Local reparse, reload and case switch make no new OCR requests', async () => { const n = rt.calls.length; await reparse(caseId, mixed); await page.reload(); await card(mixed).waitFor(); const other = await newCase('New Auto', 'C switch target'); assert(other !== caseId); await selectCase(caseId); await card(mixed).waitFor(); assert.equal(rt.calls.length, n); });
    await step('Provider failure stays in document card, not full-page crash', async () => { rt.failProviderOnce(); const [failed] = await upload(caseId, ['02_ownership_scan.pdf']); assert.equal(failed.packageProgress.status, 'PARTIAL'); assert.equal(failed.packageProgress.failed, 1); assert.match(await card(failed).innerText(), /failed|partial/i); assert.equal(await page.locator('vite-error-overlay').count(), 0); await page.getByRole('button', { name: 'Upload documents', exact: true }).waitFor(); });
  }
  if (id === 'D') {
    const caseId = await newCase(); const [original] = await upload(caseId, ['05_mixed_auto_package.pdf']);
    let doc = await acceptSuggestions(caseId, original); const section = doc.logicalDocuments.find(s => s.documentType === 'AUTO_QUOTE') ?? doc.logicalDocuments[0]; assert(section, 'No section to edit');
    const siblings = doc.logicalDocuments.filter(s => s.id !== section.id).map(s => s.id);
    await step('Manual section edit and local reparse retain classification/association', async () => {
      await card(doc).locator('summary').filter({ hasText: /^Manage sections$/ }).click();
      const row = card(doc).locator('.section-manager:not(.suggested-sections) article').nth(doc.logicalDocuments.findIndex(s => s.id === section.id));
      const put = await responseDuring(page, r => r.url() === `${backend}/documents/${doc.id}` && r.request().method() === 'PUT',
        () => prompts(() => row.getByRole('button', { name: 'Edit', exact: true }).click(), (m, fallback) => m.startsWith('Driver or vehicle') ? 'Synthetic manually reviewed section' : m.startsWith('Subject type') ? 'DRIVER' : m.startsWith('Associate section') ? '1' : fallback)); assert(put.ok()); doc = (await docs(caseId)).find(d => d.id === doc.id); const manual = doc.logicalDocuments.find(s => s.id === section.id); assert.equal(manual.classificationSource, 'MANUAL');
      await reparse(caseId, doc); const after = (await docs(caseId)).find(d => d.id === doc.id).logicalDocuments.find(s => s.id === section.id); assert.equal(after.documentType, manual.documentType); assert.equal(after.subjectId, manual.subjectId); assert.equal(after.subjectName, manual.subjectName);
    });
    await step('Manual decision survives source withdrawal with review flag', async () => {
      await page.getByRole('button', { name: /Start key-in/i }).click(); await page.keyboard.press('Escape');
      const before = await saved(caseId);
      const candidates = before.field_sources.filter(field => field.values?.length);
      const linked = candidates.find(field => field.values.some(value => value.documentId === doc.id && value.logicalDocumentId === section.id));
      const selected = linked ?? candidates[0];
      assert(selected, 'No extracted field is available for broker-confirmed source resolution');
      const controls = page.locator('.manual-evidence-decision');
      await controls.waitFor();
      await controls.getByRole('combobox', { name: 'Evidence field to confirm' }).selectOption(selected.field);
      await prompts(() => controls.getByRole('button', { name: 'Enter correct value', exact: true }).click(), () => 'Synthetic retained broker decision');
      const manual = await poll(async () => (await saved(caseId)).field_sources.find(f => f.status === 'resolved' && f.resolved_value === 'Synthetic retained broker decision' && !before.field_sources.some(b => b.field === f.field && b.resolved_value === f.resolved_value)), 'manual decision');
      result.manualDecision = { field: manual.field, value: manual.resolved_value, sources: manual.values };
    });
    await step('Deleting section withdraws automatic facts; siblings/file remain', async () => {
      doc = (await docs(caseId)).find(d => d.id === doc.id);
      const manager = card(doc).locator('.section-manager:not(.suggested-sections)'); if ((await manager.getAttribute('open')) === null) await manager.locator('summary').click();
      const put = await responseDuring(page, r => r.url() === `${backend}/documents/${doc.id}` && r.request().method() === 'PUT',
        () => manager.locator('article').nth(doc.logicalDocuments.findIndex(s => s.id === section.id)).getByRole('button', { name: 'Delete section', exact: true }).click()); assert(put.ok());
      await poll(async () => !(await saved(caseId)).field_sources.some(f => f.values.some(v => v.documentId === doc.id && v.logicalDocumentId === section.id)), 'active source withdrawn');
      doc = (await docs(caseId)).find(d => d.id === doc.id); assert.deepEqual(doc.logicalDocuments.map(s => s.id), siblings); assert(!(doc.parsedSources ?? []).some(s => s.logicalDocumentId === section.id)); await bytesKept(doc, '05_mixed_auto_package.pdf');
      if (result.manualDecision) { const decision = (await saved(caseId)).field_sources.find(f => f.field === result.manualDecision.field); assert.equal(decision?.resolved_value, result.manualDecision.value); if (result.manualDecision.sources.some(v => v.logicalDocumentId === section.id)) assert(decision.evidenceReview); }
    });
    await step('Rename and actual backend restart preserve physical/logical identity', async () => {
      const response = await responseDuring(page, r => r.url() === `${backend}/documents/${doc.id}/rename`,
        () => prompts(() => card(doc).getByRole('button', { name: 'Rename', exact: true }).click(), () => 'Synthetic combined reviewed.pdf')); assert(response.ok());
      result.restart = await rt.restart(); await page.reload(); doc = (await docs(caseId)).find(d => d.id === doc.id); assert.equal(doc.originalFileName, '05_mixed_auto_package.pdf'); assert.equal(doc.currentFileName, 'Synthetic combined reviewed.pdf'); assert.deepEqual(doc.logicalDocuments.map(s => s.id), siblings); await bytesKept(doc, '05_mixed_auto_package.pdf'); await card(doc).waitFor();
      const opened = await newPageDuring(page.context(), () => card(doc).getByRole('button', { name: 'Open', exact: true }).click()); try { await poll(async () => opened.url().includes(`/documents/${doc.id}/file`), 'renamed PDF popup URL', 10000); } finally { await opened.close(); }
    });
  }
  if (id === 'E') {
    const caseId = await newCase();
    await step('Native chooser event uploads supplied image bytes', async () => { const [d] = await upload(caseId, ['02_ownership_scan.png']); await bytesKept(d, '02_ownership_scan.png'); });
    await step('DOM drag/drop uploads PDF (not Windows Explorer validation)', async () => { const [d] = await upload(caseId, ['01_auto_quote_text.pdf'], true); await bytesKept(d, '01_auto_quote_text.pdf'); });
    await step('Desktop and narrow controls reachable; bottom screenshots', async () => {
      for (const [width,height] of [[1440,1000],[390,844]]) {
        await page.setViewportSize({ width,height }); const button = page.locator('.note-actions').getByRole('button', { name: 'Generate', exact: true });
        await button.scrollIntoViewIfNeeded(); await button.click({ trial: true }); const box = await button.boundingBox(); assert(box && box.y >= 0 && box.y + box.height <= height);
        await page.screenshot({ path: resolve(rt.artifacts, `E-bottom-${width}.png`), fullPage: true });
        const gap = await page.evaluate(() => { const panels = [...document.querySelectorAll('.documents-panel,.keyin-panel,.review-panel')]; return Math.max(...panels.map(p => { const children = [...p.children]; return children.length ? p.scrollHeight - Math.max(...children.map(c => c.getBoundingClientRect().bottom - p.getBoundingClientRect().top + p.scrollTop)) : 0; })); });
        assert(gap < height, `More than one viewport of unused bottom space: ${gap}`);
      }
      await page.setViewportSize({ width:1440,height:1000 });
    });
    await step('HAB and Policy Change baseline observations only', async () => {
      result.pendingBaselines = [];
      for (const [type,name] of [['New HAB','06_hab_mortgage_and_dates_text.pdf'],['Policy Change','07_policy_change_requests_text.pdf']]) {
        const c = await newCase(type, `E ${type} baseline`); const list = await upload(c, [name]);
        result.pendingBaselines.push({ type, status: 'OBSERVED_NOT_ACCEPTED_BATCH_PENDING', documents: list, case: await saved(c) });
        await page.screenshot({ path: resolve(rt.artifacts, `E-${type.replaceAll(' ','-')}.png`), fullPage: true });
      }
    });
  }
  // File existence proves real disposable SQLite, not browser-only File objects.
  await access(resolve(rt.data, 'brokerdesk.db'));
}

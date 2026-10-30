/**
 * BrokerDesk Step 5A local-only, fail-closed coverage measurements.
 * This module does not read PDFs or infer insurance facts. It compares a
 * BrokerDesk review snapshot against independent on-device ground truth and
 * verifies physical-source hashes, pages, logical boundaries and history ledgers.
 *
 * IMPORTANT: NEVER return or log values, field IDs, filenames, source hashes,
 * policyholder identifiers or per-sample results. Public output is allowlisted.
 */
import {createHash} from 'node:crypto';
export const STEP5A_SCHEMA = 'step5a-private-v1';
export const STEP5A_PUBLIC_SCHEMA = 'step5a-redacted-v1';
export const STEP5A_DOMAINS = Object.freeze([
  'VIN', 'OWNERSHIP', 'DRIVER_ASSIGNMENT', 'MVR_COUNT', 'DASH_COUNT',
  'QUOTE_NUMBER', 'EFFECTIVE_DATE', 'COVERAGE', 'OPCF', 'MIXED_SEGMENT',
  'NEEDS_REVIEW'
]);
const DOMAIN_SET = new Set(STEP5A_DOMAINS);
const CODE_SHA = /^[a-f0-9]{40}$/i;
const HASH = /^[a-f0-9]{64}$/i;
const STATES = new Set(['PRESENT', 'EXPLICIT_ZERO', 'UNKNOWN', 'NOT_APPLICABLE']);
const RESULT_CODES = Object.freeze([
  'AUTO_CORRECT_PROVEN', 'AUTO_CORRECT_UNPROVEN', 'BROKER_CORRECTED',
  'INCORRECT', 'MISSING', 'CONFLICT', 'FALSE_CLEAN', 'REVIEW_REQUIRED',
  'UNVERIFIED', 'NOT_APPLICABLE'
]);
const COUNT_DOMAINS = new Set(['MVR_COUNT', 'DASH_COUNT']);
const array = value => Array.isArray(value) ? value : [];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sha = value => typeof value === 'string' && HASH.test(value);
const has = (item, key) => Object.prototype.hasOwnProperty.call(item, key);
const validPage = value => Number.isSafeInteger(value) && value >= 1 && value <= 100000;
const fieldMatchesDomain = (kind, id) => {
  if (kind === 'VIN') return /^vehicle:.+\.vin$/.test(id);
  if (kind === 'OWNERSHIP') return /^vehicle:.+\.(vin|leased|lienholder|lessor)$/.test(id);
  if (kind === 'DRIVER_ASSIGNMENT') return /^vehicle:.+\.driverAssignments$/.test(id);
  if (kind === 'MVR_COUNT') return /^report:mvr:.+\.summary$/.test(id);
  if (kind === 'DASH_COUNT') return /^report:dash:.+\.summary$/.test(id);
  if (kind === 'QUOTE_NUMBER') return id === 'policy.quoteNumber';
  if (kind === 'EFFECTIVE_DATE') return ['policy.effectiveDate','change.effectiveDate'].includes(id);
  if (kind === 'COVERAGE') return /^vehicle:.+\.(liability|dcpdDeductible|allPerils\.present|collision\.present|comprehensive\.present|allPerils\.deductible|collision\.deductible|comprehensive\.deductible)$/.test(id) || id === 'home.coverage';
  if (kind === 'OPCF') return /^vehicle:.+\.(opcf|opcf44)$/.test(id);
  if (kind === 'MIXED_SEGMENT') return true; // Physical/logical source proof determines this domain.
  if (kind === 'NEEDS_REVIEW') return true;
  return false;
};
const known = value => value !== null && value !== undefined &&
  !(typeof value === 'string' && value.trim() === '');
const privateError = code => Object.assign(new Error('Step 5A private input rejected'), {code});
const fixedCanonical = value => JSON.stringify(value, (_key, item) =>
  object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) =>
    a.localeCompare(b))) : item);
function sameValue(left, right, category) {
  if (category === 'VIN' && typeof left === 'string' && typeof right === 'string') {
    const vin = s => s.toUpperCase().replace(/[\s-]/g, '');
    return vin(left) === vin(right);
  }
  if (category === 'DRIVER_ASSIGNMENT' && Array.isArray(left) && Array.isArray(right)) {
    const normalize = rows => rows.map(row => ({driverId: row?.driverId, role: row?.role}))
      .sort((a, b) => String(a.driverId).localeCompare(String(b.driverId)));
    return fixedCanonical(normalize(left)) === fixedCanonical(normalize(right));
  }
  return fixedCanonical(left) === fixedCanonical(right);
}
function matchEvidence(review, record, check, field) {
  if (!object(record) || record.hashVerified !== true || !sha(record.sourceHash)) return false;
  const inventory = array(review.source_files);
  if (inventory.filter(row => row?.id === record.id && row.sha256 === record.sourceHash).length !== 1) return false;
  if (record.id !== check.documentId || !validPage(check.physicalPage)) return false;
  const sections = array(record.logicalDocuments);
  if (check.category === 'MIXED_SEGMENT' && sections.length < 2) return false;
  if (sections.length) {
    const matches = sections.filter(s => s?.id === check.logicalDocumentId);
    if (matches.length !== 1) return false;
    const s = matches[0];
    if (s.presenceStatus !== 'FOUND' || !validPage(s.startPage) ||
        !validPage(s.endPage) || s.startPage > check.physicalPage ||
        check.physicalPage > s.endPage || s.withdrawn === true || s.revoked === true) return false;
    const requiredType = check.category === 'MVR_COUNT' ? 'MVR' :
      check.category === 'DASH_COUNT' ? 'DASH' : null;
    if (requiredType && s.documentType !== requiredType) return false;
  } else if (check.logicalDocumentId !== null && check.logicalDocumentId !== undefined) return false;
  if (array(record.withdrawnSectionRanges).some(x =>
    Number.isSafeInteger(x?.startPage) && Number.isSafeInteger(x?.endPage) &&
    check.physicalPage >= x.startPage && check.physicalPage <= x.endPage)) return false;
  if (array(record.packagePages).length && !record.packagePages.some(p =>
      (p.page ?? p.pageNumber) === check.physicalPage &&
      p.extractionStatus !== 'FAILED' &&
      !['NEEDS_OCR', 'OCR_FAILED', 'PDF_RENDER_FAILED'].includes(p.pageOcrStatus))) return false;
  return array(field?.evidence).some(p =>
    p?.documentId === record.id && p?.sourceHash === record.sourceHash &&
    p?.page === check.physicalPage &&
    (p?.logicalDocumentId ?? null) === (check.logicalDocumentId ?? null));
}
function snapshotIntegrity(sample) {
  const review=sample.review;
  if (review?.schema_version !== 1 || review.case_type !== sample.case_type ||
      !['DRAFT','BROKER_CONFIRMED'].includes(review.review_status) ||
      !Array.isArray(review.expected_field_ids) ||
      review.expected_field_ids.length !== review.fields.length ||
      review.expected_field_ids.some((id,i) => id !== review.fields[i]?.id) ||
      new Set(review.expected_field_ids).size !== review.fields.length) return false;
  const declared=array(review.source_files), records=array(sample.records);
  if (declared.length !== records.length ||
      new Set(declared.map(s=>s.id)).size !== declared.length ||
      new Set(records.map(r=>r.id)).size !== records.length) return false;
  if (declared.some(s=>!sha(s?.sha256) ||
      !records.some(r=>r.id===s.id && r.hashVerified===true &&
        r.sourceHash===s.sha256))) return false;
  if (review.review_status==='BROKER_CONFIRMED') {
    if (!sha(review.snapshot_sha256)) return false;
    const without={...review,snapshot_sha256:undefined};
    const digest=createHash('sha256').update(fixedCanonical(without)).digest('hex');
    if (digest!==review.snapshot_sha256) return false;
  }
  return true;
}
function historyCountProof(review, record, check) {
  if (check.countDeclaration !== 'EXPLICIT_FULL_REPORT') return false;
  const ledger = review.driver_history_integrity;
  if (!object(ledger) || ledger.schemaVersion !== '5B-07-v1' ||
      !Array.isArray(ledger.reports) || !Array.isArray(ledger.drivers) ||
      !Array.isArray(ledger.blockingIssues) || ledger.blockingIssues.length ||
      !Array.isArray(ledger.unassigned) || ledger.unassigned.length) return false;
  const type = check.category === 'MVR_COUNT' ? 'MVR' : 'DASH';
  const kind = type === 'MVR' ? 'conviction' : 'claim';
  const reports = ledger.reports.filter(r => r?.documentId === record.id &&
    (r.logicalDocumentId ?? null) === (check.logicalDocumentId ?? null) &&
    r.sourceHash === record.sourceHash && r.documentType === type &&
    Number.isSafeInteger(r.declaredCounts) && r.declaredCounts > 0);
  if (reports.length !== 1) return false;
  const declared = ledger.drivers.flatMap(d => array(d.reportedCounts)).filter(c =>
    c?.reportId === reports[0].reportId && c.kind === kind &&
    c.count === check.expectedCount && c.page === check.physicalPage &&
    c.sourceHash === record.sourceHash);
  return declared.length === 1;
}
function historyValueMatches(field, check) {
  const value = field?.value;
  if (!object(value) || !integer(check.expectedCount)) return false;
  const isMvr = check.category === 'MVR_COUNT';
  const rows = value[isMvr ? 'convictions' : 'claims'];
  const flag = value[isMvr ? 'hasConvictions' : 'hasClaims'];
  return Array.isArray(rows) && rows.length === check.expectedCount &&
    flag === (check.expectedCount > 0);
}
function statusOf(sample, check) {
  if (check.groundTruth === 'NOT_APPLICABLE') return 'NOT_APPLICABLE';
  const review = sample.review;
  const field = array(review.fields).find(f => f?.id === check.fieldId);
  const section = array(review.sections).find(s => s?.id === field?.section);
  if (check.groundTruth === 'UNKNOWN') {
    if (check.originalChecked !== true) return 'UNVERIFIED';
    const value = field?.value;
    const explicitNo = value === false ||
      (typeof value === 'string' && /^(?:NO|NONE|ZERO)$/i.test(value.trim())) ||
      (object(value) && (value.hasClaims === false || value.hasConvictions === false));
    if (explicitNo || (field && known(value) && field.conflict !== true &&
        section?.status === 'CONFIRMED')) return 'FALSE_CLEAN';
    return field ? 'REVIEW_REQUIRED' : 'UNVERIFIED';
  }
  if (check.originalChecked !== true || !field || !snapshotIntegrity(sample)) return 'UNVERIFIED';
  if (field.conflict === true) return 'CONFLICT';
  if (!known(field.value)) return 'MISSING';
  const isCount = COUNT_DOMAINS.has(check.category);
  const correct = isCount ? historyValueMatches(field, check) :
    has(check, 'expectedValue') && sameValue(field.value, check.expectedValue, check.category);
  if (!correct) return 'INCORRECT';
  if (field.origin === 'BROKER_CORRECTED' || field.origin === 'MANUAL_FROM_SOURCE')
    return 'BROKER_CORRECTED';
  if (field.origin !== 'EXTRACTED') return 'UNVERIFIED';
  const records = array(sample.records).filter(r => r?.id === check.documentId);
  const valid = records.length === 1 && matchEvidence(review, records[0], check, field) &&
    (!isCount || historyCountProof(review, records[0], check));
  return valid ? 'AUTO_CORRECT_PROVEN' : 'AUTO_CORRECT_UNPROVEN';
}
function validate(sampleSet) {
  if (!object(sampleSet) || sampleSet.schema_version !== STEP5A_SCHEMA)
    throw privateError('INVALID_SCHEMA');
  if (!['SYNTHETIC_FIXTURE', 'REAL_PRIVATE'].includes(sampleSet.dataset))
    throw privateError('INVALID_DATASET');
  if (typeof sampleSet.target_commit !== 'string' || !CODE_SHA.test(sampleSet.target_commit))
    throw privateError('INVALID_TARGET_COMMIT');
  if (!Array.isArray(sampleSet.samples)) throw privateError('MISSING_SAMPLES');
  const seenIds = new Set();
  for (const sample of sampleSet.samples) {
    if (!object(sample) || !/^S\d{2,4}$/.test(sample.sample_id) ||
        seenIds.has(sample.sample_id)) throw privateError('INVALID_SAMPLE_ID');
    seenIds.add(sample.sample_id);
    if (!['new_auto','new_home','auto_policy_change','home_policy_change'].includes(sample.case_type) ||
        !object(sample.review) || !Array.isArray(sample.review.fields) ||
        !Array.isArray(sample.review.source_files) || !Array.isArray(sample.review.sections) ||
        !Array.isArray(sample.records) || !Array.isArray(sample.checks))
      throw privateError('INVALID_SAMPLE_STRUCTURE');
    const seenChecks = new Set();
    for (const check of sample.checks) {
      if (!object(check) || !DOMAIN_SET.has(check.category) ||
          typeof check.fieldId !== 'string' || !check.fieldId ||
          !STATES.has(check.groundTruth) ||
          !fieldMatchesDomain(check.category,check.fieldId)) throw privateError('INVALID_CHECK');
      if (check.category === 'NEEDS_REVIEW' && check.groundTruth !== 'UNKNOWN')
        throw privateError('INVALID_NEEDS_REVIEW_TRUTH');
      const key = check.category + ':' + check.fieldId;
      if (seenChecks.has(key)) throw privateError('DUPLICATE_CHECK');
      seenChecks.add(key);
      if (check.groundTruth === 'PRESENT' || check.groundTruth === 'EXPLICIT_ZERO') {
        if (COUNT_DOMAINS.has(check.category)) {
          if (!integer(check.expectedCount) ||
              (check.groundTruth === 'EXPLICIT_ZERO' && check.expectedCount !== 0) ||
              (check.groundTruth === 'PRESENT' && check.expectedCount === 0))
            throw privateError('INVALID_COUNT_TRUTH');
        } else if (check.groundTruth === 'EXPLICIT_ZERO')
          throw privateError('INVALID_ZERO_DOMAIN');
        else if (!has(check, 'expectedValue')) throw privateError('MISSING_TRUTH_VALUE');
        if (typeof check.documentId !== 'string' || !check.documentId ||
            !validPage(check.physicalPage)) throw privateError('INVALID_PHYSICAL_PROOF');
      }
    }
  }
}
function redactSummary(rows) {
  const statusCounts = Object.fromEntries(RESULT_CODES.map(code => [code, 0]));
  for (const x of rows) statusCounts[x]++;
  const measured = rows.length - statusCounts.NOT_APPLICABLE;
  const auto = statusCounts.AUTO_CORRECT_PROVEN;
  const pct = measured ? Math.round(auto * 10000 / measured) / 100 : null;
  return {measured, auto_correct_with_proof:auto,
    auto_correct_rate_percent:pct, statuses:statusCounts};
}
export function measureStep5A(input, {expectedCommit = null} = {}) {
  validate(input);
  if (expectedCommit && input.target_commit !== expectedCommit)
    throw privateError('CODE_SHA_MISMATCH');
  const tally = new Map(STEP5A_DOMAINS.map(domain => [domain, []]));
  for (const sample of input.samples) {
    for (const check of sample.checks) tally.get(check.category).push(statusOf(sample,check));
  }
  const categories = STEP5A_DOMAINS.map(domain => ({
    category:domain, ...redactSummary(tally.get(domain))
  }));
  const allRows = STEP5A_DOMAINS.flatMap(domain => tally.get(domain));
  const totals = redactSummary(allRows);
  const uncovered = categories.filter(x => x.measured === 0).map(x => x.category);
  const failed = ['AUTO_CORRECT_UNPROVEN','INCORRECT','MISSING','CONFLICT','FALSE_CLEAN','UNVERIFIED']
    .reduce((n, code) => n + totals.statuses[code], 0);
  const mode = input.dataset === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC_ONLY' :
    !input.samples.length ? 'NO_REAL_SAMPLES' :
    uncovered.length || failed ? 'REAL_MEASUREMENT_INCOMPLETE_OR_FAILED' :
      'REAL_MEASURED_AWAITING_BUSINESS_THRESHOLDS_AND_SIGNOFF';
  // A field matching broker-corrected ground truth is NOT auto extraction success.
  // This is operator-attested source comparison, not an independent OCR accuracy certificate.
  return {
    schema_version:STEP5A_PUBLIC_SCHEMA,
    dataset:input.dataset === 'SYNTHETIC_FIXTURE' ? 'SYNTHETIC' : 'PRIVATE_REAL_OPERATOR_ATTESTED',
    status:mode,
    target_commit:input.target_commit,
    sample_count:input.samples.length,
    totals,
    categories,
    unmeasured_categories:uncovered,
    operator_attestation_required:true,
    business_thresholds_defined:false,
    real_sample_accuracy_certified:false,
    raw_values_included:false
  };
}

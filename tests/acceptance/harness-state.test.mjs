import assert from 'node:assert/strict';
import { acceptedSuggestionsPersisted, responseDuring, selectedCaseMatches } from './harness-state.mjs';

assert(selectedCaseMatches('A synthetic acceptance', 'local-mixedCase · New Auto', 'A synthetic acceptance', 'local-mixedCase'));
assert(!selectedCaseMatches('A second synthetic case', 'local-mixedCase · New Auto', 'A synthetic acceptance', 'local-mixedCase'));
assert(!selectedCaseMatches('A synthetic acceptance', 'local-other · New Auto', 'A synthetic acceptance', 'local-mixedCase'));
assert(!selectedCaseMatches('A synthetic acceptance', 'LOCAL-MIXEDCASE · NEW AUTO', 'A synthetic acceptance', 'local-mixedCase'));

const before = { suggestedSections: [{ id: 'one', suggestionStatus: 'PENDING' }, { id: 'two', suggestionStatus: 'PENDING' }] };
const after = { suggestedSections: before.suggestedSections.map(section => ({ ...section, suggestionStatus: 'ACCEPTED' })), logicalDocuments: [{ id: 'one' }, { id: 'two' }] };
assert(acceptedSuggestionsPersisted(before, after));
assert(!acceptedSuggestionsPersisted(before, { ...after, logicalDocuments: [{ id: 'one' }] }));
assert(!acceptedSuggestionsPersisted(before, { ...after, suggestedSections: before.suggestedSections }));
assert(!acceptedSuggestionsPersisted(before, undefined));

let rejectResponse;
const page = { waitForResponse: () => new Promise((_, reject) => { rejectResponse = reject; }) };
let unhandled = 0;
const onUnhandled = () => { unhandled++; };
process.on('unhandledRejection', onUnhandled);
try {
  await assert.rejects(responseDuring(page, () => true, () => { throw new Error('click failed'); }), /click failed/);
  rejectResponse(new Error('response timeout'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled, 0);
  await assert.rejects(responseDuring({ waitForResponse: () => Promise.reject(new Error('response timeout')) }, () => true, async () => {}), /response timeout/);
  assert.equal(unhandled, 0);
} finally { process.off('unhandledRejection', onUnhandled); }
console.log('PASS: selected identity, persisted suggestions, handled response wait rejection');

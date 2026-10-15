export function selectedCaseMatches(activeLabel, titleText, expectedLabel, caseId) {
  return activeLabel === expectedLabel && titleText?.split(' · ')[0] === caseId;
}

export function acceptedSuggestionsPersisted(before, after) {
  const pending = before.suggestedSections?.filter(section => section.suggestionStatus === 'PENDING') ?? [];
  return pending.length > 0 && Boolean(after) && pending.every(section =>
    after.suggestedSections?.some(saved => saved.id === section.id && saved.suggestionStatus === 'ACCEPTED') &&
    after.logicalDocuments?.some(saved => saved.id === section.id));
}

export async function responseDuring(page, predicate, action) {
  const waiting = page.waitForResponse(predicate);
  const [response] = await Promise.all([waiting, Promise.resolve().then(action)]);
  return response;
}

// Test-only backend preload: preserve real fetch, allow only the declared provider stub.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'http://127.0.0.1:47842' || url.pathname !== '/parse/image') throw new Error('Acceptance blocked an external backend request');
  return realFetch(input, init);
};

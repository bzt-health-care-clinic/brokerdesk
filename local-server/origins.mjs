export function localAllowedOrigins(environment = process.env) {
  const origins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
  const configured = environment.BROKERDESK_LOCAL_FRONTEND_ORIGIN;
  if (!configured) return origins;
  let url;
  try { url = new URL(configured); } catch { throw new Error('Invalid BROKERDESK_LOCAL_FRONTEND_ORIGIN'); }
  // Explicit canonical loopback origin only; never accept paths, credentials or LAN hosts.
  if (url.origin !== configured || !['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('BROKERDESK_LOCAL_FRONTEND_ORIGIN must be an exact loopback origin');
  }
  origins.add(configured);
  return origins;
}

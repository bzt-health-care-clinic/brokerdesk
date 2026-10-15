import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { localAllowedOrigins } from '../local-server/origins.mjs';

assert.deepEqual([...localAllowedOrigins({})], ['http://127.0.0.1:5173', 'http://localhost:5173']);
for (const value of ['*', 'http://192.168.1.2:5183', 'https://example.com', 'http://127.0.0.1:5183/', 'http://user@localhost:5183']) {
  assert.throws(() => localAllowedOrigins({ BROKERDESK_LOCAL_FRONTEND_ORIGIN: value }));
}
process.env.BROKERDESK_DATA_DIR = await mkdtemp(join(tmpdir(), 'brokerdesk-origin-test-'));
process.env.BROKERDESK_LOCAL_API_PORT = '0';
process.env.BROKERDESK_LOCAL_FRONTEND_ORIGIN = 'http://127.0.0.1:5183';
process.env.OCRSPACE_API_KEY = '';
process.env.OCRSPACE_API_URL = 'http://127.0.0.1:1/disabled';
const { server } = await import('../local-server/server.mjs');
if (!server.listening) await once(server, 'listening');
try {
  const target = `http://127.0.0.1:${server.address().port}/bootstrap`;
  for (const origin of ['http://127.0.0.1:5183', 'http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:5184', 'https://unapproved.example']) {
    const approved = localAllowedOrigins().has(origin);
    for (const method of ['GET', 'OPTIONS']) {
      const response = await fetch(target, { method, headers: { Origin: origin } });
      assert.equal(response.status, approved ? (method === 'OPTIONS' ? 204 : 200) : 403);
      assert.equal(response.headers.get('access-control-allow-origin'), approved ? origin : null);
      if (approved && method === 'GET') assert.deepEqual((await response.json()).cases, []);
    }
  }
  console.log('PASS: explicit test origin, rejected origins, existing defaults; GET and OPTIONS; disposable SQLite; no OCR.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

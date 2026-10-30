import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const providerGuardImportSpecifier = pathToFileURL(resolve(root, 'tests/acceptance/provider-network-guard.mjs')).href;
export const frontend = 'http://127.0.0.1:5183';
export const backend = 'http://127.0.0.1:47841';
export const pack = resolve(root, 'tests/fixtures/browser-acceptance-20261015/BrokerDesk_Synthetic_Test_Pack');
export const fixture = name => resolve(pack, 'fixtures', name);
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const expected = JSON.parse(await readFile(resolve(pack, 'expected/expected-results.json'), 'utf8'));
const ground = JSON.parse(await readFile(resolve(pack, 'expected/ownership_ground_truth.json'), 'utf8'));
export async function poll(fn, message, timeout = 45000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 150)); }
  throw new Error(`Timed out: ${message}`);
}
export async function api(path) {
  // Observations only: all application mutations must go through UI.
  const r = await fetch(backend + path); assert.equal(r.status, 200, `GET ${path}`); return r.json();
}
async function free(port) {
  await new Promise((ok, fail) => { const s = netServer(); s.once('error', fail); s.listen(port, '127.0.0.1', () => s.close(ok)); });
}
function dimensions(b) {
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  assert.equal(b.readUInt16BE(0), 0xffd8, 'Provider must receive a real rendered JPEG or supplied PNG, not a PDF');
  let p = 2;
  while (p < b.length) {
    assert.equal(b[p++], 255); while (b[p] === 255) p++;
    const marker = b[p++]; if (marker === 0xd9 || marker === 0xda) break;
    const length = b.readUInt16BE(p);
    if ([0xc0,0xc1,0xc2].includes(marker)) return [b.readUInt16BE(p + 5), b.readUInt16BE(p + 3)];
    p += length;
  }
  throw new Error('Rendered image dimensions unavailable');
}
export async function createRuntime() {
  // Never load the customer's environment, even for an accidentally local invocation.
  for (const file of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    try { await access(resolve(root, file)); throw new Error('Acceptance requires a clean checkout without application environment files'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  for (const f of expected.fixtures) assert.equal(sha(await readFile(resolve(pack, f.file))), f.sha256, `Fixture integrity: ${f.file}`);
  for (const port of [5183,47841,47842]) await free(port);
  const base = resolve(root, 'tests/.acceptance-runs'); await mkdir(base, { recursive: true });
  const run = await mkdtemp(resolve(base, 'ae-'));
  const artifacts = resolve(run, 'artifacts'); await mkdir(artifacts);
  const calls = []; const cloudCalls = []; const logs = {}; const processes = [];
  let apiProcess; let data; let failNext = false;
  const stub = createServer(async (req, res) => {
    const call = { mode: 'LEGACY_CLOUD_STUB', name: '', bytes: 0, width: 0, height: 0, status: 0 }; cloudCalls.push(call);
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/parse/image');
      const chunks = []; for await (const c of req) chunks.push(c);
      const form = await new Request('http://127.0.0.1:47842/parse/image', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
      const file = form.get('file'); assert(file instanceof File);
      call.name = file.name; call.bytes = file.size;
      assert.match(file.name, /^(02_ownership_scan(?:-page-1)?\.(?:jpg|png)|05_mixed_auto_package-page-4\.jpg)$/);
      const bytes = Buffer.from(await file.arrayBuffer());
      [call.width, call.height] = dimensions(bytes);
      if (file.name.endsWith('.png')) assert.equal(sha(bytes), expected.fixtures.find(f => f.file.endsWith('02_ownership_scan.png')).sha256);
      if (failNext) { failNext = false; call.expectedFailure = true; throw new Error('Declared synthetic provider failure'); }
      // Authoring PDF-point coordinates explicitly scaled to actual rendered image pixels.
      const sx = call.width / ground.page_width, sy = call.height / ground.page_height;
      const Lines = ground.blocks.map(b => { const [x1,y1,x2,y2] = b.bbox_pdf_points; return { Words: [{ WordText: b.text, Left: x1*sx, Top: y1*sy, Width: (x2-x1)*sx, Height: (y2-y1)*sy }] }; });
      call.status = 200; res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ IsErroredOnProcessing: false, OCRExitCode: 1, ParsedResults: [{ ParsedText: ground.text, TextOverlay: { Lines }, TextOrientation: 0 }] }));
    } catch (e) { call.status = 502; call.error = e.message; res.writeHead(502); res.end('Synthetic provider failure'); }
  });
  await new Promise(r => stub.listen(47842, '127.0.0.1', r));
  // The app now uses a local-only OCR transport. Browser-test route interception
  // emulates that loopback boundary without installing Tesseract in CI. It does
  // NOT measure real Tesseract accuracy or exercise the local-server OCR handler.
  async function handleLocalOcr(route) {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, backend);
    if (url.pathname === '/local-ocr/health' && request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        state: 'ONLINE', provider: 'local_tesseract', mode: 'LOCAL_ONLY',
        version: '5.0.0-SYNTHETIC-STUB', modelLoaded: true, language: 'eng',
        maxFileBytes: 8388608, maxConcurrentJobs: 1
      }) });
      return;
    }
    const call = { mode: 'STUBBED_LOCAL_OCR', name: '', bytes: 0, width: 0, height: 0, status: 0 };
    calls.push(call);
    try {
      assert.equal(request.method(), 'POST');
      assert.equal(url.pathname, '/local-ocr');
      const form = await new Request(request.url(), {
        method: 'POST',
        headers: { 'content-type': request.headers()['content-type'] },
        body: request.postDataBuffer()
      }).formData();
      const file = form.get('file');
      assert(file instanceof File, 'Local OCR must receive a real rendered image File');
      call.name = file.name; call.bytes = file.size;
      assert.match(file.name, /^(02_ownership_scan(?:-page-1)?\.(?:jpg|png)|05_mixed_auto_package-page-4\.jpg)$/);
      const bytes = Buffer.from(await file.arrayBuffer());
      [call.width, call.height] = dimensions(bytes);
      if (file.name.endsWith('.png')) assert.equal(sha(bytes),
        expected.fixtures.find(f => f.file.endsWith('02_ownership_scan.png')).sha256);
      if (failNext) {
        failNext = false; call.expectedFailure = true;
        throw new Error('Declared synthetic local OCR failure');
      }
      const sx = call.width / ground.page_width, sy = call.height / ground.page_height;
      const blocks = ground.blocks.map(b => {
        const [x1,y1,x2,y2] = b.bbox_pdf_points;
        return { text:b.text, confidence:.99,
          boundingBox:{ x:x1*sx, y:y1*sy, width:(x2-x1)*sx, height:(y2-y1)*sy } };
      });
      call.status = 200;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        text:ground.text, rawText:ground.text, normalizedText:ground.text,
        confidence:.99,
        pages:[{ page:1, pageNumber:1, text:ground.text, confidence:.99,
          blocks, width:call.width, height:call.height }],
        metadata:{ provider:'local_tesseract', mode:'LOCAL_ONLY', requestSucceeded:true,
          requiresBrokerVerification:true, geometryOrientationVerified:false }
      }) });
    } catch (error) {
      call.status = 502; call.error = error.message;
      await route.fulfill({ status: 502, contentType:'application/json',
        body: JSON.stringify({ error:'Synthetic local OCR failure',code:'OCR_LOCAL_PROCESS_FAILED' }) });
    }
  }
  // Test-only OCR bridge: Chromium/Playwright may redact multipart File bodies in
  // intercepted requests. The browser sends its actual FormData File bytes to
  // this binding before any transport serialization. No customer files are used,
  // and this stub is never installed in production.
  async function handleLocalOcrBrowser(payload) {
    assert(payload && typeof payload === 'object');
    const path = payload.path;
    const method = payload.method;
    assert((path === '/local-ocr/health' && method === 'GET') ||
      (path === '/local-ocr' && method === 'POST'), 'Only exact local OCR routes are allowed');
    let contentType;
    let encoded;
    if (method === 'POST') {
      const bytes = Buffer.from(payload.base64 ?? '', 'base64');
      assert(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, 'Rendered OCR image must have actual bytes');
      assert.equal(bytes.length, payload.declaredSize, 'Browser File size differs from transferred bytes');
      assert.equal(bytes.toString('base64'), payload.base64, 'Browser OCR byte transfer is not canonical');
      assert.match(payload.mimeType, /^image\/(?:png|jpeg)$/i);
      const form = new FormData();
      form.append('file', new File([bytes], payload.filename, { type: payload.mimeType }), payload.filename);
      const request = new Request(backend + path, { method: 'POST', body: form });
      contentType = request.headers.get('content-type');
      encoded = Buffer.from(await request.arrayBuffer());
    }
    let response;
    const route = {
      request: () => ({ url: () => backend + path, method: () => method,
        headers: () => ({ 'content-type': contentType }), postDataBuffer: () => encoded }),
      fulfill: async options => { response = options; }
    };
    await handleLocalOcr(route);
    assert(response && Number.isInteger(response.status), 'Local OCR test stub did not return a response');
    return { status: response.status, contentType: response.contentType ?? 'application/json',
      body: response.body };
  }
  // Whitelisted child environment: no inherited OCR/API secrets or customer paths.
  const env = Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','USERPROFILE','HOME','APPDATA','LOCALAPPDATA'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { BROKERDESK_LOCAL_API_PORT: '47841', BROKERDESK_LOCAL_FRONTEND_ORIGIN: frontend, NEXT_PUBLIC_BROKERDESK_LOCAL_API_URL: backend, BROKERDESK_FAST_LOCAL: 'true', OCRSPACE_API_KEY: 'synthetic-test-token-not-a-real-key', OCRSPACE_API_URL: 'http://127.0.0.1:47842/parse/image', OCRSPACE_MAX_FILE_BYTES: '1048576', OCRSPACE_MAX_PDF_PAGES: '3', OCRSPACE_TIMEOUT_MS: '5000', NEXT_TELEMETRY_DISABLED: '1' });
  function launch(name, args, extra = {}) {
    logs[name] = ''; const child = spawn(process.execPath, args, { cwd: root, env: { ...env, ...extra }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    processes.push(child); child.stdout.on('data', b => { logs[name] += b; }); child.stderr.on('data', b => { logs[name] += b; }); child.on('error', e => { logs[name] += e.message; }); return child;
  }
  async function waitReady(url, child) {
    await poll(async () => { if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`); try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, url, 60000);
  }
  async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((ok, fail) => { const timer = setTimeout(() => fail(new Error('Test child did not stop')), 8000); child.once('exit', () => { clearTimeout(timer); ok(); }); child.kill(); });
  }
  async function startBackend() {
    apiProcess = launch(`backend-${processes.length}`, ['--import', providerGuardImportSpecifier, 'local-server/server.mjs'], { BROKERDESK_DATA_DIR: data });
    await waitReady(backend + '/health', apiProcess); return apiProcess.pid;
  }
  return {
    run, artifacts, calls, cloudCalls, handleLocalOcr, handleLocalOcrBrowser, get data() { return data; },
    failProviderOnce() { failNext = true; },
    async start() { const front = launch('frontend', ['scripts/run-framework.mjs','dev','--port','5183','--hostname','127.0.0.1']); await waitReady(frontend, front); },
    async reset(name) { await stop(apiProcess); data = resolve(run, `data-${name}`); await startBackend(); assert.deepEqual(await api('/cases'), []); },
    async restart() { const old = apiProcess.pid; await stop(apiProcess); const next = await startBackend(); assert.notEqual(next, old); return { oldPid: old, newPid: next, osRestart: false }; },
    async close() { for (const p of processes) await stop(p); stub.closeAllConnections(); await new Promise(r => stub.close(r)); for (const [name, text] of Object.entries(logs)) await writeFile(resolve(artifacts, `${name}.log`), text); }
  };
}

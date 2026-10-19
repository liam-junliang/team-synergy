import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, preview } from 'vite';

let root;
let upstream;
let dev;
let devHttp;
let built;
const origins = [];
const html = '<!doctype html><html><body><main id="routing-fixture">Workspace shell</main></body></html>';
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = (server) => `http://127.0.0.1:${server.address().port}`;
const close = (server) => server?.listening ? new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) : Promise.resolve();

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'acp-web-routing-'));
  await writeFile(join(root, 'index.html'), html);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), html);
  upstream = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(request.url === '/auth/whoami' ? 401 : request.url === '/not-found' ? 404 : 200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, method: request.method, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() }));
  });
  await listen(upstream);
  const config = {
    root,
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { proxy: { '^/api(?:/|$)': { target: origin(upstream) } } },
  };
  dev = await createServer({ ...config, server: { ...config.server, middlewareMode: true, hmr: false } });
  devHttp = createHttpServer(dev.middlewares);
  await listen(devHttp);
  origins.push(['development', origin(devHttp)]);
  built = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, open: false } });
  origins.push(['preview', origin(built.httpServer)]);
});

after(async () => {
  await close(devHttp);
  await dev?.close();
  await close(built?.httpServer);
  await close(upstream);
  if (root) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('acp-web-routing-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('development and built preview serve the SPA for direct workspace paths and queries', async () => {
  for (const [mode, base] of origins) {
    for (const path of ['/teams', '/account', '/projects/PROJECT-A/overview', '/projects/PROJECT-A/documents?folder=FOLDER-A&document=DOC-A', '/projects/PROJECT-A/requirements?tab=documents&document=REQ-A']) {
      const response = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
      assert.equal(response.status, 200, `${mode}: ${path}`);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(await response.text(), /id="routing-fixture"/);
    }
  }
});

test('API prefix is stripped once while encoded paths, queries, headers and request bodies reach core-api', async () => {
  for (const [mode, base] of origins) {
    const response = await fetch(`${base}/api/projects/PROJECT%20A/documents?folder=FOLDER%2FA`, {
      method: 'POST', headers: { Authorization: 'Bearer test-fixture', 'Content-Type': 'application/json' }, body: '{"title":"规范"}',
    });
    assert.equal(response.status, 200, mode);
    assert.deepEqual(await response.json(), { path: '/projects/PROJECT%20A/documents?folder=FOLDER%2FA', method: 'POST', authorization: 'Bearer test-fixture', body: '{"title":"规范"}' });
    for (const path of ['/handovers/HANDOVER-A', '/context-snapshots/SNAPSHOT-A/diff', '/design-prototypes/DESIGN-A/file?revision=2', '/features/FEATURE-A', '/modules/MODULE-A', '/requirements/REQ-A', '/requirement-topic-entries/ENTRY-A']) {
      assert.equal((await (await fetch(`${base}/api${path}`)).json()).path, path);
    }
  }
});

test('API authentication and missing-resource errors keep their status and JSON instead of falling back to HTML', async () => {
  for (const [mode, base] of origins) {
    const response = await fetch(`${base}/api/auth/whoami`);
    assert.equal(response.status, 401, mode);
    assert.equal((await response.json()).path, '/auth/whoami');
    const missing = await fetch(`${base}/api/not-found`);
    assert.equal(missing.status, 404, mode);
    assert.equal((await missing.json()).path, '/not-found');
  }
});

// Explicit local-only native host smoke: no database, engine or model service.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { withNativeOpenCodeCapture } from './native-memory-opencode-capture.mjs';
import { writeAuthConfig } from '../../cli/dist/auth-store.js';
import { bindProject } from '../../cli/dist/project-binding.js';
import { memoryContext } from '../../cli/dist/memory.js';
import { inspectNativeCapture } from '../../cli/dist/memory-native-capture.js';

export async function localNativeOpenCodeCapture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'tsp-native-opencode-local-'));
  const originalDirectory = process.cwd(), previous = Object.fromEntries(['AGENTCTL_HOME', 'TSP_EVAL_GATEWAY_URL', 'TSP_EVAL_GATEWAY_TOKEN', 'TSP_EVAL_MODEL', 'TSP_EVAL_FAMILY'].map(key => [key, process.env[key]]));
  const home = path.join(directory, 'member'), cwd = path.join(directory, 'project'), auditFile = path.join(directory, 'capture.jsonl');
  const events = new Map(); let requests = 0, modelRequests = 0;
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/v1/')) { modelRequests++; res.writeHead(503).end('{}'); return; }
    assert.equal(req.headers.authorization, 'Bearer local-native-capture-test-token');
    assert.equal(req.method, 'POST'); assert.match(req.url, /\/memory\/capture-events$/u);
    const parts = []; for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString('utf8')); requests++;
    const previous = events.get(body.eventId); if (previous) assert.deepEqual(body, previous); else events.set(body.eventId, body);
    res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data: { captureCode: '10000000000000000003', status: 'pending' } }));
  });
  try {
    await mkdir(home); await mkdir(cwd);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    Object.assign(process.env, { AGENTCTL_HOME: home, TSP_EVAL_GATEWAY_URL: base + '/v1', TSP_EVAL_GATEWAY_TOKEN: 'local-provider-unused',
      TSP_EVAL_MODEL: 'workbuddy/deepseek-v4.1-flash', TSP_EVAL_FAMILY: 'deepseek-v4.1-flash' });
    writeAuthConfig({ api_url: base, user_code: '10000000000000000002', device_name: 'native-local-probe', device_token: 'local-native-capture-test-token' });
    bindProject(cwd, '10000000000000000001', base); process.chdir(cwd);
    const owner = memoryContext().owner, sourceText = '我偏好先说明验证结果。';
    const result = await withNativeOpenCodeCapture({ member: { home, cwd }, dir: directory, memorySession: 'native-local-probe', owner,
      system: 'This local probe never invokes a model.', auditFile }, async host => {
      const scope = { harness: 'opencode', hostSessionId: host.sessionId, memorySession: 'native-local-probe', owner };
      const turn = await host.record(sourceText);
      const before = await inspectNativeCapture(scope);
      assert.equal(before.events.length, 1); assert.equal(before.events[0].state, 'staged');
      await host.restart();
      const deadline = Date.now() + 30000; let after;
      while (Date.now() < deadline) {
        after = await inspectNativeCapture(scope);
        if (after.events[0]?.state === 'accepted') break;
        await delay(200);
      }
      assert.equal(after.events[0]?.state, 'accepted');
      assert.equal(events.size, 1); assert.equal([...events.values()][0].sourceText, sourceText);
      assert.equal([...events.values()][0].eventId, after.events[0].eventId);
      assert.equal(after.events[0].nativeMessageId, turn.nativeMessageId);
      return { hostVersion: host.version, nativeStoreVerified: true, restartRecovered: true, acceptedEvents: events.size,
        nativeMessageId: turn.nativeMessageId, trace: host.trace };
    });
    const audit = await readFile(auditFile, 'utf8');
    assert.match(audit, /native-source-verified/u); assert.doesNotMatch(audit, /我偏好|local-native-capture-test-token/u);
    assert.equal(modelRequests, 0);
    return { ...result, platformDoubleRequests: requests, modelRequests, databaseConnections: 0, engineRequests: 0, controllerTranscriptsForwarded: 0 };
  } finally {
    process.chdir(originalDirectory);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await new Promise(resolve => server.close(resolve));
    const target = await realpath(directory);
    assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.match(path.basename(target), /^tsp-native-opencode-local-[a-zA-Z0-9]+$/u);
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!process.argv.includes('--run')) console.log(JSON.stringify({ explicitRunRequired: true, models: 0, databaseConnections: 0 }));
  else localNativeOpenCodeCapture().then(result => console.log(JSON.stringify({ accepted: true, ...result }))).catch(error => {
    console.log(JSON.stringify({ accepted: false, code: error.causeCode ?? error.code ?? error.name, phase: error.phase, trace: error.trace })); process.exitCode = 1;
  });
}

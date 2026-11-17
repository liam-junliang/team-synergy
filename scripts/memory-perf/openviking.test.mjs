import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenVikingClient, describeReadback, numericTelemetry, openVikingFixtureIds, runOpenVikingBenchmark, splitStoredMemory } from './openviking.mjs';
import { createHash } from 'node:crypto';

test('fixture identities are bounded, deterministic, and reject unsafe identifiers', () => {
  const a = openVikingFixtureIds('baseline-test-001');
  assert.deepEqual(a, openVikingFixtureIds('baseline-test-001'));
  assert.notEqual(a.account, openVikingFixtureIds('baseline-test-002').account);
  assert.match(a.account, /^memory-perf-[a-f0-9]{20}$/u);
  for (const invalid of ['../outside', 'short', 'a'.repeat(97), 'a b c d']) assert.throws(() => openVikingFixtureIds(invalid));
});

test('numeric telemetry retains measured queue/search/token fields without text or secrets', () => {
  const result = numericTelemetry({ summary: { duration_ms: 5, search: { embed_query: { duration_ms: 2 } },
    tokens: { embedding: { total: 8 } }, queue: { embedding: { execute: { duration_ms: 3 } } },
    errors: { message: 'private body' }, api_key: 'private', query: 'private query' } });
  assert.equal(result['summary.search.embed_query.duration_ms'], 2);
  assert.equal(result['summary.tokens.embedding.total'], 8);
  assert.equal(result['summary.queue.embedding.execute.duration_ms'], 3);
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(result['summary.missing_metric'], undefined);
});

test('readback diagnostics distinguish normalization and another owned namespace without retaining content', () => {
  const sha = text => createHash('sha256').update(text).digest('hex');
  const original = '{"case":1,"marker":"test-1","runId":"test-run"}';
  const file = { sha256: sha(original), bytes: Buffer.byteLength(original), fixtureCase: 1, fixtureMarker: 'test-1', fixtureRunId: 'test-run',
    uri: 'viking://user/member-0/memories/anchor.json', user: { account: 'a' } };
  const formatted = '{ "runId": "test-run", "case": 1, "marker": "test-1" }';
  const normalized = describeReadback(file, formatted, [file]);
  assert.notEqual(normalized.expectedHash, normalized.actualHash); assert.equal(normalized.syntheticCaseMatches, true);
  assert.equal(normalized.syntheticMarkerMatches, true); assert.equal(normalized.syntheticRunMatches, true);
  const foreign = { ...file, sha256: sha('foreign fixture'), user: { account: 'b' } };
  const crossed = describeReadback(file, 'foreign fixture', [file, foreign]);
  assert.equal(crossed.matchesAnotherOwnedFile, true); assert.equal(crossed.matchingFileAccountRelation, 'different');
  assert.equal(crossed.matchingFileUriRelation, 'same');
  assert.ok(!JSON.stringify(crossed).includes('foreign fixture'));
  assert.equal(describeReadback(file, { content: 'private' }, [file]).dataType, 'object');
});

test('memory storage metadata is separated from an unchanged body without accepting malformed wrappers', () => {
  const body = '{"synthetic":true,"case":1}';
  const trailer = '\n\n<!-- MEMORY_FIELDS\n{\n  "version": 1\n}\n-->';
  assert.equal(Buffer.byteLength(trailer), 43);
  assert.deepEqual(splitStoredMemory(body + trailer), { body, metadataVersion: 1, metadataKeys: ['version'] });
  assert.equal(splitStoredMemory(body + '\n\n<!-- MEMORY_FIELDS\n{}\n-->').body, body + '\n\n<!-- MEMORY_FIELDS\n{}\n-->');
  assert.equal(splitStoredMemory(body + '\n\n<!-- MEMORY_FIELDS\nnot-json\n-->').metadataVersion, null);
});

test('HTTP client accepts only loopback and strips error bodies from exceptions', async () => {
  assert.throws(() => createOpenVikingClient({ baseUrl: 'https://external.example' }));
  assert.throws(() => createOpenVikingClient({ baseUrl: 'http://user:password@127.0.0.1:9000' }));
  const client = createOpenVikingClient({ baseUrl: 'http://127.0.0.1:9000',
    fetchImpl: async () => new Response('private-key-and-body', { status: 503 }) });
  await assert.rejects(client('/health'), error => error.status === 503 && error.safeCode === 'http_503' && !error.message.includes('private'));
  const missing = await client('/missing', { allow: [503] });
  assert.deepEqual(missing, { status: 503, data: null, telemetry: null });
});

test('real benchmark orchestration can run against a contract double, validating isolation, raw samples and exact cleanup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tsp-ov-perf-unit-'));
  try {
    const deploymentFile = path.join(dir, 'profile.private.json');
    await writeFile(deploymentFile, JSON.stringify({ baseUrl: 'http://127.0.0.1:9000', rootKey: 'unit-root-secret', version: 'test' }));
    const accounts = new Set(), keys = new Map(), files = new Map(), directories = new Set(), completed = new Set();
    let hangIndexTasks = false, corruptFinalReadback = false, indexBootstrapStarted = false;
    const response = (result, status = 200) => new Response(JSON.stringify({ status: 'ok', result }), { status, headers: { 'content-type': 'application/json' } });
    const missing = (status = 404) => new Response(JSON.stringify({ status: 'error', message: 'not public' }), { status });
    const fakeFetch = async (raw, init) => {
      const url = new URL(raw), route = url.pathname, body = init.body ? JSON.parse(init.body) : null;
      const key = init.headers['x-api-key'], member = keys.get(key);
      const accountRoute = /^\/api\/v1\/admin\/accounts\/([^/]+)$/u.exec(route);
      if (route === '/api/v1/admin/accounts' && init.method === 'POST') {
        assert.equal(key, 'unit-root-secret'); assert.ok(!accounts.has(body.account_id)); accounts.add(body.account_id);
        return response({ account_id: body.account_id, admin_user_id: body.admin_user_id, user_key: 'unused-admin-key' });
      }
      if (accountRoute) {
        assert.equal(key, 'unit-root-secret'); const account = accountRoute[1];
        if (init.method === 'DELETE') { assert.ok(accounts.delete(account)); completed.add('delete-' + account);
          for (const fileKey of files.keys()) if (fileKey.startsWith(account + '|')) files.delete(fileKey);
          return response({ account_id: account, task_id: 'delete-' + account, status: 'deleting' }, 202); }
        return accounts.has(account) ? response({ account_id: account }) : missing();
      }
      const userRoute = /^\/api\/v1\/admin\/accounts\/([^/]+)\/users$/u.exec(route);
      if (userRoute) { assert.ok(accounts.has(userRoute[1])); const userKey = 'unit-user-secret-' + keys.size;
        keys.set(userKey, { account: userRoute[1], id: body.user_id });
        return response({ account_id: userRoute[1], user_id: body.user_id, user_key: userKey }); }
      if (route === '/api/v1/observer/queue') return response({ summary: { pending: 0, in_progress: 0, processed: 10, errors: 0 } });
      if (route.startsWith('/api/v1/tasks/')) { const id = decodeURIComponent(route.slice('/api/v1/tasks/'.length));
        assert.ok(completed.has(id)); return response({ task_id: id, status: hangIndexTasks && id.startsWith('write-') ? 'running' : 'completed' }); }
      assert.ok(member, 'Data APIs must use a member-bound key');
      const uri = url.searchParams.get('uri') ?? body?.uri ?? body?.root_uri;
      if (uri && /^viking:\/\/user\/([^/]+)/u.exec(uri)?.[1] !== member.id) return missing(403);
      const fileKey = member.account + '|' + uri;
      if (route === '/api/v1/fs/stat') return directories.has(fileKey) ? response({ isDir: true }) : missing();
      if (route === '/api/v1/fs/mkdir') { directories.add(fileKey); return response({ uri }); }
      if (route === '/api/v1/content/read') {
        if (corruptFinalReadback && indexBootstrapStarted && uri.endsWith('/anchor.json')) return response('corrupted synthetic fixture');
        return files.has(fileKey) ? response(files.get(fileKey)) : missing();
      }
      const storedMemory = content => content + '\n\n<!-- MEMORY_FIELDS\n{\n  "version": 1\n}\n-->';
      if (route === '/api/v1/content/write') { assert.ok(!files.has(fileKey)); files.set(fileKey, storedMemory(body.content));
        if (uri.endsWith('/semantic-anchor.json')) indexBootstrapStarted = true;
        const task_id = 'write-' + files.size; completed.add(task_id); return response({ uri, task_id }); }
      if (route === '/api/v1/content/batch-write') { assert.equal(body.defer_processing, true);
        for (const op of body.operations) { const target = member.account + '|' + op.uri; assert.ok(!files.has(target)); files.set(target, storedMemory(op.content)); }
        return response({ semantic_status: 'deferred', vector_status: 'deferred' }); }
      if (route === '/api/v1/search/find') {
        const anchor = body.target_uri.endsWith('.json') ? body.target_uri : body.target_uri + '/semantic-anchor.json';
        return response({ memories: files.has(member.account + '|' + anchor) ? [{ uri: anchor }] : [] });
      }
      throw Error('Unhandled fake route');
    };
    const events = [];
    const result = await runOpenVikingBenchmark({ runId: 'unit-openviking-baseline', concurrency: [1, 2], samples: 2, rounds: 1,
      outputDir: dir, deploymentFile, fetchImpl: fakeFetch, phaseHook: event => events.push(event), visibilityTimeoutMs: 50 });
    assert.equal(result.accepted, true, JSON.stringify(result.failure));
    assert.equal(result.contentBaselineAccepted, true);
    assert.equal(result.semanticBaselineAccepted, true);
    assert.equal(result.configuration.members, 2);
    assert.equal(result.phases.length, 18);
    assert.equal(result.requests.length, 36);
    assert.equal(events.length, 36);
    assert.ok(result.requests.every(row => row.phase && row.engine === 'openviking' && row.concurrency && row.round === 0));
    assert.ok(result.phases.filter(row => row.phase.startsWith('semantic_find_')).every(row => row.queryModes.repeated.n === 1 && row.queryModes.variant.n === 1));
    assert.equal(result.checks.crossAccountSameUriIsolated, true);
    assert.equal(result.checks.crossMemberReadDenied, true);
    assert.equal(result.cleanup.accountRegistryGone, true);
    assert.equal(result.cleanup.deletionTasksCompleted, true);
    assert.equal(result.cleanup.ownedFilesReadbackVerified, true);
    assert.equal(result.cleanup.finalReadback.verified, result.cleanup.finalReadback.known);
    assert.equal(result.cleanup.finalReadback.failed, 0);
    assert.equal(result.checks.contentBaselineCompleted, true);
    assert.equal(result.bootstrapTasks.length, 2);
    assert.equal(accounts.size, 0); assert.equal(files.size, 0);
    const written = await readFile(path.join(dir, 'openviking.json'), 'utf8');
    assert.ok(!written.includes('unit-root-secret') && !written.includes('unit-user-secret'));
    assert.ok(!written.includes('订单支付接收到重复'));
    hangIndexTasks = true;
    const blocked = await runOpenVikingBenchmark({ runId: 'unit-openviking-blocked', concurrency: [1, 2], samples: 2, rounds: 1,
      outputDir: path.join(dir, 'blocked'), deploymentFile, fetchImpl: fakeFetch, indexBootstrapTimeoutMs: 1 });
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.contentBaselineAccepted, true);
    assert.equal(blocked.semanticBaselineAccepted, false);
    assert.equal(blocked.failure.code, 'index_bootstrap_blocked');
    assert.equal(blocked.checks.contentBaselineCompleted, true);
    assert.equal(blocked.phases.length, 8);
    assert.equal(blocked.requests.length, 16);
    assert.ok(blocked.taskSnapshots.some(row => row.reason === 'before_cleanup' && row.status === 'running'));
    assert.equal(blocked.cleanup.accountRegistryGone, true);
    assert.equal(blocked.cleanup.ownedFilesReadbackVerified, true);
    assert.equal(blocked.cleanup.finalReadback.attempted, blocked.cleanup.finalReadback.known);
    assert.equal(blocked.cleanup.finalReadback.verified, blocked.cleanup.finalReadback.known);
    corruptFinalReadback = true; indexBootstrapStarted = false;
    const corrupted = await runOpenVikingBenchmark({ runId: 'unit-openviking-corrupt-final', concurrency: [1, 2], samples: 2, rounds: 1,
      outputDir: path.join(dir, 'corrupt-final'), deploymentFile, fetchImpl: fakeFetch, indexBootstrapTimeoutMs: 1 });
    assert.equal(corrupted.checks.contentBaselineCompleted, true);
    assert.equal(corrupted.accepted, false);
    assert.equal(corrupted.contentBaselineAccepted, false);
    assert.equal(corrupted.semanticBaselineAccepted, false);
    assert.equal(corrupted.failure.code, 'index_bootstrap_blocked');
    assert.equal(corrupted.cleanup.ownedFilesReadbackVerified, false);
    assert.ok(corrupted.cleanup.finalReadback.failed > 0);
    assert.equal(corrupted.cleanup.finalReadback.attempted, corrupted.cleanup.finalReadback.known);
    assert.equal(corrupted.cleanup.finalReadback.failureCodes.readback_mismatch, corrupted.cleanup.finalReadback.failed);
    assert.equal(corrupted.cleanup.accountRegistryGone, true);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.join(os.tmpdir(), 'tsp-ov-perf-unit-')));
    await rm(dir, { recursive: true, force: true });
  }
});

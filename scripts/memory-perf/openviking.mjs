// Opt-in real OpenViking API workload. Importing this module never calls a service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const roundMs = value => Math.round(value * 1000) / 1000;
const canonicalJson = value => JSON.stringify(value, (_key, child) => child && typeof child === 'object' && !Array.isArray(child) ?
  Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);

export function openVikingFixtureIds(runId) {
  assert.match(runId, /^[a-zA-Z0-9_-]{6,96}$/, 'Use a bounded synthetic run identifier');
  const suffix = hash(runId).slice(0, 20);
  return { account: 'memory-perf-' + suffix, foreignAccount: 'memory-perf-' + suffix + '-foreign',
    directory: 'baseline-' + suffix, tag: 'benchmark=' + suffix };
}

/** Preserve numeric timing/counter evidence, never messages, content or credentials. */
export function numericTelemetry(value, prefix = '', result = {}, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return result;
  if (typeof value === 'number' && Number.isFinite(value)) result[prefix] = value;
  else if (typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:key|api_key|root_key|token_value|password|secret|credential|message|content|query|uri)$/iu.test(key)) continue;
      numericTelemetry(child, prefix ? prefix + '.' + key : key, result, depth + 1);
    }
  }
  return result;
}

function apiFailure(code, status = 0) {
  const error = new Error('OpenViking benchmark request failed');
  error.code = code; error.safeCode = code; error.status = status;
  return error;
}

export function createOpenVikingClient({ baseUrl, fetchImpl = fetch, timeoutMs = 120000 }) {
  const target = new URL(baseUrl);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.protocol === 'http:' &&
    !target.username && !target.password && !target.search && !target.hash, 'Only local engine endpoints are allowed');
  const base = target.href.replace(/\/$/u, '');
  return async (route, { key, body, method = body === undefined ? 'GET' : 'POST', allow = [] } = {}) => {
    assert.ok(route.startsWith('/') && !route.startsWith('//'), 'Use a local API route');
    const response = await fetchImpl(base + route, { method, headers: { ...(key ? { 'x-api-key': key } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (allow.includes(response.status)) {
      await response.arrayBuffer();
      return { status: response.status, data: null, telemetry: null };
    }
    if (!response.ok) { await response.arrayBuffer(); throw apiFailure('http_' + response.status, response.status); }
    let envelope;
    try { envelope = await response.json(); } catch { throw apiFailure('invalid_json', response.status); }
    if (envelope?.status !== 'ok') throw apiFailure('invalid_envelope', response.status);
    return { status: response.status, data: envelope.result, telemetry: envelope.telemetry ?? null };
  };
}

function memoryText(runId, index, anchor = false) {
  return JSON.stringify({ schema: 'memory-performance-baseline/v1', synthetic: true, runId, case: index,
    state: '方案已确认，尚未实施', text: anchor ?
      '订单支付接收到重复的网关回调时，按业务订单号和支付流水号执行唯一约束；持久化成功之后才发送一次履约事件。验收覆盖重复通知、并发支付和下游消费幂等。' :
      '软件发布前验证登录权限、接口版本和回滚流程。排查任务失败时关联请求链路标识与下游日志；个人习惯是先补回归验证，再说明改动影响。该资料仅用于本轮性能测试。',
    marker: '基准案例-' + index });
}

export { memoryText as syntheticOpenVikingMemoryText };

function results(response) {
  return [...(response.data?.memories ?? []), ...(response.data?.resources ?? []), ...(response.data?.skills ?? [])];
}

/** Public memory writes append server-owned fields; retain body bytes exactly. */
export function splitStoredMemory(raw) {
  if (typeof raw !== 'string') return { body: null, metadataVersion: null, metadataKeys: [] };
  const match = /\n\n<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->$/u.exec(raw);
  if (!match) return { body: raw, metadataVersion: null, metadataKeys: [] };
  try {
    const fields = JSON.parse(match[1]);
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Number.isSafeInteger(fields.version) || fields.version < 1) {
      return { body: raw, metadataVersion: null, metadataKeys: [] };
    }
    return { body: raw.slice(0, match.index), metadataVersion: fields.version, metadataKeys: Object.keys(fields).sort() };
  } catch { return { body: raw, metadataVersion: null, metadataKeys: [] }; }
}

export function describeReadback(expected, actual, ownedFiles = []) {
  const actualHash = typeof actual === 'string' ? hash(actual) : null;
  const stored = splitStoredMemory(actual);
  let parsed = null;
  try { if (stored.body !== null) parsed = JSON.parse(stored.body); } catch { /* no content is retained */ }
  const matched = actualHash ? ownedFiles.find(file => file.sha256 === actualHash && file !== expected) : null;
  return { expectedHash: expected.sha256, actualHash, dataType: actual === null ? 'null' : typeof actual,
    actualBodyHash: stored.body !== null ? hash(stored.body) : null,
    metadataVersion: stored.metadataVersion, metadataKeys: stored.metadataKeys,
    expectedBytes: expected.bytes, actualBytes: typeof actual === 'string' ? Buffer.byteLength(actual) : null,
    trailingNewlineOnly: typeof actual === 'string' && hash(actual.replace(/\r?\n$/u, '')) === expected.sha256,
    jsonParseable: parsed !== null, syntheticCaseMatches: parsed ? parsed.case === expected.fixtureCase : null,
    syntheticMarkerMatches: parsed ? parsed.marker === expected.fixtureMarker : null,
    syntheticRunMatches: parsed ? parsed.runId === expected.fixtureRunId : null,
    jsonEquivalent: parsed && expected.canonicalHash ? hash(canonicalJson(parsed)) === expected.canonicalHash : null,
    matchesAnotherOwnedFile: Boolean(matched),
    matchingFileAccountRelation: matched ? matched.user.account === expected.user.account ? 'same' : 'different' : null,
    matchingFileUriRelation: matched ? matched.uri === expected.uri ? 'same' : 'different' : null };
}

export async function runOpenVikingBenchmark({ runId, concurrency = [1, 4, 16], samples = 48, rounds = 2,
  outputDir, phaseHook, deploymentFile = process.env.TSP_OV_DEPLOYMENT_FILE,
  timeoutMs = 120000, visibilityTimeoutMs = 60000, indexBootstrapTimeoutMs = 15000, readbackTimeoutMs = 3000,
  fullSemanticProbes = 0, fetchImpl = fetch } = {}) {
  const ids = openVikingFixtureIds(runId);
  assert.ok(Array.isArray(concurrency) && concurrency.length && concurrency.every(n => Number.isInteger(n) && n > 0 && n <= 16));
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 256 && Number.isInteger(rounds) && rounds > 0 && rounds <= 4);
  assert.ok(Number.isInteger(fullSemanticProbes) && fullSemanticProbes >= 0 && fullSemanticProbes <= 4, 'Keep full semantic processing probes bounded');
  assert.ok(outputDir && path.isAbsolute(outputDir), 'Use an absolute report directory');
  const { measurePhase, latencyStats } = await import('./common.mjs');
  const runtime = process.env.TSP_PILOT_RUNTIME ?? 'F:/workspace/team-knowledge-runtime';
  const deployment = JSON.parse((await readFile(deploymentFile ?? path.join(runtime, 'openviking/deployment.json'), 'utf8')).replace(/^\uFEFF/u, ''));
  assert.ok(deployment.rootKey && deployment.baseUrl, 'Missing private engine profile');
  const request = createOpenVikingClient({ baseUrl: deployment.baseUrl, timeoutMs, fetchImpl });
  const report = { schema: 'memory-performance-openviking/v1', runId, engine: 'openviking', startedAt: new Date().toISOString(),
    accepted: false, contentBaselineAccepted: false, semanticBaselineAccepted: false,
    loadModel: 'closed-loop; warmups excluded; no hidden request retries',
    limitations: ['The synthetic indexed corpus grows between phases. Reversing concurrency order in the second round only partially controls this; concurrency differences are not pure causal estimates.',
      'Manual-memory processing includes schema overview refresh and embedding/task completion; processing_mode does not isolate a database-only or embedding-only implementation in that branch.',
      'Only numeric telemetry emitted by the server is retained; absent counters are not imputed. Server summaries may themselves contain default zero values.',
      'Search correctness checks use a tagged known anchor per user and are not a large-corpus recall benchmark.'],
    memoryStorageContract: 'Exact submitted body bytes must survive. The public API appends a server-owned MEMORY_FIELDS/version trailer; raw stored hashes are recorded separately, not compared to the submitted transport hash.',
    configuration: { sourceCommit: deployment.sourceCommit, version: deployment.version, concurrency, samples, rounds,
      members: Math.max(...concurrency), namespaces: 2, endpoint: deployment.baseUrl, requestTimeoutMs: timeoutMs,
      indexBootstrapTimeoutMs,
      persistentBackendsUnmodified: true, agentModelRuns: 0 },
    phases: [], requests: [], telemetry: [], checks: {}, setupCheckpoints: [], bootstrapTasks: [], taskSnapshots: [],
    readbackDiagnostics: [], readbackVisibility: [], storedEnvelopeExamples: [],
    blocked: [], visibility: [], fullSemantic: [],
    corpus: { filesCreated: 0, indexedWritesAcknowledged: 0, totalContentBytes: 0 },
    cleanup: { ownedAccounts: [], removedAccounts: [], accountRegistryGone: false, ownedFilesReadbackVerified: false } };
  const users = [], createdAccounts = [], files = new Map(), ownedTasks = [];
  const reportPath = path.join(outputDir, 'openviking.json');
  const save = async () => { await mkdir(outputDir, { recursive: true }); const tmp = reportPath + '.tmp';
    await writeFile(tmp, JSON.stringify(report, null, 2)); await rename(tmp, reportPath); };
  const rootRequest = (route, options = {}) => request(route, { ...options, key: deployment.rootKey });
  let currentStep = 'initialization';
  const checkpoint = async (step, work) => {
    currentStep = step; const started = performance.now();
    report.stage = step; await save();
    try {
      const result = await work();
      report.setupCheckpoints.push({ step, state: 'completed', elapsedMs: roundMs(performance.now() - started),
        ...(Number.isInteger(result?.status) ? { status: result.status } : {}),
        ...(result?.data && typeof result.data === 'object' ? { resultFields: Object.keys(result.data).sort() } : {}) });
      await save(); return result;
    } catch (error) {
      report.setupCheckpoints.push({ step, state: 'failed', elapsedMs: roundMs(performance.now() - started),
        errorName: ['AbortError', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'Error',
        ...(typeof error?.safeCode === 'string' ? { code: error.safeCode } : {}),
        ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
      await save(); throw error;
    }
  };
  const rootFor = user => 'viking://user/' + user.id + '/memories/experiences/' + ids.directory;
  const anchorFor = user => rootFor(user) + '/semantic-anchor.json';
  const readAnchorFor = user => rootFor(user) + '/anchor.json';
  let serial = 0, activePhase = 'setup';
  const recordTelemetry = (operation, response) => {
    const numbers = numericTelemetry(response.telemetry?.summary ?? response.telemetry);
    if (Object.keys(numbers).length) report.telemetry.push({ operation, phase: activePhase, at: new Date().toISOString(), values: numbers });
  };
  const remember = (uri, user, content) => {
    assert.ok(!files.has(user.account + '|' + uri), 'Refusing to overwrite a benchmark file');
    const fixture = JSON.parse(content);
    files.set(user.account + '|' + uri, { uri, user, sha256: hash(content), bytes: Buffer.byteLength(content),
      acknowledgedAt: performance.now(), fixtureCase: fixture.case, fixtureMarker: fixture.marker, fixtureRunId: fixture.runId,
      canonicalHash: hash(canonicalJson(fixture)) });
    report.corpus.filesCreated++; report.corpus.totalContentBytes += Buffer.byteLength(content);
  };
  const readExact = async (file, readRequest = request) => {
    const response = await readRequest('/api/v1/content/read?' + new URLSearchParams({ uri: file.uri, raw: 'true' }), { key: file.user.key });
    const stored = splitStoredMemory(response.data);
    if (stored.body === null || hash(stored.body) !== file.sha256) {
      const diagnostic = describeReadback(file, response.data, [...files.values()]);
      if (report.readbackDiagnostics.length < 64) report.readbackDiagnostics.push({ ...diagnostic, phase: activePhase });
      throw apiFailure('readback_mismatch', response.status);
    }
    if (!file.storedRawHash && report.storedEnvelopeExamples.length < 16) report.storedEnvelopeExamples.push({
      submittedBodyHash: file.sha256, storedRawHash: hash(response.data), storedBodyHash: hash(stored.body),
      submittedBytes: file.bytes, storedBytes: Buffer.byteLength(response.data), metadataVersion: stored.metadataVersion,
      metadataKeys: stored.metadataKeys });
    file.storedRawHash = hash(response.data); file.metadataVersion = stored.metadataVersion;
    return { status: response.status, bytes: Buffer.byteLength(response.data), verified: true };
  };
  const awaitReadable = async file => {
    const began = performance.now(), deadline = began + readbackTimeoutMs; let attempts = 0;
    for (;;) {
      attempts++;
      try { const result = await readExact(file);
        report.readbackVisibility.push({ phase: activePhase, success: true, polls: attempts,
          afterAcknowledgementMs: roundMs(performance.now() - file.acknowledgedAt),
          verificationStartedAfterAckMs: roundMs(began - file.acknowledgedAt), readbackWaitMs: roundMs(performance.now() - began),
          deadlineMs: readbackTimeoutMs, timingMeaning: 'Observed upper bound; includes any delay before this unmeasured verification began.' });
        return result;
      } catch (error) {
        if (!['readback_mismatch', 'http_404'].includes(error.safeCode) || performance.now() >= deadline) {
          report.readbackVisibility.push({ phase: activePhase, success: false, polls: attempts,
            afterAcknowledgementMs: roundMs(performance.now() - file.acknowledgedAt), deadlineMs: readbackTimeoutMs });
          throw error;
        }
        await delay(100);
      }
    }
  };
  const verifyNewFiles = async startingSize => {
    const all = [...files.values()].slice(startingSize);
    for (const file of all) await awaitReadable(file);
    return all.length;
  };
  const write = async (user, kind, { deferred = false, wait = true, mode = 'vectors_only', telemetry = false, anchor = false } = {}) => {
    const index = serial++, uri = anchor ? (deferred ? readAnchorFor(user) : anchorFor(user)) : rootFor(user) + '/' + kind + '-' + index + '.json';
    const content = memoryText(runId, index, anchor);
    // All paths are unique beneath freshly allocated account/user roots.
    const response = deferred ? await request('/api/v1/content/batch-write', { key: user.key,
      body: { root_uri: rootFor(user), operations: [{ uri, content, mode: 'create' }], wait: false, defer_processing: true,
        ...(telemetry ? { telemetry: { summary: true } } : {}) } }) :
      await request('/api/v1/content/write', { key: user.key, body: { uri, content, mode: 'create', wait,
        processing_mode: mode, tags: [ids.tag, 'kind=' + (anchor ? 'anchor' : kind)],
        ...(telemetry ? { telemetry: { summary: true } } : {}) } });
    remember(uri, user, content);
    const file = files.get(user.account + '|' + uri);
    file.indexRequested = !deferred; file.waitRequested = wait; file.kind = kind;
    if (!deferred) report.corpus.indexedWritesAcknowledged++;
    if (response.data?.task_id) ownedTasks.push({ id: response.data.task_id, user, uri, kind });
    recordTelemetry('write.' + kind, response);
    return { response, file };
  };
  const find = async (user, { uri = rootFor(user), tag = 'kind=anchor', telemetry = false, querySuffix = '' } = {}) => {
    const response = await request('/api/v1/search/find', { key: user.key, body: {
      query: '支付网关重复通知到账时，怎样防止同一订单二次入账，并核验后续发货是否只执行一次？' + querySuffix,
      target_uri: uri, context_type: 'memory', tags: [ids.tag, tag], limit: 8, read_content: false,
      ...(telemetry ? { telemetry: { summary: true } } : {}) } });
    recordTelemetry('search.find', response);
    return response;
  };
  const snapshotTask = async (task, reason) => {
    const response = await request('/api/v1/tasks/' + encodeURIComponent(task.id) + '?include_events=true', { key: task.user.key });
    const data = response.data, errorText = typeof data.error === 'string' ? data.error : '';
    const errorCategories = ['embedding', 'semantic', 'lock', 'timeout', 'cancel', 'not found', 'permission',
      'overview', 'schema', 'vector', 'connection', 'queue', 'unsupported', 'encode', 'collection']
      .filter(value => errorText.toLowerCase().includes(value));
    const row = { taskId: task.id, reason, at: new Date().toISOString(), status: data.status,
      taskType: data.task_type, stage: /^[a-zA-Z0-9_.:-]{1,80}$/u.test(data.stage ?? '') ? data.stage : null,
      numeric: numericTelemetry({ result: data.result, meta: data.meta, processing_seconds: data.processing_seconds }),
      errorCategories, errorFingerprint: errorText ? hash(errorText) : null,
      executionEventCount: Array.isArray(data.execution_events?.items) ? data.execution_events.items.length : null,
      executionEvents: (data.execution_events?.items ?? []).map(event => ({
        kind: /^[a-zA-Z0-9_.:-]{1,80}$/u.test(event.kind ?? '') ? event.kind : null,
        status: /^[a-zA-Z0-9_.:-]{1,80}$/u.test(event.status ?? '') ? event.status : null,
        stage: /^[a-zA-Z0-9_.:-]{1,80}$/u.test(event.stage ?? '') ? event.stage : null,
        operation: /^[a-zA-Z0-9_.:-]{1,80}$/u.test(event.operation ?? '') ? event.operation : null,
      })) };
    report.taskSnapshots.push(row); return row;
  };
  const snapshotQueue = async reason => {
    try { const response = await rootRequest('/api/v1/observer/queue');
      report.taskSnapshots.push({ reason, at: new Date().toISOString(), sharedQueue: true, numeric: numericTelemetry(response.data) });
    } catch { report.taskSnapshots.push({ reason, sharedQueue: true, unavailable: true }); }
  };
  const phase = async (name, c, round, operation, count = samples, metadata = {}) => {
    activePhase = name;
    const before = { ...report.corpus }, startingSize = files.size;
    const phaseMetadata = { ...metadata, corpusBefore: before };
    const result = await measurePhase({ engine: 'openviking', name, concurrency: c, samples: count, round,
      warmup: 2, operation, metadata: phaseMetadata, phaseHook: async event => {
        if (event.state === 'start') phaseMetadata.corpusAtMeasuredStart = { ...report.corpus };
        await phaseHook?.(event);
      } });
    if (name.startsWith('semantic_find_')) {
      for (const row of result.samples) row.queryMode = row.sample % 2 ? 'variant' : 'repeated';
      result.summary.queryModes = Object.fromEntries(['repeated', 'variant'].map(queryMode => {
        const group = result.samples.filter(row => row.queryMode === queryMode);
        return [queryMode, { n: group.length, failed: group.filter(row => !row.ok).length,
          latencyMs: latencyStats(group.map(row => row.durationMs)) }];
      }));
    }
    report.phases.push(result.summary); report.requests.push(...result.samples.map(row => ({ ...row, engine: 'openviking', phase: name, concurrency: c, round })));
    result.summary.readbacksVerified = await verifyNewFiles(startingSize);
    const indexCandidates = [...files.values()].slice(startingSize).filter(file => file.indexRequested && file.waitRequested);
    const indexSamples = [...new Set([indexCandidates[0], indexCandidates.at(-1)].filter(Boolean))];
    for (const file of indexSamples) {
      const response = await find(file.user, { uri: file.uri, tag: 'kind=' + file.kind });
      if (!results(response).some(hit => hit.uri === file.uri)) throw apiFailure('acknowledged_index_not_visible', response.status);
    }
    result.summary.indexedWriteSamplesVerified = indexSamples.length;
    result.summary.corpusAfter = { ...report.corpus }; await save();
    if (result.summary.failed / Math.max(1, result.summary.total) > 0.2) throw apiFailure('phase_error_budget_exceeded');
  };
  try {
    // ROOT can manage identities but is never used for data operations.
    for (const account of [ids.account, ids.foreignAccount]) {
      const suffix = account === ids.account ? 'primary' : 'foreign';
      const absent = await checkpoint('account_absent_' + suffix, () => rootRequest('/api/v1/admin/accounts/' + account, { allow: [404] }));
      assert.equal(absent.status, 404, 'Refusing to reuse a pre-existing account');
      const made = await checkpoint('account_create_' + suffix, () => rootRequest('/api/v1/admin/accounts', { body: { account_id: account, admin_user_id: 'benchmark-admin' } }));
      assert.equal(made.data.account_id, account); createdAccounts.push(account);
      report.cleanup.ownedAccounts.push(account);
    }
    for (let i = 0; i < Math.max(...concurrency); i++) {
      const id = 'member-' + i;
      const made = await checkpoint('member_create_' + i, () => rootRequest('/api/v1/admin/accounts/' + ids.account + '/users', { body: { user_id: id, role: 'user' } }));
      if (!made.data.user_key) throw apiFailure('member_key_missing');
      if (made.data.user_id !== id || made.data.account_id !== ids.account) throw apiFailure('member_response_identity_mismatch');
      users.push({ id, account: ids.account, key: made.data.user_key });
    }
    const foreignMade = await checkpoint('foreign_member_create', () => rootRequest('/api/v1/admin/accounts/' + ids.foreignAccount + '/users', { body: { user_id: users[0].id, role: 'user' } }));
    if (!foreignMade.data.user_key || foreignMade.data.account_id !== ids.foreignAccount) throw apiFailure('foreign_member_response_mismatch');
    const foreign = { id: users[0].id, account: ids.foreignAccount, key: foreignMade.data.user_key };
    for (const user of [...users, foreign]) {
      const identity = user.account === ids.foreignAccount ? 'foreign' : user.id;
      const absent = await checkpoint('directory_absent_' + identity, () => request('/api/v1/fs/stat?' + new URLSearchParams({ uri: rootFor(user) }), { key: user.key, allow: [404] }));
      assert.equal(absent.status, 404, 'Refusing to reuse a benchmark directory');
      await checkpoint('directory_create_' + identity, () => request('/api/v1/fs/mkdir', { key: user.key, body: { uri: rootFor(user) } }));
      await checkpoint('anchor_deferred_write_' + identity, () => write(user, 'anchor', { anchor: true, deferred: true, telemetry: true }));
    }
    // Namespace isolation: identical user ID + URI in another account resolves
    // to that account's own body, never the first account's body.
    const own = files.get(users[0].account + '|' + readAnchorFor(users[0]));
    const other = files.get(foreign.account + '|' + readAnchorFor(foreign));
    assert.notEqual(own.sha256, other.sha256); await awaitReadable(own); await awaitReadable(other);
    report.checks.crossAccountSameUriIsolated = true;
    if (users.length > 1) {
      const denied = await request('/api/v1/content/read?' + new URLSearchParams({ uri: readAnchorFor(users[0]), raw: 'true' }),
        { key: users[1].key, allow: [403, 404] });
      assert.ok([403, 404].includes(denied.status)); report.checks.crossMemberReadDenied = true;
    }
    report.checks.initialBodiesHashVerified = (await verifyNewFiles(0)) === files.size;
    await save();
    // Content persistence/HTTP acknowledgement is measured before background
    // indexing is required. Deferred writes still enqueue a root Task; this is
    // not a direct database microbenchmark.
    for (let round = 0; round < rounds; round++) {
      const levels = round % 2 ? [...concurrency].reverse() : concurrency;
      for (const c of levels) {
        const member = index => users[index % users.length];
        for (const distributed of [false, true]) {
          const topology = distributed ? 'members' : 'hot_owner';
          const select = index => distributed ? member(index) : users[0];
          await phase('content_read_' + topology, c, round, async index => readExact(files.get(select(index).account + '|' + readAnchorFor(select(index)))));
          await phase('content_write_deferred_' + topology, c, round, async index => {
            const item = await write(select(index), 'deferred', { deferred: true, telemetry: index === 0 });
            return { status: item.response.status, bytes: item.file.bytes, verified: true };
          }, samples, { processing: 'content commit + root Task enqueue acknowledged; no semantic/vector indexing requested; background terminal state excluded' });
        }
      }
    }
    report.checks.contentBaselineCompleted = true; await save();
    activePhase = 'index_bootstrap';
    await snapshotQueue('before_index_bootstrap');
    for (const user of users) {
      const started = performance.now();
      const item = await checkpoint('anchor_async_index_write_' + user.id, () => write(user, 'anchor', { anchor: true, wait: false, mode: 'vectors_only', telemetry: true }));
      const taskId = item.response.data?.task_id;
      if (!taskId) throw apiFailure('index_task_identity_missing');
      const task = ownedTasks.find(row => row.id === taskId);
      const probe = { taskId, member: user.id, acknowledgementMs: roundMs(performance.now() - started),
        deadlineMs: indexBootstrapTimeoutMs, completed: false, censored: false, processingMode: 'vectors_only',
        note: 'The memory branch uses schema/embedding refresh regardless of processing_mode.' };
      report.bootstrapTasks.push(probe); await save();
      let state;
      while (performance.now() - started < indexBootstrapTimeoutMs) {
        state = await snapshotTask(task, 'index_bootstrap_poll');
        if (['completed', 'failed', 'cancelled'].includes(state.status)) break;
        await delay(500);
      }
      probe.completed = state?.status === 'completed'; probe.lastStatus = state?.status ?? null;
      probe.censored = !['completed', 'failed', 'cancelled'].includes(state?.status);
      probe.elapsedMs = roundMs(performance.now() - started);
      await readExact(item.file); await save();
      if (!probe.completed) {
        report.blocked.push({ phase: 'indexed_workloads', reason: 'index_bootstrap_task_not_completed',
          taskId, lastStatus: probe.lastStatus, censored: probe.censored });
        await snapshotQueue('index_bootstrap_blocked'); await save();
        throw apiFailure('index_bootstrap_blocked');
      }
      const response = await checkpoint('anchor_find_' + user.id, () => find(user, { telemetry: true }));
      if (!results(response).some(hit => hit.uri === anchorFor(user))) throw apiFailure('semantic_anchor_missing');
    }
    report.checks.nonliteralSemanticAnchorRetrieved = true;
    for (let round = 0; round < rounds; round++) {
      const levels = round % 2 ? [...concurrency].reverse() : concurrency;
      for (const c of levels) {
        const member = index => users[index % users.length];
        for (const distributed of [false, true]) {
          const topology = distributed ? 'members' : 'hot_owner';
          const select = index => distributed ? member(index) : users[0];
          await phase('memory_write_wait_vectors_' + topology, c, round, async index => {
            const item = await write(select(index), 'indexed', { telemetry: index === 0 });
            return { status: item.response.status, bytes: item.file.bytes, verified: true };
          }, samples, { processing: 'manual memory schema refresh + embedding/vector completion; not pure database latency' });
          await phase('semantic_find_' + topology, c, round, async index => {
            const user = select(index), response = await find(user, { telemetry: index === 0,
              querySuffix: index % 2 ? ' 测试请求编号' + round + '-' + index : '' });
            const hits = results(response); if (!hits.some(hit => hit.uri === anchorFor(user))) throw apiFailure('semantic_anchor_missing', response.status);
            if (hits.some(hit => !hit.uri.startsWith(rootFor(user) + '/'))) throw apiFailure('semantic_scope_leak', response.status);
            return { status: response.status, hits: hits.length, verified: true };
          }, samples, { queryEmbeddingIncluded: true, knownSourceChecks: true, filter: 'one tagged anchor per user',
            queryMix: 'alternating repeated question and unique suffix variant; per-mode latencies share the same concurrent load' });
        }
        await phase('mixed_members_80read_20indexedwrite', c, round, async index => {
          const user = member(index);
          if (index % 5) return readExact(files.get(user.account + '|' + readAnchorFor(user)));
          const item = await write(user, 'mixed', { telemetry: index === 0 });
          return { status: item.response.status, bytes: item.file.bytes, verified: true };
        }, samples, { operationMix: 'deterministic 80% exact content reads / 20% wait=true indexed writes (rounded per phase)' });
      }
    }
    // Acknowledgement and first search visibility are separate clocks. These
    // probes are excluded from throughput and use only fresh synthetic URIs.
    activePhase = 'index_visibility';
    for (const user of users.slice(0, Math.min(4, users.length))) {
      const started = performance.now(), item = await write(user, 'visibility', { wait: false, telemetry: true });
      const acknowledgedAt = performance.now(); let visibleAt = null, polls = 0;
      while (performance.now() - started < visibilityTimeoutMs) {
        polls++;
        const response = await find(user, { uri: item.file.uri, tag: 'kind=visibility', telemetry: polls === 1 });
        if (results(response).some(hit => hit.uri === item.file.uri)) { visibleAt = performance.now(); break; }
        await delay(250);
      }
      report.visibility.push({ acknowledgementMs: roundMs(acknowledgedAt - started),
        firstVisibleMs: visibleAt === null ? null : roundMs(visibleAt - started),
        afterAcknowledgementMs: visibleAt === null ? null : roundMs(visibleAt - acknowledgedAt), polls,
        censored: visibleAt === null, deadlineMs: visibilityTimeoutMs, pollIntervalMs: 250,
        timingMeaning: 'firstVisibleMs is an observed upper bound including polling and query-embedding latency' });
      await readExact(item.file); await save();
    }
    report.checks.allVisibilityProbesCompleted = report.visibility.every(row => !row.censored);
    // Optional full resource semantic processing has a separate, explicitly
    // tiny budget, because it may call the configured VLM/LLM.
    activePhase = 'resource_full_semantic';
    for (let i = 0; i < fullSemanticProbes; i++) {
      const uri = 'viking://resources/' + ids.directory + '/semantic-' + i + '.md';
      const start = performance.now();
      const response = await request('/api/v1/content/write', { key: users[0].key, body: { uri,
        content: '# 基准测试文档\n\n仅用于独立性能测试。发布前执行回归测试，并核验上游接口和下游幂等行为。方案已确认但尚未实施。',
        mode: 'create', wait: true, processing_mode: 'semantic_and_vectors', telemetry: { summary: true } } });
      recordTelemetry('resource.full_semantic', response);
      report.fullSemantic.push({ elapsedMs: roundMs(performance.now() - start), status: response.status });
    }
    report.accepted = report.phases.every(row => row.failed === 0 && !row.truncated && row.notStarted === 0 && row.warmup.failed === 0) && report.checks.allVisibilityProbesCompleted;
  } catch (error) {
    report.failure = { code: typeof error?.code === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/u.test(error.code) ? error.code : 'benchmark_validation_failed',
      step: currentStep, errorName: ['AbortError', 'TimeoutError', 'AssertionError', 'TypeError'].includes(error?.name) ? error.name : 'Error',
      status: Number.isInteger(error?.status) ? error.status : null };
  } finally {
    // Snapshot only this run's task identities before account deletion removes
    // their diagnostic facts. Never persist Task payloads or error messages.
    for (const task of ownedTasks.filter(row => row.kind === 'anchor' && row.uri === anchorFor(row.user))) {
      try { await snapshotTask(task, 'before_cleanup'); } catch { report.taskSnapshots.push({ taskId: task.id, reason: 'before_cleanup', unavailable: true }); }
    }
    // A blocked index task must not skip final persistence verification. Check
    // every known fixture body before its owning account is removed. A bounded
    // diagnostic budget avoids turning a degraded service into an unbounded
    // cleanup delay; unattempted files cannot count as verified.
    activePhase = 'final_readback';
    const finalReadRequest = createOpenVikingClient({ baseUrl: deployment.baseUrl, timeoutMs: Math.min(timeoutMs, 5000), fetchImpl });
    const finalReadback = { known: files.size, attempted: 0, verified: 0, failed: 0, notAttempted: 0,
      deadlineMs: 30000, requestTimeoutMs: Math.min(timeoutMs, 5000), failureCodes: {} };
    const readbackStarted = performance.now();
    for (const file of files.values()) {
      if (performance.now() - readbackStarted >= finalReadback.deadlineMs) break;
      finalReadback.attempted++;
      try { await readExact(file, finalReadRequest); finalReadback.verified++; }
      catch (error) {
        finalReadback.failed++;
        const code = typeof error?.safeCode === 'string' && /^[a-zA-Z0-9_:-]{1,100}$/u.test(error.safeCode) ? error.safeCode : 'readback_request_failed';
        finalReadback.failureCodes[code] = (finalReadback.failureCodes[code] ?? 0) + 1;
      }
    }
    finalReadback.notAttempted = files.size - finalReadback.attempted;
    finalReadback.elapsedMs = roundMs(performance.now() - readbackStarted);
    report.cleanup.finalReadback = finalReadback;
    report.cleanup.ownedFilesReadbackVerified = files.size > 0 && finalReadback.verified === files.size;
    if (!report.cleanup.ownedFilesReadbackVerified) report.accepted = false;
    const completePhases = names => Array.from({ length: rounds }, (_, round) => round).every(round => concurrency.every(c => names.every(name => {
      const matches = report.phases.filter(row => row.phase === name && row.round === round && row.concurrency === c);
      return matches.length === 1 && matches[0].total === samples && matches[0].succeeded === samples && matches[0].failed === 0 &&
        !matches[0].truncated && matches[0].notStarted === 0 && matches[0].warmup.failed === 0;
    })));
    report.contentBaselineAccepted = report.checks.contentBaselineCompleted === true && report.checks.initialBodiesHashVerified === true &&
      report.checks.crossAccountSameUriIsolated === true && (users.length === 1 || report.checks.crossMemberReadDenied === true) &&
      report.cleanup.ownedFilesReadbackVerified && completePhases([
        'content_read_hot_owner', 'content_write_deferred_hot_owner', 'content_read_members', 'content_write_deferred_members']);
    report.semanticBaselineAccepted = report.contentBaselineAccepted && report.blocked.length === 0 &&
      report.checks.nonliteralSemanticAnchorRetrieved === true && report.checks.allVisibilityProbesCompleted === true &&
      report.bootstrapTasks.length === users.length && report.bootstrapTasks.every(row => row.completed && !row.censored) &&
      completePhases(['memory_write_wait_vectors_hot_owner', 'semantic_find_hot_owner', 'memory_write_wait_vectors_members',
        'semantic_find_members', 'mixed_members_80read_20indexedwrite']);
    await save();
    // Only accounts attested absent and created during this run are eligible.
    for (const account of [...createdAccounts].reverse()) {
      try {
        assert.ok([ids.account, ids.foreignAccount].includes(account) && account.startsWith('memory-perf-'));
        const existing = await rootRequest('/api/v1/admin/accounts/' + account);
        assert.equal(existing.data.account_id, account, 'Cleanup identity mismatch');
        const deletion = await rootRequest('/api/v1/admin/accounts/' + account, { method: 'DELETE' });
        assert.ok(deletion.data.task_id && deletion.data.account_id === account, 'Deletion task identity mismatch');
        const deadline = Date.now() + 120000; let removed = false, taskCompleted = false;
        while (Date.now() < deadline) {
          const task = await rootRequest('/api/v1/tasks/' + encodeURIComponent(deletion.data.task_id));
          assert.ok(!['failed', 'cancelled'].includes(task.data.status), 'Account deletion task failed');
          taskCompleted = task.data.status === 'completed';
          const check = await rootRequest('/api/v1/admin/accounts/' + account, { allow: [404] });
          if (check.status === 404 && taskCompleted) { removed = true; break; }
          await delay(250);
        }
        assert.ok(removed, 'Account deletion was not confirmed');
        report.cleanup.removedAccounts.push(account);
      } catch {
        report.cleanup.failed = true; report.accepted = false;
      }
    }
    report.cleanup.accountRegistryGone = report.cleanup.removedAccounts.length === createdAccounts.length;
    report.cleanup.deletionTasksCompleted = report.cleanup.accountRegistryGone;
    report.endedAt = new Date().toISOString(); await save();
  }
  return report;
}

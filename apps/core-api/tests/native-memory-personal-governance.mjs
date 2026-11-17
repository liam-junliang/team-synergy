// Opt-in real Agent + Magpie + Tencent/OpenViking validation. Importing is inert.
// --check performs offline contract checks only. Never run the live path until
// the isolated engine configuration and service window have been supplied.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withPersistentDsh } from './native-memory-lifecycle-dsh.mjs';
import { withNativeCaptureDsh } from './native-memory-dsh-capture.mjs';
import { withNativeOpenCodeCapture } from './native-memory-opencode-capture.mjs';
import { runCase as runOpenCode } from './native-memory-opencode.mjs';
import { nativeCaptureEventId } from '../../cli/dist/memory-native-capture.js';
import { assertOwnedTestDatabase } from '../../../scripts/test-database-guard.mjs';
import { buildServer } from '../dist/server.js';
import { loadMemoryEngines, projectNextMemory } from '../dist/memory-engines.js';
import { processNextMemoryCapture } from '../dist/memory-capture-queue.js';
import { ensurePersonalMemoryResource } from '../dist/memory-personal-runtime.js';
import { installProjectionObserver } from './native-memory-projection-observer.mjs';

const self = fileURLToPath(import.meta.url);
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const observer = new URL('native-memory-handoff-observer.mjs', import.meta.url).href;
const resultsRoot = fileURLToPath(new URL('../../../docs/experiments/personal-memory-governance/', import.meta.url));
const model = 'workbuddy/deepseek-v4.1-flash';
const codePattern = /^[0-9A-HJKMNP-TV-Z]{20}$/u;
const hash = value => createHash('sha256').update(value).digest('hex');
const corpus = {
  account: '在所有项目中我习惯先用简短中文概括改动再列出验证结果。',
  project: '这个项目我习惯把验证截图统一放在蓝杉目录。',
  discussion: '我建议支付通知重复到达时按商户流水号去重。',
  adoption: '就按这个方案做',
  edited: '我偏好先列出验证证据再用一句话概括改动；没有验证证据时明确写尚未验证。',
};
const nativeCorpus = {
  opencodeProject: '这个项目我偏好把回归日志保存在青禾目录。',
  opencodeQuestion: '我在这个项目的回归日志应该放在哪里？请查当前个人记录并引用来源。',
};
const cleanEnv = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));

export function nativeQueueEvidence({ harness, nativeSessionId, memorySession, nativeMessageId, sourceText }, rows) {
  if (rows.length !== 1 || rows[0].session_key !== memorySession ||
      rows[0].event_key !== nativeCaptureEventId(harness, nativeSessionId, nativeMessageId)) return false;
  try {
    const payload = JSON.parse(rows[0].payload_json);
    return payload.sessionId === memorySession && payload.eventId === rows[0].event_key && payload.sourceText === sourceText &&
      Object.keys(payload).sort().join(',') === 'eventId,sessionId,sourceText' && hash(rows[0].payload_json) === rows[0].source_hash;
  } catch { return false; }
}

function check(condition, code) { if (!condition) { const error = new Error(code); error.code = code; throw error; } }
function safeFailure(error, phase) {
  const scalar = value => typeof value === 'number' || typeof value === 'boolean' || value === null ||
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/u.test(value) ? value : undefined;
  return { phase, name: typeof error?.name === 'string' ? error.name : 'Error',
    code: typeof error?.code === 'string' && /^[A-Za-z0-9_:-]{1,100}$/u.test(error.code) ? error.code : 'validation_failed',
    ...(error?.code === 'ERR_ASSERTION' ? { actual: scalar(error.actual), expected: scalar(error.expected), operator: scalar(error.operator) } : {}),
    ...(typeof error?.phase === 'string' && /^[a-z_]{1,80}$/u.test(error.phase) ? { nativePhase: error.phase } : {}),
    ...(typeof error?.causeCode === 'number' || typeof error?.causeCode === 'string' && /^[A-Za-z0-9_:-]{1,80}$/u.test(error.causeCode)
      ? { nativeCause: error.causeCode } : {}) };
}
function localBase(value) {
  const url = new URL(value);
  check(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    !url.username && !url.password && !url.search && !url.hash, 'loopback_endpoint_required');
  return url.href.replace(/\/$/u, '');
}

export function auditMcpRows(parsed) {
  const verifiedManagement = parsed.some(value => value && typeof value === 'object' && value.managementOnly === true &&
    value.citationSourceField === 'revisionSource' && value.currentSourcesVerified === true);
  const current = verifiedManagement ? parsed.flatMap(value => value && typeof value === 'object' && !Array.isArray(value) ?
    Array.isArray(value.items) ? value.items : typeof value.revisionSource === 'string' ? [value] : [] : []) : [];
  return [...parsed.filter(Array.isArray).flat().filter(row => typeof row?.source === 'string'),
    ...current.filter(row => row?.status === 'active' && codePattern.test(row.revisionSource) && codePattern.test(row.source))
      .map(row => ({ ...row, source: row.revisionSource, managementSource: row.source, scope: 'personal', state: 'preference' }))]
    .map(row => ({ source: row.source, state: row.state, scope: row.scope, textHash: typeof row.text === 'string' ? hash(row.text) : null,
      ...(row.managementSource ? { managementSource: row.managementSource, currentSourceVerified: true } : {}) }));
}

export function sharedDiscussionFacts(source, visibleRows, verifiedRows) {
  return codePattern.test(source) && visibleRows.some(row => row.source === source && row.scope === 'project' && row.state === 'discussed') &&
    visibleRows.every(row => row.scope === 'project' && row.state === 'discussed') &&
    verifiedRows.length === 1 && verifiedRows[0].source === source && verifiedRows[0].scope === 'project' && verifiedRows[0].state === 'discussed';
}

async function invokeTsp(member, args, input = '') {
  const child = spawn(process.execPath, [cli, ...args], { cwd: member.cwd, windowsHide: true,
    env: { ...cleanEnv(), AGENTCTL_HOME: member.home, CODEX_HOME: member.codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
  const done = once(child, 'close'); let out = ''; child.stdout.setEncoding('utf8').on('data', value => { out += value; }); child.stderr.resume();
  child.stdin.end(input); const timer = setTimeout(() => child.kill(), 75000);
  try { const [exit] = await done; check(exit === 0, 'cli_' + args.slice(0, 2).join('_') + '_failed');
    const result = JSON.parse(out); check(result.ok === true, 'cli_envelope_rejected'); return result.data; }
  finally { clearTimeout(timer); }
}

/** Observation-only relay: tool outputs are forwarded byte for byte. The audit
 * keeps source/state/hash metadata and receipts, never memory or model secrets. */
async function relay(auditFile, memorySession) {
  check(path.isAbsolute(auditFile) && /^[A-Za-z0-9._:-]{1,160}$/u.test(memorySession), 'invalid_relay_binding');
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'AGENTCTL_HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const child = spawn(process.execPath, ['--import', observer, cli, 'memory', 'mcp'], { windowsHide: true,
    env: { ...env, TSP_MEMORY_SESSION: memorySession, TSP_HANDOFF_HTTP_AUDIT: auditFile }, stdio: ['pipe', 'pipe', 'ignore'] });
  const done = once(child, 'close'), pending = new Map(), input = createInterface({ input: process.stdin });
  input.on('line', line => { const request = JSON.parse(line); if (request.id !== undefined) pending.set(request.id, request); child.stdin.write(line + '\n'); });
  input.on('close', () => child.stdin.end());
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const response = JSON.parse(line), request = pending.get(response.id); pending.delete(response.id);
      if (request?.method === 'tools/call') {
        const parsed = (response.result?.content ?? []).map(block => { try { return JSON.parse(block.text); } catch { return null; } });
        const entries = auditMcpRows(parsed);
        const metadata = parsed.find(value => value && typeof value === 'object' && value.context_receipt);
        await appendFile(auditFile, JSON.stringify({ kind: 'mcp', at: new Date().toISOString(), tool: request.params?.name,
          scope: request.params?.arguments?.scope, query: request.params?.arguments?.query,
          sourceRequested: request.params?.arguments?.source,
          error: Boolean(response.error || response.result?.isError),
          rows: entries,
          unchanged: metadata?.unchanged_sources ?? [], unavailable: metadata?.unavailable_sources ?? [],
          receiptReturned: Boolean(metadata?.context_receipt) }) + '\n', { mode: 0o600 });
      }
      process.stdout.write(line + '\n');
    }
    check((await done)[0] === 0, 'mcp_relay_child_failed');
  } finally { input.close(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

async function replaceApi(member, base) {
  const file = path.join(member.home, 'auth.json'), current = JSON.parse(await readFile(file, 'utf8'));
  check(current.device_token === member.token, 'fixture_device_mismatch');
  await writeFile(file, JSON.stringify({ ...current, api_url: base }), { mode: 0o600 });
}

export async function runPersonalGovernance({ runId, includeOpenCode = false, nativeCapture = false } = {}) {
  check(/^[A-Za-z0-9_-]{6,96}$/u.test(runId), 'bounded_unique_run_id_required');
  check(Boolean(process.env.TSP_TEST_DATABASE_URL && process.env.TSP_MEMORY_ENGINES_FILE && process.env.TSP_EVAL_GATEWAY_TOKEN), 'private_configuration_required');
  check(process.env.TSP_EVAL_MODEL === model && process.env.TSP_EVAL_FAMILY === 'deepseek-v4.1-flash', 'requested_flash_model_required');
  const gateway = localBase(process.env.TSP_EVAL_GATEWAY_URL);
  check(new URL(gateway).pathname.replace(/\/$/u, '') === '/v1', 'magpie_v1_gateway_required');
  const cfg = await loadMemoryEngines(process.env.TSP_MEMORY_ENGINES_FILE);
  if (nativeCapture) {
    check(Number(new URL(cfg.tencent.baseUrl).port) === 18524 && Number(new URL(cfg.tencent.coreBaseUrl).port) === 18520 &&
      Number(new URL(cfg.openviking.baseUrl).port) === 21933, 'dedicated_test_memory_engines_required');
    includeOpenCode = true;
  }
  check(Object.keys(cfg.projects).length === 0 && Object.keys(cfg.accounts).length === 0, 'empty_static_mappings_required');
  check(Boolean(cfg.projectProvisioning?.semanticAgentId && cfg.tencent.coreBaseUrl && cfg.personalProvisioning), 'automatic_engine_provisioning_required');
  for (const endpoint of [cfg.tencent.baseUrl, cfg.tencent.coreBaseUrl, cfg.openviking.baseUrl]) localBase(endpoint);
  const resultRoot = nativeCapture ? fileURLToPath(new URL('../../../docs/experiments/native-session-capture/', import.meta.url)) : resultsRoot;
  const outputDir = path.join(resultRoot, runId); await mkdir(resultRoot, { recursive: true }); await mkdir(outputDir);
  const output = path.join(outputDir, 'result.json');
  const secrets = [process.env.TSP_EVAL_GATEWAY_TOKEN, cfg.tencent.token, cfg.personalProvisioning.adminApiKey, cfg.personalProvisioning.keySeed];
  const report = { schema: nativeCapture ? 'native-session-capture-live/v1' : 'personal-memory-governance-live/v1', runId, startedAt: new Date().toISOString(), accepted: false, mechanicalAccepted: false, phase: 'configuration',
    modelSemanticReview: { status: 'pending', method: 'independent review of preserved original Agent answers, separate from fact-level automated checks', items: [] },
    models: { agent: model, extraction: model, provider: 'local Magpie OpenAI-compatible gateway' },
    capture: { mode: nativeCapture ? 'Explicit native host plugins capture committed operator messages; the controller only observes source IDs/hashes and advances platform workers.' :
      'trusted controller sends the same real DSH user turn through CLI stdin with a stable native-session event ID',
      nativeAutomaticDshHook: nativeCapture, nativeAutomaticOpenCodeHook: nativeCapture, controllerTranscriptsForwarded: 0, events: [] },
    configuration: { initialStaticProjects: 0, initialStaticAccounts: 0, automaticProjectWiki: true, automaticPersonalUsers: true,
      guidance: 'production tsp memory guidance; no writer-only instruction',
      sourceHashes: { runner: hash(await readFile(self)),
        guidance: hash(await readFile(new URL('../../cli/dist/memory.js', import.meta.url))),
        mcp: hash(await readFile(new URL('../../cli/dist/memory-mcp.js', import.meta.url))) } },
    corpus: Object.fromEntries(Object.entries({ ...corpus, ...(nativeCapture ? nativeCorpus : {}) }).map(([name, text]) => [name, { chars: text.length, sha256: hash(text) }])),
    sessions: [], projections: [], engineRequests: [], sources: [], checks: {}, cleanup: { users: [], errors: [], wikiRemoved: false, coreRecordsRemoved: false, databaseRemoved: false },
    limitations: [nativeCapture ? 'Capture is enabled only for the two explicitly configured writer sessions; reader sessions remain read-only. This does not establish global automatic capture of every chat.' :
      'Selected trusted user turns are captured by the controller. This does not establish automatic DSH/OpenCode transcript collection.',
      'Small synthetic software-project corpus and two members; concurrency and retry/late-write races belong to the independent unit suites.',
      'A model may remember a withdrawn value already visible in its chat. The authoritative source must become unavailable; blank chats test subsequent recall.'],
    realGitActions: 0 };
  const save = async () => {
    const text = JSON.stringify(report, null, 2) + '\n';
    check(secrets.filter(secret => typeof secret === 'string' && secret.length >= 8).every(secret => !text.includes(secret)), 'report_secret_rejected');
    await writeFile(output + '.tmp', text, { mode: 0o600 }); await rename(output + '.tmp', output);
  };
  const stage = async (name, work) => { report.phase = name; await save(); const result = await work(); await save(); return result; };
  const projectionObserver = installProjectionObserver({ baseUrls: [cfg.openviking.baseUrl, cfg.tencent.baseUrl, cfg.tencent.coreBaseUrl],
    entries: report.engineRequests, context: () => ({ phase: report.phase }), save });
  process.env.ACP_ALLOW_LEGACY_IDENTITY = '0'; process.env.TSP_MEMORY_ENABLED = '1';
  process.env.TSP_MEMORY_PROVIDER = 'openai'; process.env.TSP_MEMORY_BASE_URL = gateway;
  process.env.TSP_MEMORY_API_KEY = process.env.TSP_EVAL_GATEWAY_TOKEN; process.env.TSP_MEMORY_MODEL = model;
  const wiki = async (operation, body, allowMissing = false) => {
    const response = await fetch(localBase(cfg.tencent.baseUrl) + '/wiki/' + operation, { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer ' + cfg.tencent.token, 'x-tdai-service-id': cfg.tencent.serviceId, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (allowMissing && response.status === 404) { await response.arrayBuffer(); return null; }
    check(response.ok, 'wiki_http_' + response.status); const result = await response.json(); check(result.code === 0, 'wiki_rejected'); return result.data;
  };
  const adminUserPath = user => '/api/v1/admin/accounts/' + encodeURIComponent(cfg.personalProvisioning.accountId) + '/users/' + encodeURIComponent(user);
  const ov = async (route, key, method = 'GET', allow = []) => {
    const response = await fetch(localBase(cfg.openviking.baseUrl) + route, { method, redirect: 'error', headers: { 'x-api-key': key }, signal: AbortSignal.timeout(20000) });
    if (allow.includes(response.status)) { await response.arrayBuffer(); return { status: response.status, data: null }; }
    check(response.ok, 'openviking_http_' + response.status); const result = await response.json(); check(result.status === 'ok', 'openviking_envelope_rejected');
    return { status: response.status, data: result.result };
  };
  let failure;
  try {
    const { withNativeMemoryProject } = await import('./native-memory-live.mjs');
    await withNativeMemoryProject({ project: 'Personal memory governance isolated Agent validation' }, async (f, { dir }) => {
      let app, base, binding; const freshUsers = [], roots = new Set();
      const native = async (method, route, member = f.alice, body, allowed = [200]) => {
        const response = await fetch(base + route, { method, redirect: 'error',
          headers: { authorization: 'Bearer ' + member.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-tsp-memory-explain': '1' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
        const result = await response.json(); check(allowed.includes(response.status), 'platform_http_' + response.status);
        return { ...result, status: response.status, retrieval: response.headers.get('x-tsp-memory-retrieval'),
          matches: JSON.parse(response.headers.get('x-tsp-memory-matches') ?? '{}') };
      };
      const ok = async (...args) => { const result = await native(...args); check(result.ok === true, 'platform_envelope_rejected'); return result.data; };
      const manage = (member, source) => ok('GET', '/memory/personal/' + source, member);
      const currentBinding = async () => (await f.db.$client.query(`select b.wiki_id,b.engine_team_id,b.engine_user_id,b.semantic_agent_id from project_memory_bindings b
        join projects p on p.id=b.project_id where p.code=$1`, [f.projectCode])).rows[0];
      const uri = (member, source) => 'viking://user/tsp_' + member.code.toLowerCase() + '/memories/preferences/team-synergy/' + source + '.json';
      const physical = async (member, source, keyOwner = member) => {
        const account = await ensurePersonalMemoryResource(cfg, keyOwner.code); secrets.push(account.apiKey);
        return ov('/api/v1/content/read?uri=' + encodeURIComponent(uri(member, source)), account.apiKey, 'GET', [403, 404]);
      };
      const drain = async () => {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
          const pending = (await f.db.$client.query(`select status,attempts,engine,operation,generation,last_error,
            extract(epoch from (lease_until-now()))*1000 as retry_wait_ms from memory_projection_jobs where status<>'synced' order by id`)).rows;
          if (!pending.length) return;
          check(pending.every(job => job.attempts < 3), 'projection_attempt_limit_exceeded');
          check(Date.now() + 13000 < deadline, 'projection_deadline_exceeded');
          const result = await projectNextMemory(f.db, cfg);
          if (result) { report.projections.push({ at: new Date().toISOString(), ...result,
              pendingBefore: pending.map(job => ({ ...job, retry_wait_ms: Math.max(0, Math.ceil(Number(job.retry_wait_ms ?? 0))) })) }); await save();
            check(result.status === 'synced' || result.status === 'needs_reconcile', 'projection_not_verified'); }
          // The production worker owns its 30s/backoff lease. Never shorten it
          // in a test; preserve the failed attempt and wait for the real retry.
          if (!result || result.status !== 'synced') await delay(1000);
        }
        check(false, 'projection_deadline_exceeded');
      };
      const readSource = async (member, source, root = f.root) => ok('POST', root + '/memory/sources', member, { sources: [source] });
      const auditRead = async file => (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const observed = (events, source) => events.some(event => event.rows?.some(row => row.source === source) || event.unchanged?.some(row => row.source === source));
      const runDsh = async (label, member, work) => {
        const auditFile = path.join(dir, label + '.jsonl'), memorySession = 'governance-' + label;
        await writeFile(auditFile, '', { flag: 'wx', mode: 0o600 });
        const session = { harness: 'dsh', label, emptySession: true, member: member.code, turns: [], audit: [] }; report.sessions.push(session);
        try {
          return await withPersistentDsh({ member, dir, mcpArgs: [self, '--mcp-relay', auditFile, memorySession],
            system: execFileSync(process.execPath, [cli, 'memory', 'guidance', '--harness', 'dsh'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }),
            maxTokens: 3072, turnTimeoutMs: 180000 }, async host => {
            check(!report.sessions.some(other => other !== session && other.sessionId === host.sessionId), 'blank_session_reused_prior_host_history');
            session.sessionId = host.sessionId; session.version = host.version;
            const turn = async prompt => { const result = await host.turn(prompt); session.turns.push({ prompt, ...result }); await save(); return result; };
            return work({ host, turn, session, audit: async () => auditRead(auditFile) });
          });
        } finally { session.audit = await auditRead(auditFile); await save(); }
      };
      const capture = async (host, member, name, text) => {
        check(!nativeCapture, 'controller_capture_forbidden_in_native_mode');
        report.capture.controllerTranscriptsForwarded++;
        const eventId = 'dsh.turn-' + name;
        const ack = await invokeTsp(member, ['memory', 'capture', '--session', host.sessionId, '--event', eventId], text);
        check(codePattern.test(ack.captureCode) && ['pending', 'processing'].includes(ack.status), 'durable_queue_ack_required');
        const entry = { name, sessionId: host.sessionId, eventId, sourceHash: hash(text), captureCode: ack.captureCode, acknowledgedStatus: ack.status };
        report.capture.events.push(entry); await save();
        const duplicate = await invokeTsp(member, ['memory', 'capture', '--session', host.sessionId, '--event', eventId], text);
        check(duplicate.captureCode === ack.captureCode, 'event_replay_changed_job');
        const processed = await processNextMemoryCapture(f.db); check(processed?.captureCode === ack.captureCode, 'wrong_capture_claimed');
        const job = await ok('GET', f.root + '/memory/captures/' + ack.captureCode, member);
        entry.finalStatus = job.status; entry.attempts = job.attempts; entry.errorCode = job.error?.code ?? null;
        if (name === 'adoption') { check(job.status === 'needs_clarification', 'unbound_adoption_must_require_target'); return null; }
        check(job.status === 'completed' && job.result?.items?.length === 1, 'real_extraction_not_completed');
        const item = job.result.items[0]; check(codePattern.test(item.source), 'capture_source_missing'); entry.source = item.source; entry.state = item.state; entry.scope = item.scope;
        if (item.scope === 'personal') roots.add(item.source);
        report.sources.push({ source: item.source, scope: item.scope, state: item.state, textHash: hash(item.text), originProject: f.projectCode });
        await drain(); return item;
      };
      const observeNative = async ({ harness, host, memorySession, nativeMessageId, nativeSeq }, member, name, text, disposition = 'material') => {
        const eventId = nativeCaptureEventId(harness, host.sessionId, nativeMessageId), deadline = Date.now() + 45000;
        let rows = [];
        while (Date.now() < deadline) {
          rows = (await f.db.$client.query(`select j.code,j.status,j.attempts,j.session_key,j.event_key,j.source_hash,j.payload_json
            from memory_capture_jobs j join projects p on p.id=j.project_id join users u on u.id=j.principal_id
            where p.code=$1 and u.code=$2 and j.session_key=$3 and j.event_key=$4`,
          [f.projectCode, member.code, memorySession, eventId])).rows;
          if (rows.length) break;
          await delay(200);
        }
        check(nativeQueueEvidence({ harness, nativeSessionId: host.sessionId, memorySession, nativeMessageId, sourceText: text }, rows), 'native_operator_queue_identity_or_hash_mismatch');
        const queued = rows[0]; check(codePattern.test(queued.code), 'native_durable_queue_ack_missing');
        const entry = { name, harness, sessionId: memorySession, nativeSessionId: host.sessionId, nativeMessageId,
          ...(nativeSeq === undefined ? {} : { nativeSeq }), eventId, sourceHash: hash(text), payloadHash: queued.source_hash,
          captureCode: queued.code, acknowledgedStatus: queued.status, producer: 'installed-native-plugin',
          rawSourceMatchesNative: true, controllerForwardedSource: false };
        report.capture.events.push(entry); await save();
        let job;
        for (let attempt = 0; attempt < 12; attempt++) {
          job = await ok('GET', f.root + '/memory/captures/' + queued.code, member);
          if (!['pending', 'processing'].includes(job.status)) break;
          const processed = await processNextMemoryCapture(f.db);
          if (!processed) await delay(100);
        }
        check(job && !['pending', 'processing', 'failed'].includes(job.status), 'native_queue_not_organized');
        entry.finalStatus = job.status; entry.attempts = job.attempts; entry.errorCode = job.error?.code ?? null;
        if (name === 'adoption') { check(job.status === 'needs_clarification', 'unbound_adoption_must_require_target'); return null; }
        if (disposition === 'non-material') {
          check(['skipped', 'needs_clarification'].includes(job.status) && !job.result?.items?.length, 'native_question_created_unexpected_material'); return null;
        }
        check(job.status === 'completed' && job.result?.items?.length === 1, 'native_real_extraction_not_completed');
        const item = job.result.items[0]; check(codePattern.test(item.source), 'native_capture_source_missing');
        entry.source = item.source; entry.state = item.state; entry.scope = item.scope;
        if (item.scope === 'personal') roots.add(item.source);
        report.sources.push({ source: item.source, scope: item.scope, state: item.state, textHash: hash(item.text), originProject: f.projectCode });
        await drain(); return item;
      };
      const nativeStatus = (member, config) => invokeTsp(member, ['memory', 'native', 'status', '--harness', config.harness,
        '--host-session', config.hostSessionId, '--session', config.memorySession, '--owner', config.owner]);
      let accountItem, projectItem, discussionItem, edited, opencodeItem;
      try {
        await stage('fresh_fixture_and_provisioning', async () => {
          const database = (await f.db.$client.query('select current_database() as name')).rows[0].name;
          check(/^tsp_tests_memorylive_[0-9a-f]{20}$/u.test(database), 'fresh_database_required');
          const identity = await assertOwnedTestDatabase(f.db.$client);
          check(identity.databaseName === database, 'fresh_database_owner_lease_mismatch');
          report.testDatabase = { name: database, isolatedClusterPort: 55432, registeredOwnershipVerified: true };
          for (const member of [f.alice, f.bob]) {
            const userId = 'tsp_' + member.code.toLowerCase();
            check((await ov(adminUserPath(userId), cfg.personalProvisioning.adminApiKey, 'GET', [404])).status === 404, 'fixture_user_preexisted');
            freshUsers.push({ principal: member.code, userId, initiallyAbsent: true });
          }
          app = await buildServer({ db: f.db, logger: false, memoryEnginesFile: process.env.TSP_MEMORY_ENGINES_FILE });
          base = await app.listen({ host: '127.0.0.1', port: 0 });
          for (const member of [f.alice, f.bob]) { await replaceApi(member, base); await invokeTsp(member, ['project', 'bind', f.projectCode]); }
          check((await ok('POST', f.root + '/memory/management/enable', f.alice, {})).bindingState === 'ready', 'project_memory_not_ready');
          binding = await currentBinding(); check(Boolean(binding?.wiki_id), 'created_wiki_not_identified');
          const detail = await wiki('get', { wiki_id: binding.wiki_id });
          check(detail.name === 'tsp-memory-' + f.projectCode && detail.team_id === cfg.projectProvisioning.teamId &&
            detail.owner_user_id === cfg.projectProvisioning.userId, 'wiki_identity_mismatch');
          report.checks.noTaskOrBusinessObjectRequired = true;
        });
        const beforeRequirement = await f.ok('GET', '/requirements/' + f.requirementCode, f.alice);
        await stage(nativeCapture ? 'native_writer_sessions_and_automatic_capture' : 'real_writer_session_and_trusted_capture', async () => {
          if (!nativeCapture) await runDsh('alice-writer', f.alice, async ({ host, turn }) => {
            const bound = await invokeTsp(f.alice, ['memory', 'bind', '--session', host.sessionId]);
            check(!['topicCode', 'requirementCode', 'expectedRevision', 'expectedHead'].some(key => key in bound), 'unbound_session_has_business_witness');
            await turn(corpus.account); accountItem = await capture(host, f.alice, 'account', corpus.account);
            await turn(corpus.project); projectItem = await capture(host, f.alice, 'project', corpus.project);
            await turn(corpus.discussion); discussionItem = await capture(host, f.alice, 'discussion', corpus.discussion);
            await turn(corpus.adoption); await capture(host, f.alice, 'adoption', corpus.adoption);
          });
          else {
            const memorySession = 'native-dsh-writer', hostSessionId = 'native-dsh-' + randomBytes(12).toString('hex');
            const dshConfig = { ...await invokeTsp(f.alice, ['memory', 'native', 'config', '--harness', 'dsh',
              '--host-session', hostSessionId, '--session', memorySession]), auditFile: path.join(dir, 'native-dsh-capture.jsonl') };
            const session = { harness: 'dsh', label: 'alice-native-writer', emptySession: true, member: f.alice.code, turns: [], audit: [] };
            report.sessions.push(session);
            await withNativeCaptureDsh({ member: f.alice, config: dshConfig, dir,
              system: execFileSync(process.execPath, [cli, 'memory', 'guidance', '--harness', 'dsh'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }) }, async host => {
              session.sessionId = host.sessionId; session.version = host.version;
              const turn = async (name, text) => {
                const result = await host.turn(text); session.turns.push({ prompt: text, ...result }); await save();
                check(result.nativeUserEvents.length === 1 && result.nativeUserEvents[0].nativeMessageId === result.messageId &&
                  result.nativeUserEvents[0].textHash === hash(text) && result.nativeUserEvents[0].sourceKind === 'user', 'native_dsh_user_event_mismatch');
                return observeNative({ harness: 'dsh', host, memorySession, nativeMessageId: result.messageId,
                  nativeSeq: result.nativeUserEvents[0].nativeSeq }, f.alice, name, text);
              };
              accountItem = await turn('account', corpus.account); projectItem = await turn('project', corpus.project);
              const beforeRestart = await host.status();
              check(beforeRestart.events.length === 2 && beforeRestart.events.every(event => event.state === 'accepted'), 'native_dsh_before_restart_not_delivered');
              await host.restart();
              const afterRestart = await host.status();
              check(afterRestart.events.length === 2 && afterRestart.events.every(event => event.state === 'accepted') &&
                afterRestart.events.every((event, i) => event.eventId === beforeRestart.events[i].eventId && event.attempts === beforeRestart.events[i].attempts),
              'native_dsh_seed_recaptured_or_redelivered');
              discussionItem = await turn('discussion', corpus.discussion); await turn('adoption', corpus.adoption);
              session.generations = host.generations; session.nativeUserEvents = host.nativeEvents; session.audit = await auditRead(dshConfig.auditFile);
              const durable = session.audit.filter(event => event.kind === 'native-capture-durable');
              check(durable.length === 4 && new Set(durable.map(event => event.eventId)).size === 4 &&
                durable.every(event => report.capture.events.some(source => source.eventId === event.eventId && source.sourceHash === event.sourceHash)),
              'native_dsh_durable_audit_has_non_operator_or_duplicate');
              report.capture.dshRestart = { before: beforeRestart.events, after: afterRestart.events, seedNotRepublished: true };
            });
            report.checks.nativeDshAutomaticCapture = true; report.checks.nativeDshSeedNotRecaptured = true;
            const opencodeSession = 'native-opencode-writer', captureAudit = path.join(dir, 'native-opencode-capture.jsonl'), toolAudit = path.join(dir, 'native-opencode-tools.jsonl');
            await writeFile(toolAudit, '', { flag: 'wx', mode: 0o600 });
            const session2 = { harness: 'opencode', label: 'alice-native-writer', emptySession: true, member: f.alice.code, turns: [], audit: [] };
            report.sessions.push(session2);
            await withNativeOpenCodeCapture({ member: f.alice, dir, memorySession: opencodeSession, owner: dshConfig.owner,
              auditFile: captureAudit, allowModel: true, mcpArgs: [self, '--mcp-relay', toolAudit, opencodeSession],
              system: execFileSync(process.execPath, [cli, 'memory', 'guidance', '--harness', 'opencode'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }) }, async host => {
              session2.sessionId = host.sessionId; session2.version = host.version;
              // Stop only this freshly allocated test API. The production API
              // and all memory engines remain untouched throughout the test.
              const testPort = Number(new URL(base).port); await app.close(); app = undefined;
              const written = await host.record(nativeCorpus.opencodeProject); session2.turns.push({ prompt: nativeCorpus.opencodeProject, ...written }); await save();
              const staged = await nativeStatus(f.alice, host.options);
              check(staged.events.length === 1 && staged.events[0].state === 'staged', 'native_opencode_precommit_was_uploaded');
              await host.restart();
              let ready;
              const deadline = Date.now() + 25000;
              while (Date.now() < deadline) {
                ready = await nativeStatus(f.alice, host.options);
                if (ready.events[0]?.state === 'ready' && ready.events[0]?.errorCode) break;
                await delay(200);
              }
              check(ready?.events[0]?.state === 'ready' && Boolean(ready.events[0].errorCode), 'native_opencode_offline_record_not_retained_ready');
              app = await buildServer({ db: f.db, logger: false, memoryEnginesFile: process.env.TSP_MEMORY_ENGINES_FILE });
              check(await app.listen({ host: '127.0.0.1', port: testPort }) === base, 'native_test_api_origin_changed');
              opencodeItem = await observeNative({ harness: 'opencode', host, memorySession: opencodeSession, nativeMessageId: written.nativeMessageId },
                f.alice, 'opencode-project', nativeCorpus.opencodeProject);
              check(opencodeItem.scope === 'personal' && opencodeItem.state === 'preference', 'native_opencode_preference_wrong_scope');
              const read = await host.turn(nativeCorpus.opencodeQuestion); session2.turns.push({ prompt: nativeCorpus.opencodeQuestion, ...read }); await save();
              check(read.answer.includes(opencodeItem.source), 'native_opencode_agent_did_not_cite_automatic_memory');
              await observeNative({ harness: 'opencode', host, memorySession: opencodeSession, nativeMessageId: read.nativeMessageId },
                f.alice, 'opencode-read-question', nativeCorpus.opencodeQuestion, 'non-material');
              session2.audit = await auditRead(toolAudit);
              check(observed(session2.audit, opencodeItem.source), 'native_opencode_tool_trace_missing_automatic_source');
              const nativeAudit = await auditRead(captureAudit), verifiedIds = new Set(nativeAudit.filter(event => event.kind === 'native-source-verified').map(event => event.eventId));
              check(report.capture.events.filter(event => event.harness === 'opencode').every(event => verifiedIds.has(event.eventId)), 'native_opencode_source_readback_audit_missing');
              report.capture.opencodeRecovery = { nativeMessageId: written.nativeMessageId, preRestartState: staged.events[0].state,
                offlineState: ready.events[0].state, offlineErrorCode: ready.events[0].errorCode, apiPort: testPort,
                apiOriginUnchanged: true, restartedNativeHost: true, automaticDeliveryAfterApiRestart: true, captureAudit: nativeAudit };
            });
            report.checks.nativeOpenCodeAutomaticCapture = true; report.checks.nativeOpenCodePersistedRestartRecovery = true;
            report.checks.nativeApiOfflineRetry = true;
            const queue = (await f.db.$client.query('select session_key,event_key,source_hash,payload_json from memory_capture_jobs order by id')).rows;
            check(queue.length === 6 && report.capture.events.length === 6 && new Set(queue.map(row => row.event_key)).size === 6 &&
              report.capture.events.every(event => nativeQueueEvidence({ harness: event.harness, nativeSessionId: event.nativeSessionId,
                memorySession: event.sessionId, nativeMessageId: event.nativeMessageId,
                sourceText: event.name === 'opencode-project' ? nativeCorpus.opencodeProject : event.name === 'opencode-read-question' ? nativeCorpus.opencodeQuestion : corpus[event.name] },
              queue.filter(row => row.event_key === event.eventId))), 'native_capture_contains_non_operator_or_unknown_source');
            check(report.capture.controllerTranscriptsForwarded === 0, 'controller_forwarded_native_transcripts');
            report.checks.nativeUserOnlyEventMapping = true; report.checks.controllerDidNotForwardTranscripts = true;
          }
          const personal = await invokeTsp(f.alice, ['memory', 'personal', 'list']);
          check(personal.items.length === (nativeCapture ? 3 : 2), 'wrong_personal_record_count');
          check(personal.items.find(item => item.source === accountItem.source)?.applicability === 'account', 'explicit_account_scope_lost');
          check(personal.items.find(item => item.source === projectItem.source)?.applicability === 'project', 'project_private_scope_lost');
          if (opencodeItem) check(personal.items.find(item => item.source === opencodeItem.source)?.applicability === 'project', 'opencode_project_private_scope_lost');
          check(discussionItem.scope === 'project' && discussionItem.state === 'discussed', 'discussion_promoted_without_decision');
          assert.deepEqual(await f.ok('GET', '/requirements/' + f.requirementCode, f.alice), beforeRequirement);
          report.checks.requirementUnchangedAndAdoptionNeedsClarification = true;
          for (const [item, applicability] of [[accountItem, 'account'], [projectItem, 'project'], ...(opencodeItem ? [[opencodeItem, 'project']] : [])]) {
            const stored = await physical(f.alice, item.source); check(stored.status === 200 && typeof stored.data === 'string', 'personal_physical_write_missing');
            const trailer = /\n\n<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->$/u.exec(stored.data);
            const body = trailer && Number.isSafeInteger(JSON.parse(trailer[1]).version) && JSON.parse(trailer[1]).version > 0 ? stored.data.slice(0, trailer.index) : stored.data;
            const decoded = JSON.parse(body);
            check(decoded.source === item.source && decoded.text === item.text && decoded.applicability === applicability &&
              (applicability === 'account' ? decoded.project === undefined : decoded.project === f.projectCode), 'personal_physical_body_or_scope_mismatch');
          }
          check((await physical(f.alice, accountItem.source, f.bob)).status === 403, 'physical_cross_member_read_not_denied');
        });
        await stage('blank_reader_and_live_revision_change', async () => {
          await runDsh('alice-reader', f.alice, async ({ turn, audit }) => {
            const first = await turn('我的变更说明通常怎样组织？请给出依据，并说明这种习惯是否允许你直接推送。');
            check(first.answer.includes(accountItem.source) && /中文/u.test(first.answer) && /验证/u.test(first.answer), 'blank_agent_missed_original_preference_or_source');
            check(/确认|授权/u.test(first.answer) && /推送/u.test(first.answer), 'preference_confused_with_push_authority');
            check(observed(await audit(), accountItem.source), 'original_source_not_observed_in_real_tool_trace');
            const current = await manage(f.alice, accountItem.source);
            edited = await invokeTsp(f.alice, ['memory', 'personal', 'edit', current.source, '--expected-revision', String(current.revision), '--text', corpus.edited, '--reason', '本轮真实会话验证修订']);
            check(edited.revision === 2 && edited.revisionSource !== current.revisionSource, 'edit_not_an_immutable_revision');
            check((await readSource(f.alice, current.revisionSource)).length === 0, 'old_source_still_valid_immediately_after_edit');
            await drain();
            const changed = await turn('请重新核对我现在组织变更说明的风格；若与前面不同，应按当前有效记录说明，并给出来源。');
            check(changed.answer.includes(edited.revisionSource) && /验证证据/u.test(changed.answer), 'same_chat_failed_to_update_current_preference');
            check(observed(await audit(), edited.revisionSource), 'new_source_not_observed_in_real_tool_trace');
          });
          report.checks.sameChatUpdatesAndOldSourceInvalid = true;
        });
        const blankQuestion = '我的变更说明应该先讲什么再讲什么？请按当前记录解释并引用来源。';
        await stage('fresh_reader_after_edit', async () => {
          const query = '我一般怎样安排代码变更描述与验证记录的先后顺序';
          check(!corpus.edited.includes(query), 'private_semantic_probe_was_literal');
          const semantic = await native('POST', f.root + '/memory/search', f.alice, { query, scope: 'personal' });
          check(semantic.ok && semantic.data.some(item => item.source === edited.revisionSource) && semantic.retrieval === 'engine-and-platform' &&
            semantic.matches[edited.revisionSource]?.includes('viking'), 'private_semantic_engine_attribution_missing');
          report.privateSemanticProbe = { query, source: edited.revisionSource, channels: semantic.matches[edited.revisionSource], retrieval: semantic.retrieval };
          await runDsh('alice-fresh-after-edit', f.alice, async ({ turn, audit }) => {
            const answer = await turn(blankQuestion);
            check(answer.answer.includes(edited.revisionSource) && /验证证据/u.test(answer.answer), 'fresh_agent_missed_edited_preference');
            check(observed(await audit(), edited.revisionSource), 'fresh_agent_source_trace_missing');
            await turn('谢谢，此次不用执行任何仓库操作。');
          });
          if (includeOpenCode) {
            const result = await runOpenCode({ member: f.alice, dir, prompt: blankQuestion,
              system: execFileSync(process.execPath, [cli, 'memory', 'guidance', '--harness', 'opencode'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }), mcpArgs: [cli, 'memory', 'mcp'] });
            report.sessions.push({ harness: 'opencode', label: 'alice-fresh-after-edit', emptySession: true, member: f.alice.code, ...result });
            check(result.answer.includes(edited.revisionSource) && /验证证据/u.test(result.answer), 'opencode_missed_edited_preference');
          }
          report.checks.freshChatUsesNewRevision = true;
        });
        await stage('bob_shared_background_and_private_isolation', async () => {
          check((await native('GET', '/memory/personal/' + accountItem.source, f.bob, undefined, [403, 404])).ok === false, 'bob_read_alice_management_history');
          check((await readSource(f.bob, edited.revisionSource)).length === 0, 'bob_read_alice_source');
          await runDsh('bob-reader', f.bob, async ({ turn, audit }) => {
            const shared = await turn('项目对重复的付款通知有什么讨论？现在是否已经实施？请给出来源。');
            const visibleRows = await ok('POST', f.root + '/memory/brief', f.bob, { scope: 'project' });
            const verifiedRows = await readSource(f.bob, discussionItem.source);
            const publicCount = (await f.db.$client.query(`select count(*)::int as n from memory_fragments m
              join memory_capture_receipts r on r.id=m.receipt_id join projects p on p.id=r.project_id
              where p.code=$1 and m.state<>'preference'`, [f.projectCode])).rows[0].n;
            check(shared.answer.includes(discussionItem.source) && sharedDiscussionFacts(discussionItem.source, visibleRows, verifiedRows) &&
              visibleRows.length === publicCount, 'bob_shared_source_or_state_invalid');
            report.bobProjectFacts = { source: discussionItem.source, state: verifiedRows[0].state, sharedRecordCount: publicCount,
              confirmedOrImplementedRecordCount: visibleRows.filter(row => ['confirmed', 'implemented'].includes(row.state)).length,
              sourceReadbackVerified: true, alicePrivateSourceUnavailable: true };
            report.modelSemanticReview.items.push({ label: 'bob-discussion-versus-implementation', harness: 'dsh',
              sessionLabel: 'bob-reader', turn: shared.turn, source: discussionItem.source, status: 'pending',
              criteria: 'Review the original answer for discussion versus implemented facts. Its exact wording is preserved in sessions; automated code does not grade its natural-language meaning.' });
            check(observed(await audit(), discussionItem.source), 'shared_source_not_observed_in_bob_tool_trace');
            const privateAnswer = await turn('我自己的变更说明风格和截图保存目录分别是什么？找不到本人的记录就说未知。');
            check(!/蓝杉|青禾|先列出验证证据|先列验证/u.test(privateAnswer.answer) && !privateAnswer.answer.includes(edited.revisionSource), 'bob_agent_revealed_alice_private_preference');
            const trace = await audit();
            check([accountItem.source, edited.revisionSource, projectItem.source, ...(opencodeItem ? [opencodeItem.source] : [])]
              .every(source => !observed(trace, source)), 'alice_private_source_in_bob_tool_trace');
          });
          report.checks.otherMemberSharesOnlyDiscussion = true;
        });
        await stage('cross_project_account_and_project_scopes', async () => {
          const member = { ...f.alice, home: path.join(dir, 'Alice-foreign-device'), cwd: path.join(dir, 'Alice-foreign-workspace'), codexHome: path.join(dir, 'Alice-foreign-session') };
          for (const folder of [member.home, member.cwd, member.codexHome]) await mkdir(folder, { mode: 0o700 });
          await writeFile(path.join(member.home, 'auth.json'), await readFile(path.join(f.alice.home, 'auth.json')), { flag: 'wx', mode: 0o600 });
          await invokeTsp(member, ['project', 'bind', f.foreign.code]);
          const brief = await ok('POST', '/projects/' + f.foreign.code + '/memory/brief', member, { scope: 'personal' });
          check(brief.some(item => item.source === edited.revisionSource) && !brief.some(item => item.source === projectItem.source || item.source === opencodeItem?.source), 'cross_project_applicability_broken');
          await runDsh('alice-other-project', member, async ({ turn }) => {
            const result = await turn('换到这个项目后，我的变更说明风格与截图保存位置有哪些已知约定？请引用依据，没有现行记录的不要猜。');
            check(result.answer.includes(edited.revisionSource) && !/蓝杉|青禾/u.test(result.answer), 'agent_cross_project_private_isolation_failed');
            await turn('谢谢，此次不执行仓库操作。');
          });
          report.checks.accountExperienceFollowsOwnerProjectPreferenceDoesNot = true;
        });
        await stage('withdrawal_and_blank_agent_revalidation', async () => {
          const withdrawn = await invokeTsp(f.alice, ['memory', 'personal', 'withdraw', edited.source, '--expected-revision', String(edited.revision), '--reason', '本轮验证撤回']);
          check(withdrawn.status === 'withdrawn' && withdrawn.projection.operation === 'delete', 'withdrawal_state_missing');
          check((await readSource(f.alice, edited.revisionSource)).length === 0, 'withdrawn_source_still_valid');
          await drain();
          for (const version of withdrawn.history) check((await physical(f.alice, version.source)).status === 404, 'withdrawn_physical_copy_remains');
          const history = await manage(f.alice, edited.source); check(history.history.length >= 3 && history.projection.cleanupPending === false, 'owner_history_or_cleanup_state_missing');
          await runDsh('alice-after-withdraw', f.alice, async ({ turn, audit }) => {
            const result = await turn('我组织变更说明的通用排序习惯现在有什么有效依据？没有现行记录就说未知，不要猜测或执行仓库操作。');
            check(!result.answer.includes(edited.revisionSource) && !/先列出验证证据|先列验证|先.*中文.*概括/u.test(result.answer), 'blank_agent_reused_withdrawn_preference');
            const events = await audit(); check(!observed(events, edited.revisionSource) && !observed(events, accountItem.source), 'withdrawn_source_returned_in_blank_tool_trace');
            await turn('谢谢，维持未知即可，本次不执行操作。');
          });
          if (includeOpenCode) {
            const result = await runOpenCode({ member: f.alice, dir, prompt: '我组织变更说明的通用排序习惯有哪些现行依据？查不到就明确说未知。',
              system: execFileSync(process.execPath, [cli, 'memory', 'guidance', '--harness', 'opencode'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env: cleanEnv() }), mcpArgs: [cli, 'memory', 'mcp'] });
            report.sessions.push({ harness: 'opencode', label: 'alice-after-withdraw', emptySession: true, member: f.alice.code, ...result });
            check(!result.answer.includes(edited.revisionSource) && !/先列出验证证据|先列验证/u.test(result.answer), 'opencode_reused_withdrawn_preference');
          }
          report.checks.withdrawalRemovesSourceAndPhysicalCopies = true;
          report.checks.ownerOnlyHistoryPreserved = true;
        });
        await stage('physical_destination_and_semantic_attribution', async () => {
          const jobs = (await f.db.$client.query(`select f.state,j.engine,j.status from memory_projection_jobs j
            join memory_fragments f on f.id=j.fragment_id`)).rows;
          check(jobs.every(job => job.engine === (job.state === 'preference' ? 'openviking' : 'tencent')) && jobs.every(job => job.status === 'synced'), 'projection_destination_mismatch');
          const raw = await wiki('raw/ls', { wiki_id: binding.wiki_id });
          const contents = await wiki('raw/read', { wiki_id: binding.wiki_id, filenames: raw.items.map(item => item.filename) });
          check(contents.items.length === 1 && contents.items[0].content === corpus.discussion, 'private_content_or_wrong_source_in_shared_wiki');
          const coreResponse = await fetch(localBase(cfg.tencent.coreBaseUrl) + '/conversation/query', { method: 'POST', redirect: 'error',
            headers: { authorization: 'Bearer ' + cfg.tencent.token, 'x-tdai-service-id': cfg.tencent.serviceId,
              'x-tdai-session-id': 'tsp-query-' + binding.wiki_id, 'content-type': 'application/json' },
            body: JSON.stringify({ team_id: binding.engine_team_id, user_id: binding.engine_user_id, agent_id: binding.semantic_agent_id,
              task_id: 'tsp-wiki-' + binding.wiki_id, limit: 100 }), signal: AbortSignal.timeout(20000) });
          check(coreResponse.ok, 'public_core_verification_http_' + coreResponse.status);
          const core = await coreResponse.json();
          check(core.code === 0 && core.data.total === 1 && core.data.messages.length === 1 &&
            core.data.messages[0].content === corpus.discussion + '\n\n[tsp-evidence ' + binding.wiki_id + ' ' + discussionItem.source + ']', 'private_content_or_wrong_source_in_shared_core');
          const semanticQuery = '付款网关反复回调同一订单时应该怎样避免重复处理';
          check(!corpus.discussion.includes(semanticQuery), 'semantic_probe_was_literal');
          const search = await native('POST', f.root + '/memory/search', f.bob, { query: semanticQuery, scope: 'project' });
          check(search.data.some(item => item.source === discussionItem.source && item.state === 'discussed'), 'semantic_shared_recall_missing');
          check(search.retrieval === 'engine-and-platform' && search.matches[discussionItem.source]?.some(channel => channel === 'core' || channel === 'wiki'), 'semantic_shared_engine_attribution_missing');
          report.semanticProbe = { query: semanticQuery, source: discussionItem.source, channels: search.matches[discussionItem.source], retrieval: search.retrieval };
          report.checks.onlySharedDiscussionSentToTencent = true;
        });
      } catch (error) { failure = error; report.failure = safeFailure(error, report.phase); await save(); }
      finally {
        report.phase = 'verified_cleanup'; await save();
        const cleanupStep = async (name, work) => { try { await work(); } catch (error) { report.cleanup.errors.push(safeFailure(error, name)); } await save(); };
        if (app && base) await cleanupStep('private_record_cleanup', async () => {
          const personal = await invokeTsp(f.alice, ['memory', 'personal', 'list', '--status', 'all']);
          for (const item of personal.items) {
            check(roots.has(item.source), 'cleanup_private_root_not_owned');
            if (item.status === 'active') await invokeTsp(f.alice, ['memory', 'personal', 'withdraw', item.source, '--expected-revision', String(item.revision), '--reason', '隔离验证资源清理']);
          }
          await drain();
          for (const source of roots) { const item = await manage(f.alice, source); for (const version of item.history) check((await physical(f.alice, version.source)).status === 404, 'cleanup_private_body_remains'); }
          report.cleanup.personalBodiesRemoved = true;
        });
        if (app) await app.close();
        binding ??= await currentBinding();
        if (binding?.wiki_id) {
          await cleanupStep('core_records_cleanup', async () => {
            const shared = (await f.db.$client.query("select f.code,f.text from memory_fragments f where f.state in ('discussed','confirmed')")).rows;
            let removed = 0;
            for (const item of shared) {
              const scope = { team_id: binding.engine_team_id, user_id: binding.engine_user_id, agent_id: binding.semantic_agent_id,
                task_id: 'tsp-wiki-' + binding.wiki_id, session_id: 'tsp-' + binding.wiki_id + '-' + item.code };
              const core = async (operation, messageIds) => {
                const response = await fetch(localBase(cfg.tencent.coreBaseUrl) + '/conversation/' + operation, { method: 'POST', redirect: 'error',
                  headers: { authorization: 'Bearer ' + cfg.tencent.token, 'x-tdai-service-id': cfg.tencent.serviceId, 'x-tdai-session-id': scope.session_id, 'content-type': 'application/json' },
                  body: JSON.stringify({ ...scope, ...(operation === 'query' ? { limit: 100 } : { message_ids: messageIds }) }), signal: AbortSignal.timeout(20000) });
                check(response.ok, 'core_cleanup_http_' + response.status); const result = await response.json(); check(result.code === 0, 'core_cleanup_rejected'); return result.data;
              };
              const records = await core('query'); check(records.total === records.messages.length, 'core_cleanup_truncated');
              check(records.messages.every(record => Object.entries(scope).every(([key, value]) => record[key] === value) && record.role === 'assistant' &&
                record.content === item.text + '\n\n[tsp-evidence ' + binding.wiki_id + ' ' + item.code + ']'), 'core_cleanup_identity_mismatch');
              if (records.messages.length) { const deleted = await core('delete', records.messages.map(record => record.id)); check(deleted.deleted_count === records.messages.length, 'core_cleanup_count_mismatch'); removed += deleted.deleted_count; }
              check((await core('query')).total === 0, 'core_cleanup_not_empty');
            }
            report.cleanup.coreRecordsRemoved = true; report.cleanup.coreRemovedCount = removed;
          });
          await cleanupStep('wiki_cleanup', async () => {
            const detail = await wiki('get', { wiki_id: binding.wiki_id });
            check(detail.name === 'tsp-memory-' + f.projectCode && detail.team_id === cfg.projectProvisioning.teamId && detail.owner_user_id === cfg.projectProvisioning.userId, 'cleanup_wiki_identity_mismatch');
            check((await wiki('delete', { wiki_ids: [binding.wiki_id] })).deleted_ids.includes(binding.wiki_id), 'cleanup_wiki_delete_unconfirmed');
            check(await wiki('get', { wiki_id: binding.wiki_id }, true) === null, 'cleanup_wiki_still_visible'); report.cleanup.wikiRemoved = true;
          });
        }
        for (const owner of freshUsers) await cleanupStep('fresh_personal_user_cleanup', async () => {
          const result = await ov(adminUserPath(owner.userId), cfg.personalProvisioning.adminApiKey, 'GET', [404]);
          if (result.status === 404) { report.cleanup.users.push({ ...owner, alreadyAbsent: true, removed: true }); return; }
          check(result.data.user_id === owner.userId && result.data.role === 'user' && owner.initiallyAbsent && owner.userId === 'tsp_' + owner.principal.toLowerCase(), 'cleanup_user_identity_mismatch');
          const deleted = await ov(adminUserPath(owner.userId), cfg.personalProvisioning.adminApiKey, 'DELETE');
          check(deleted.status === 202 && typeof deleted.data.task_id === 'string', 'cleanup_user_task_missing');
          const evidence = { ...owner, taskId: deleted.data.task_id, removed: false }; report.cleanup.users.push(evidence); await save();
          const deadline = Date.now() + 360000;
          while (Date.now() < deadline) {
            const task = await ov('/api/v1/tasks/' + encodeURIComponent(evidence.taskId), cfg.personalProvisioning.adminApiKey);
            evidence.taskStatus = task.data.status;
            const gone = (await ov(adminUserPath(owner.userId), cfg.personalProvisioning.adminApiKey, 'GET', [404])).status === 404;
            if (task.data.status === 'completed' && gone) { evidence.removed = true; return; }
            check(!['failed', 'cancelled'].includes(task.data.status), 'cleanup_user_task_failed'); await delay(1000);
          }
          check(false, 'cleanup_user_task_deadline_exceeded');
        });
        report.cleanup.externalResourcesRemoved = report.cleanup.errors.length === 0 && report.cleanup.users.length === 2 && report.cleanup.users.every(user => user.removed) && report.cleanup.wikiRemoved && report.cleanup.coreRecordsRemoved;
        await save();
      }
    });
    report.cleanup.databaseRemoved = true;
  } catch (error) { failure ??= error; report.failure ??= safeFailure(error, report.phase); }
  finally { projectionObserver.restore(); await projectionObserver.flushed(); }
  report.finishedAt = new Date().toISOString(); report.phase = 'finished';
  report.mechanicalAccepted = !failure && report.cleanup.databaseRemoved && report.cleanup.externalResourcesRemoved &&
    ['noTaskOrBusinessObjectRequired', 'requirementUnchangedAndAdoptionNeedsClarification', 'sameChatUpdatesAndOldSourceInvalid',
      'freshChatUsesNewRevision', 'otherMemberSharesOnlyDiscussion', 'accountExperienceFollowsOwnerProjectPreferenceDoesNot',
      'withdrawalRemovesSourceAndPhysicalCopies', 'ownerOnlyHistoryPreserved', 'onlySharedDiscussionSentToTencent',
      ...(nativeCapture ? ['nativeDshAutomaticCapture', 'nativeDshSeedNotRecaptured', 'nativeOpenCodeAutomaticCapture',
        'nativeOpenCodePersistedRestartRecovery', 'nativeApiOfflineRetry', 'nativeUserOnlyEventMapping', 'controllerDidNotForwardTranscripts'] : [])]
      .every(key => report.checks[key] === true);
  await save(); return { report, output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--mcp-relay') await relay(process.argv[3], process.argv[4]);
  else {
    const { values } = parseArgs({ options: { 'run-id': { type: 'string' }, 'include-opencode': { type: 'boolean', default: false }, check: { type: 'boolean', default: false } } });
    if (values.check) {
      check(Object.values(corpus).every(text => text.length <= 4000) && new Set(Object.values(corpus)).size === 5, 'fixture_contract_invalid');
      const view = { source: '0'.repeat(20), revisionSource: '1'.repeat(20), status: 'active', text: corpus.account };
      const verified = { managementOnly: true, citationSourceField: 'revisionSource', currentSourcesVerified: true };
      check(auditMcpRows([{ items: [view] }, verified])[0]?.source === view.revisionSource &&
        auditMcpRows([view, verified])[0]?.source === view.revisionSource && auditMcpRows([view]).length === 0 &&
        auditMcpRows([{ ...view, status: 'withdrawn' }, verified]).length === 0, 'observer_management_contract_invalid');
      const shared = { source: '2'.repeat(20), state: 'discussed', scope: 'project' };
      check(sharedDiscussionFacts(shared.source, [shared], [shared]) &&
        !sharedDiscussionFacts(shared.source, [shared, { ...shared, state: 'confirmed' }], [shared]) &&
        !sharedDiscussionFacts(shared.source, [{ ...shared, state: 'implemented' }], [shared]) &&
        !sharedDiscussionFacts(shared.source, [shared], [{ ...shared, scope: 'personal' }]) &&
        !sharedDiscussionFacts(shared.source, [shared], []), 'implementation_fact_boundary_contract_invalid');
      console.log(JSON.stringify({ offlineOnly: true, serviceRequests: 0, modelRequests: 0, expectedModel: model,
        corpusHashes: Object.fromEntries(Object.entries(corpus).map(([name, text]) => [name, hash(text)])), liveEntrypointRequiresExplicitInvocation: true }));
    } else {
      const runId = values['run-id'] ?? new Date().toISOString().replace(/[-:.TZ]/gu, '') + '-' + randomBytes(4).toString('hex');
      const { report, output } = await runPersonalGovernance({ runId, includeOpenCode: values['include-opencode'] });
      console.log(JSON.stringify({ accepted: report.accepted, mechanicalAccepted: report.mechanicalAccepted, modelSemanticReview: report.modelSemanticReview.status,
        output, failure: report.failure ?? null, cleanupComplete: report.cleanup.externalResourcesRemoved && report.cleanup.databaseRemoved }));
      if (!report.mechanicalAccepted) process.exitCode = 1;
    }
  }
}

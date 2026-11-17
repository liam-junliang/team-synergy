// Small native projection diagnostic. No Agent or classifier is called;
// OpenViking retains its ordinary embedding/overview processing.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createMemorySliceUseCases, createPersonalMemoryUseCases } from '@team-synergy/application';
import { withNativeMemoryProject } from './native-memory-live.mjs';
import { loadMemoryEngines, projectNextMemory } from '../dist/memory-engines.js';
import { ensurePersonalMemoryResource } from '../dist/memory-personal-runtime.js';
import { installProjectionObserver } from './native-memory-projection-observer.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fixedText = '在所有项目中我习惯先用简短中文概括改动再列出验证结果。';
const runId = process.env.TSP_PERSONAL_PROJECTION_RUN_ID ?? '20261111-projection-diagnostic-a';
const iterations = Number(process.env.TSP_PROJECTION_DIAGNOSTIC_ITERATIONS ?? 3);
const injectTimeoutOnce = process.env.TSP_PROJECTION_INJECT_TIMEOUT === '1';
const root = fileURLToPath(new URL('../../../docs/experiments/personal-memory-governance/', import.meta.url));
const check = (condition, code) => { if (!condition) { const error = new Error(code); error.code = code; throw error; } };
const failure = error => ({ name: /^[A-Za-z0-9_.]{1,80}$/u.test(error?.name ?? '') ? error.name : 'Error',
  code: /^[A-Za-z0-9_:-]{1,100}$/u.test(error?.code ?? '') ? error.code : 'diagnostic_failed' });
check(/^[A-Za-z0-9_-]{6,96}$/u.test(runId), 'invalid_run_id');
check(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 3, 'bounded_iteration_count_required');
check(Boolean(process.env.TSP_TEST_DATABASE_URL && process.env.TSP_MEMORY_ENGINES_FILE), 'private_configuration_required');
const cfg = await loadMemoryEngines(process.env.TSP_MEMORY_ENGINES_FILE);
check(cfg.personalProvisioning && Object.keys(cfg.accounts).length === 0 && Object.keys(cfg.projects).length === 0, 'fresh_dynamic_mapping_required');
const ovBase = new URL(cfg.openviking.baseUrl);
check(ovBase.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(ovBase.hostname) && !ovBase.username && !ovBase.password, 'local_openviking_required');
const dir = path.join(root, runId); await mkdir(root, { recursive: true }); await mkdir(dir);
const output = path.join(dir, 'result.json');
const report = { schema: 'personal-projection-diagnostic/v1', runId, startedAt: new Date().toISOString(),
  agentModelCalls: 0, classifierCalls: 0, nativeEngineProcessing: 'unchanged OV embedding/overview pipeline',
  fixedTextHash: hash(fixedText), workerHash: hash(await readFile(new URL('../dist/memory-engines.js', import.meta.url))),
  injection: injectTimeoutOnce ? 'one real native write response withheld until original worker HTTP deadline' : 'none',
  iterations: [], requests: [], cleanupComplete: false };
const save = async () => { await writeFile(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); await rename(output + '.tmp', output); };
let iterationNumber = 0, phase = 'setup';
const observer = installProjectionObserver({ baseUrls: [cfg.openviking.baseUrl], entries: report.requests,
  context: () => ({ iteration: iterationNumber, phase }), save, injectTimeoutOnce });
const ov = async (route, key, method = 'GET', allowed = []) => {
  const response = await fetch(ovBase.href.replace(/\/$/u, '') + route, { method, headers: { 'x-api-key': key }, redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (allowed.includes(response.status)) { await response.arrayBuffer(); return { status: response.status, data: null }; }
  check(response.ok, 'ov_http_' + response.status); const value = await response.json(); check(value.status === 'ok', 'ov_envelope_invalid'); return { status: response.status, data: value.result };
};
function submittedBody(raw) {
  if (typeof raw !== 'string') return null;
  const trailer = /\n\n<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->$/u.exec(raw);
  if (!trailer) return raw;
  const fields = JSON.parse(trailer[1]);
  return Number.isSafeInteger(fields.version) && fields.version > 0 ? raw.slice(0, trailer.index) : raw;
}
try {
  process.env.TSP_MEMORY_ENABLED = '1'; process.env.ACP_ALLOW_LEGACY_IDENTITY = '0';
  for (iterationNumber = 1; iterationNumber <= iterations; iterationNumber++) {
    const item = { iteration: iterationNumber, attempts: [], readbacks: [], cleanup: {}, firstAttemptFailed: false }; report.iterations.push(item); await save();
    await withNativeMemoryProject({ project: 'Native personal projection diagnostic' }, async f => {
      const userId = 'tsp_' + f.alice.code.toLowerCase(), adminPath = '/api/v1/admin/accounts/' + encodeURIComponent(cfg.personalProvisioning.accountId) + '/users/' + userId;
      let created = false, source, account;
      const personal = createPersonalMemoryUseCases(f.db);
      const readback = async () => {
        const uri = 'viking://user/' + userId + '/memories/preferences/team-synergy/' + source + '.json';
        const result = await ov('/api/v1/content/read?uri=' + encodeURIComponent(uri), account.apiKey, 'GET', [404]);
        const expected = JSON.stringify({ source, applicability: 'account', text: fixedText });
        const body = submittedBody(result.data);
        const evidence = { status: result.status, expectedHash: hash(expected), actualBodyHash: body === null ? null : hash(body), verified: body === expected };
        item.readbacks.push({ at: new Date().toISOString(), ...evidence }); await save(); return evidence;
      };
      try {
        phase = 'preflight';
        check((await ov(adminPath, cfg.personalProvisioning.adminApiKey, 'GET', [404])).status === 404, 'user_preexisted');
        created = true; item.user = { userId, principal: f.alice.code, initiallyAbsent: true };
        phase = 'provision'; const provisionStarted = performance.now(); account = await ensurePersonalMemoryResource(cfg, f.alice.code); item.provisionMs = Math.round(performance.now() - provisionStarted);
        phase = 'capture_fixture_no_classifier';
        const receipt = await createMemorySliceUseCases(f.db).capture({ principalCode: f.alice.code, projectCode: f.projectCode,
          sessionId: 'native-projection-diagnostic', eventId: 'fixed-preference', sourceText: fixedText, parts: [{ kind: 'preference', text: fixedText }] });
        source = receipt.items[0]?.source; check(source && receipt.items[0].scope === 'personal', 'fixture_source_invalid'); item.source = source;
        for (let attempt = 1; attempt <= 2; attempt++) {
          phase = 'upsert_attempt_' + attempt; const started = performance.now();
          const result = await projectNextMemory(f.db, cfg); item.attempts.push({ at: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), ...result });
          if (attempt === 1) item.firstAttemptFailed = result?.status !== 'synced';
          phase = 'readback_after_attempt_' + attempt; const body = await readback();
          if (result?.status === 'synced') { check(body.verified, 'synced_body_mismatch'); item.eventuallySynced = true; break; }
          check(result?.status === 'needs_reconcile', 'unexpected_projection_status');
          const job = (await f.db.$client.query(`select attempts,status,last_error,extract(epoch from (lease_until-now()))*1000 as wait_ms
            from memory_projection_jobs where fragment_id=(select id from memory_fragments where code=$1)`, [source])).rows[0];
          item.retry = { status: job.status, attempts: job.attempts, errorCode: job.last_error, waitMs: Math.max(0, Math.ceil(Number(job.wait_ms))) };
          check(item.retry.waitMs <= 35000, 'retry_lease_exceeds_diagnostic_bound');
          if (attempt < 2) { phase = 'honoring_production_retry_lease'; await save(); await delay(item.retry.waitMs + 100); }
        }
        check(item.eventuallySynced === true, 'projection_retry_not_completed');
        if (injectTimeoutOnce && iterationNumber === 1) check(item.firstAttemptFailed && item.attempts.length === 2 &&
          report.requests.some(request => request.injection && request.failure?.name === 'TimeoutError' && request.signalAborted), 'injected_deadline_not_verified');
      } catch (error) { item.failure = failure(error); }
      finally {
        phase = 'cleanup';
        try {
          if (source) {
            const current = await personal.read({ principalCode: f.alice.code, source });
            await personal.withdraw({ principalCode: f.alice.code, source, expectedRevision: current.revision, reason: 'isolated diagnostic cleanup' });
            const deadline = Date.now() + 90000;
            while (Date.now() < deadline) {
              const remaining = (await f.db.$client.query("select count(*)::int n from memory_projection_jobs where status<>'synced'")).rows[0].n;
              if (!remaining) break;
              const result = await projectNextMemory(f.db, cfg); item.cleanup.jobs ??= []; if (result) item.cleanup.jobs.push(result);
              await delay(500);
            }
            check((await readback()).status === 404, 'cleanup_source_still_readable'); item.cleanup.body404 = true;
          }
          if (created) {
            const present = await ov(adminPath, cfg.personalProvisioning.adminApiKey, 'GET', [404]);
            if (present.status !== 404) {
              check(present.data.user_id === userId && present.data.role === 'user', 'cleanup_user_identity_mismatch');
              const removed = await ov(adminPath, cfg.personalProvisioning.adminApiKey, 'DELETE'); check(removed.status === 202 && removed.data.task_id, 'cleanup_user_task_missing');
              item.cleanup.taskId = removed.data.task_id;
              const deadline = Date.now() + 360000;
              while (Date.now() < deadline) {
                const task = await ov('/api/v1/tasks/' + item.cleanup.taskId, cfg.personalProvisioning.adminApiKey);
                item.cleanup.taskStatus = task.data.status;
                if (task.data.status === 'completed' && (await ov(adminPath, cfg.personalProvisioning.adminApiKey, 'GET', [404])).status === 404) { item.cleanup.user404 = true; break; }
                check(!['failed', 'cancelled'].includes(task.data.status), 'cleanup_user_task_failed'); await delay(1000);
              }
              check(item.cleanup.user404, 'cleanup_user_deadline_exceeded');
            } else item.cleanup.user404 = true;
          }
        } catch (error) { item.cleanup.failure = failure(error); }
        delete cfg.accounts[f.alice.code]; await save();
      }
    });
    item.cleanup.databaseRemoved = true; await save();
    if (item.failure || item.cleanup.failure) break;
  }
} catch (error) { report.failure = failure(error); }
finally { observer.restore(); await observer.flushed(); }
report.finishedAt = new Date().toISOString(); report.cleanupComplete = report.iterations.every(item => item.cleanup.databaseRemoved && item.cleanup.user404 && (!item.source || item.cleanup.body404));
report.summary = { iterations: report.iterations.length, firstAttemptFailures: report.iterations.filter(item => item.firstAttemptFailed).length,
  eventuallySynced: report.iterations.filter(item => item.eventuallySynced).length,
  failedRequests: report.requests.filter(request => request.failure || request.bodyFailure).map(request => ({ iteration: request.iteration, phase: request.phase,
    operation: request.operation, status: request.status ?? null, elapsedMs: request.elapsedMs ?? request.bodyMs, failure: request.failure ?? request.bodyFailure })) };
await save(); console.log(JSON.stringify({ output, summary: report.summary, cleanupComplete: report.cleanupComplete }));
if (report.failure || !report.cleanupComplete || report.iterations.some(item => item.failure || item.cleanup.failure)) process.exitCode = 1;

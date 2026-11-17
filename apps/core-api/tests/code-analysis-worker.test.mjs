import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodeAnalysisWorker } from '../dist/code-analysis-worker.js';

const ok = data => ({ ok: true, data });
const expired = { ok: false, error: { code: 'code_understanding_execution_expired', message: 'Expired' } };
const plugins = [{ plugin_id: 'ua' }, { plugin_id: 'codegraph' }];
const job = { jobCode: 'job', projectCode: 'project', executionToken: 'lease', repository: { code: 'repo', name: 'Repo', remote_url: 'https://example.invalid/repo.git', default_branch: 'main' } };
const output = { artifact: { source: 'fixed' }, plugins, execution_metadata: { runner: 'server_git', commit: 'fixed-commit' } };
function fixture(storeOverrides = {}, runtimeOverrides = {}) {
  let claimed = false;
  const calls = { attach: [], progress: [], complete: [], fail: [], execute: [], errors: [] };
  const store = {
    recoverExpiredJobs: async () => ok({ recovered: 0 }),
    claimNextJob: async () => { if (claimed) return ok(null); claimed = true; return ok(job); },
    attachRun: async value => { calls.attach.push(value); return ok({ code: 'run', plugins }); },
    progressJob: async value => { calls.progress.push(value); return ok({ code: 'run' }); },
    heartbeatJob: async () => ok({ active: true }),
    completeJob: async value => { calls.complete.push(value); return ok({}); },
    failJob: async value => { calls.fail.push(value); return ok({ failed: true }); },
    ...storeOverrides,
  };
  const runtime = {
    status: () => ({ configured: true, plugins }),
    execute: async (input, options) => { calls.execute.push(input); await options.onSnapshot({ snapshot_id: 'fixed' }); return output; },
    ...runtimeOverrides,
  };
  const worker = createCodeAnalysisWorker({ store, runtime, pollMs: 5, heartbeatMs: 10, onError: code => calls.errors.push(code) });
  return { calls, worker };
}
async function until(predicate) { for (let i = 0; i < 120; i++) { if (predicate()) return; await delay(5); } assert.fail('Hosted worker did not settle'); }

test('worker publishes only the fixed repository result with its lease and actual runtime metadata', async () => {
  const { calls, worker } = fixture();
  worker.start(); worker.start();
  await until(() => calls.complete.length === 1); await worker.stop();
  assert.deepEqual(calls.execute, [{ jobCode: job.jobCode, projectCode: job.projectCode, repository: job.repository }]);
  assert.deepEqual(calls.progress.map(row => row.status), ['indexing', 'validating']);
  assert.equal(calls.complete[0].executionToken, 'lease');
  assert.equal(calls.complete[0].runCode, 'run');
  assert.deepEqual(calls.complete[0].executionMetadata, output.execution_metadata);
  assert.equal(calls.fail.length, 0);
});

test('disabled runtime cannot claim paid or filesystem work', async () => {
  let claimed = 0;
  const { worker } = fixture({ claimNextJob: async () => { claimed++; return ok(job); } }, { status: () => ({ configured: false, plugins: [] }) });
  worker.start(); await delay(25); await worker.stop(); assert.equal(claimed, 0);
});

test('concurrent semantic batches serialize persistent progress before publication', async () => {
  let inFlight = 0, maximum = 0;
  const updates = [];
  const { calls, worker } = fixture({ progressJob: async input => {
    inFlight++; maximum = Math.max(maximum, inFlight); await delay(5); updates.push(input); inFlight--; return ok({ code: 'run' });
  } }, { execute: async (_input, { onSnapshot, onProgress }) => {
    await onSnapshot({ snapshot_id: 'fixed' });
    await Promise.all([1, 2, 3].map(completed => onProgress({ phase: 'files', completed, total: 3, completed_segments: completed, total_segments: 3, cached_segments: 0, completed_files: completed, total_files: 3 })));
    return output;
  } });
  worker.start(); await until(() => calls.complete.length === 1); await worker.stop();
  assert.equal(maximum, 1);
  assert.deepEqual(updates.map(row => row.status), ['indexing', 'awaiting_agent', 'awaiting_agent', 'awaiting_agent', 'validating']);
  assert.match(updates[3].message, /全仓文件分析 3\/3；分段 3\/3；文件 3\/3/);
});

test('publication waits for pending progress even when an executor returns without awaiting callbacks', async () => {
  const { calls, worker } = fixture({ progressJob: async input => {
    if (input.status === 'awaiting_agent') { await delay(20); return expired; }
    return ok({ code: 'run' });
  } }, { execute: async (_input, { onProgress }) => {
    void onProgress({ phase: 'review', completed: 1, total: 1, completed_segments: 1, total_segments: 1, cached_segments: 0, completed_files: 1, total_files: 1 }).catch(() => undefined);
    return output;
  } });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(calls.complete.length, 0);
});

test('a lost heartbeat aborts execution and blocks a late semantic result', async () => {
  let aborted = false;
  const { calls, worker } = fixture({ heartbeatJob: async () => expired }, {
    execute: async (_input, { signal }) => { await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return output; },
  });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(aborted, true); assert.equal(calls.complete.length, 0);
});

test('shutdown aborts active Git/model work and waits before DB shutdown', async () => {
  let started = false;
  const { calls, worker } = fixture({}, { execute: async (_input, { signal }) => { started = true; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw Error('Cancelled'); } });
  worker.start(); await until(() => started); await worker.stop();
  assert.equal(calls.fail.length, 1); assert.equal(calls.complete.length, 0);
});

test('a source revocation acknowledged by heartbeat still aborts late work', async () => {
  const { calls, worker } = fixture({ heartbeatJob: async () => ok({ active: false }) }, {
    execute: async (_input, { signal }) => { await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return output; },
  });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(calls.complete.length, 0);
});

test('a source progress rejection stops analysis before publication', async () => {
  const { calls, worker } = fixture({ progressJob: async () => expired });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(calls.complete.length, 0);
});

test('engine drift and invalid publication leave a terminal failure instead of updating the mainline', async () => {
  const { calls, worker } = fixture({}, { execute: async () => ({ ...output, plugins: [] }) });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(calls.complete.length, 0);
  const rejected = fixture({ completeJob: async () => ({ ok: false, error: { code: 'code_understanding_invalid', message: 'Invalid graph' } }) });
  rejected.worker.start(); await until(() => rejected.calls.fail.length === 1); await rejected.worker.stop();
  assert.deepEqual(rejected.calls.errors, ['code_understanding_invalid']);
});

test('unexpected transport errors never expose secrets or server paths in public job errors', async () => {
  const { calls, worker } = fixture({}, { execute: async () => { throw Error('https://user:secret@host; C:/server/private; postgres://db'); } });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.doesNotMatch(calls.fail[0].message, /secret|postgres|C:|user/);
});

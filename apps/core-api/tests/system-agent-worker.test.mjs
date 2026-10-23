import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSystemAgentWorker } from '../dist/system-agent-worker.js';
import { loadSystemAgentGuidance } from '../dist/system-agent-guidance.js';

const metadata = { engine: 'dsh', engine_version: 'fixture', model: 'fixture', skill_version: '2.1.0', skill_sha256: 'snapshot-hash' };
const job = { job_code: 'job', execution_token: 'lease', document_code: 'doc', base_revision: 3, base_title: 'Title', base_summary: 'Summary', base_content: 'Document', instruction: 'Change', quote: 'Document' };
const proposal = { title: 'Title', summary: 'Summary', content: 'Draft', rationale: 'Requested', evidence: ['document:doc@3'], warnings: [] };
const ok = data => ({ ok: true, data });
const denied = { ok: false, error: { code: 'system_agent_execution_expired', message: 'Cancelled' } };

function fixture(overrides = {}) {
  let claimed = false;
  const calls = { claim: [], complete: [], fail: [], recovery: 0 };
  const store = {
    recoverExpiredJobs: async () => { calls.recovery++; return ok({ recovered: 0 }); },
    claimNextJob: async input => { calls.claim.push(input); if (claimed) return ok(null); claimed = true; return ok(job); },
    heartbeatJob: async () => ok({ active: true }),
    completeJob: async input => { calls.complete.push(input); return ok({}); },
    failJob: async input => { calls.fail.push(input); return ok({ failed: true }); },
    ...overrides,
  };
  return { store, calls };
}
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5); } assert.fail('Worker did not settle'); }

test('worker snapshots only document data, records actual execution metadata and never adopts drafts', async () => {
  const { store, calls } = fixture();
  let supplied;
  const runtime = { generate: async input => { supplied = input; await delay(20); return proposal; } };
  const worker = createSystemAgentWorker({ store, runtime, guidance: 'Fixed Skill', executionMetadata: metadata, pollMs: 2 });
  worker.start(); worker.start();
  await until(() => calls.complete.length === 1); await worker.stop();
  assert.equal(calls.complete[0].executionToken, 'lease');
  assert.equal(calls.complete[0].proposal, proposal);
  assert.deepEqual(calls.claim[0].executionMetadata, metadata);
  assert.deepEqual(supplied, { jobCode: 'job', document: { code: 'doc', revision: 3, title: 'Title', summary: 'Summary', content: 'Document' }, instruction: 'Change', quote: 'Document', guidance: 'Fixed Skill' });
  assert.equal(calls.fail.length, 0);
});

test('a cancelled or revoked heartbeat aborts execution and blocks a late candidate', async () => {
  const { store, calls } = fixture({ heartbeatJob: async () => denied });
  let aborted = false;
  const runtime = { generate: async (_input, { signal }) => { await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return proposal; } };
  const worker = createSystemAgentWorker({ store, runtime, guidance: '', executionMetadata: metadata, heartbeatMs: 5 });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.equal(aborted, true); assert.equal(calls.complete.length, 0);
});

test('invalid candidate receipt fails the running job instead of leaving it in progress', async () => {
  const { store, calls } = fixture({ completeJob: async () => ({ ok: false, error: { code: 'system_agent_proposal_invalid', message: 'Invalid' } }) });
  const errors = [];
  const worker = createSystemAgentWorker({ store, runtime: { generate: async () => proposal }, guidance: '', executionMetadata: metadata, onError: code => errors.push(code) });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.deepEqual(errors, ['system_agent_proposal_invalid']);
});

test('shutdown aborts active work and waits for settlement before releasing the database', async () => {
  const { store, calls } = fixture();
  let started = false;
  const runtime = { generate: async (_input, { signal }) => { started = true; await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); throw new Error('Execution cancelled'); } };
  const worker = createSystemAgentWorker({ store, runtime, guidance: '', executionMetadata: metadata });
  worker.start(); await until(() => started); await worker.stop();
  assert.equal(calls.fail.length, 1); assert.equal(calls.complete.length, 0);
});

test('packaged Skill is present, bounded and hash validated for every server instance', () => {
  const guidance = loadSystemAgentGuidance();
  assert.equal(guidance.version, '2.1.0');
  assert.match(guidance.sha256, /^[a-f0-9]{64}$/);
  assert.ok(guidance.guidance.includes('Specification production'));
  assert.ok(guidance.guidance.includes('--- references/specification.md ---'));
});

test('unexpected infrastructure exceptions cannot leak connection details into job errors', async () => {
  const { store, calls } = fixture();
  const worker = createSystemAgentWorker({ store, runtime: { generate: async () => { throw new Error('postgres://user:secret@host/db'); } }, guidance: '', executionMetadata: metadata });
  worker.start(); await until(() => calls.fail.length === 1); await worker.stop();
  assert.doesNotMatch(calls.fail[0].message, /postgres|secret|host/);
  assert.match(calls.fail[0].message, /联系平台管理员/);
});

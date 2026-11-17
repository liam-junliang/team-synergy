import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '@team-synergy/domain';
import { createSystemAgentUseCases } from '../dist/index.js';

const sensitiveFailure = 'SELECT private_document FROM system_agent_jobs; password=must-not-leak; source=private-body';
const unavailable = { ok: false, error: { code: 'internal_error', message: '系统 Agent 暂时无法完成操作，请稍后重试' } };
const actor = { jobCode: 'test-job', principalCode: 'test-user' };
const execution = { jobCode: 'test-job', executorId: 'test-worker', executionToken: 'test-token' };
const proposal = { title: 'Title', summary: '', content: '# Content', rationale: 'Based on current source', evidence: [], warnings: [] };

function failingDb(cause) {
  return {
    select() { throw cause; },
    transaction() { throw cause; },
  };
}

test('all system-agent result boundaries redact non-domain driver exceptions', async () => {
  const uc = createSystemAgentUseCases(failingDb(new Error(sensitiveFailure)));
  const results = await Promise.all([
    uc.getJob(actor),
    uc.listJobs({ projectCode: 'test-project', principalCode: 'test-user' }),
    uc.createJob({ projectCode: 'test-project', principalCode: 'test-user', documentCode: 'test-document', baseRevision: 1, instruction: 'Clarify purpose', requestKey: 'test-request' }),
    uc.applyJob({ ...actor, baseRevision: 1, proposalHash: 'test-hash' }),
    uc.cancelJob(actor), uc.rejectJob(actor),
    uc.claimNextJob({ executorId: 'test-worker' }),
    uc.heartbeatJob(execution),
    uc.completeJob({ ...execution, proposal }),
    uc.failJob({ ...execution, message: 'Execution stopped' }),
    uc.recoverExpiredJobs(),
  ]);
  for (const result of results) {
    assert.deepEqual(result, unavailable);
    assert.doesNotMatch(JSON.stringify(result), /SELECT|password|must-not-leak|private-body/);
  }
});

test('system-agent domain errors retain actionable code/message without arbitrary details', async () => {
  const uc = createSystemAgentUseCases(failingDb(new DomainError('project_forbidden', '当前项目权限不足', { debug: sensitiveFailure })));
  assert.deepEqual(await uc.getJob(actor), { ok: false, error: { code: 'project_forbidden', message: '当前项目权限不足' } });
});

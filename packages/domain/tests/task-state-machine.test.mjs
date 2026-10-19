import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canTransition,
  assertTransition,
  transitionOrThrow,
} from '../dist/task-state-machine.js';

const selfTest = { type: 'self_test', result: 'pass' };
const verifier = { type: 'verifier_review', result: 'pass' };

function ctx(overrides = {}) {
  return {
    task: { acceptance: [{ id: 'AC-1', text: '验收标准' }] },
    evidence: { selfTestEvidence: [], verifierEvidence: [], artifactCount: 0 },
    profile: 'builder',
    ...overrides,
  };
}

test('状态机：主路径 draft → ready → assigned → running → self_tested → submitted → verified → closed（带 guard）', () => {
  const path = ['draft', 'ready', 'assigned', 'running', 'self_tested', 'submitted', 'verified', 'closed'];
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    assert.equal(canTransition(from, to), true, `${from} → ${to} 应合法`);
  }
  // 带 guard 的完整走查（按阶段补上下文）
  transitionOrThrow('draft', 'ready', ctx());
  transitionOrThrow('ready', 'assigned', ctx());
  transitionOrThrow('assigned', 'running', ctx({ activeRun: true }));
  transitionOrThrow('running', 'self_tested', ctx({ evidence: { selfTestEvidence: [selfTest], verifierEvidence: [], artifactCount: 0 } }));
  transitionOrThrow('self_tested', 'submitted', ctx({ evidence: { selfTestEvidence: [selfTest], verifierEvidence: [], artifactCount: 1 } }));
  transitionOrThrow('submitted', 'verified', ctx({ profile: 'verifier', evidence: { selfTestEvidence: [], verifierEvidence: [verifier], artifactCount: 1 } }));
  transitionOrThrow('verified', 'closed', ctx({ profile: 'verifier' }));
});

test('状态机：closed 是终态；无未确认的旁路转换（review 重要项 2）', () => {
  assert.equal(canTransition('closed', 'draft'), false);
  assert.equal(canTransition('draft', 'failed'), false);
  assert.equal(canTransition('assigned', 'ready'), false);
  assert.equal(canTransition('self_tested', 'running'), false);
  assert.equal(canTransition('submitted', 'running'), false);
});

test('状态机：blocked / failed 旁路（running 进入，回到 ready）', () => {
  assert.equal(canTransition('running', 'blocked'), true);
  assert.equal(canTransition('running', 'failed'), true);
  assert.equal(canTransition('blocked', 'ready'), true);
  assert.equal(canTransition('failed', 'ready'), true);
});

test('状态机：未执行任务可取消，执行开始后不能取消', () => {
  for (const status of ['draft', 'ready', 'assigned']) {
    assert.equal(canTransition(status, 'cancelled'), true, `${status} → cancelled 应合法`);
    assert.doesNotThrow(() => transitionOrThrow(status, 'cancelled', ctx()));
  }
  assert.equal(canTransition('running', 'cancelled'), false);
  assert.equal(canTransition('cancelled', 'draft'), false);
});

test('非法转换抛错', () => {
  assert.throws(() => assertTransition('draft', 'verified'));
  assert.throws(() => assertTransition('closed', 'draft'));
});

test('guard：没有验收标准不能 ready（不变量 2）', () => {
  assert.throws(
    () => transitionOrThrow('draft', 'ready', ctx({ task: { acceptance: [] } })),
    (e) => e.code === 'acceptance_required',
  );
});

test('guard：assigned → running 必须有活动 Run', () => {
  assert.throws(
    () => transitionOrThrow('assigned', 'running', ctx({ activeRun: false })),
    (e) => e.code === 'run_required',
  );
});

test('guard：running → blocked 必须提供原因', () => {
  assert.throws(
    () => transitionOrThrow('running', 'blocked', ctx()),
    (e) => e.code === 'block_reason_required',
  );
  assert.doesNotThrow(() => transitionOrThrow('running', 'blocked', ctx({ blockReason: '等待接口契约确认' })));
});

test('guard：self_tested 需要自测证据（不变量 5）', () => {
  assert.throws(
    () => transitionOrThrow('running', 'self_tested', ctx()),
    (e) => e.code === 'self_test_evidence_required',
  );
});

test('guard：submitted 需要 Artifact + 自测证据', () => {
  assert.throws(
    () => transitionOrThrow('self_tested', 'submitted', ctx({ evidence: { selfTestEvidence: [selfTest], verifierEvidence: [], artifactCount: 0 } })),
    (e) => e.code === 'artifact_required',
  );
});

test('guard：verified 需要验证证据，且 Builder 不能自行 verified / closed', () => {
  assert.throws(
    () => transitionOrThrow('submitted', 'verified', ctx()),
    (e) => e.code === 'verifier_evidence_required',
  );
  assert.throws(
    () =>
      transitionOrThrow('submitted', 'verified', ctx({
        profile: 'builder',
        evidence: { selfTestEvidence: [], verifierEvidence: [verifier], artifactCount: 1 },
      })),
    (e) => e.code === 'builder_terminal_forbidden',
  );
});

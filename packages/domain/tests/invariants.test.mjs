import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError,
  assertAuditedChange,
  toAuditEvent,
  assertRunBindings,
  assertExplicitPublication,
  isProjectStateArtifact,
  assertIdentityImmutable,
  cleanupDecision,
  assertRecyclable,
  deriveView,
  assertNodeIntegrity,
  assertPermissionFilter,
  projectSubgraph,
  assertDeltaBase,
  assertDeltaChanges,
} from '../dist/index.js';

// ---- 不变量 1：审计 ----
test('不变量 1：缺 principal_id 的变更被拒绝', () => {
  assert.throws(
    () => assertAuditedChange({ entity_type: 'task', entity_id: 1n, principal_id: 0n, base_snapshot: 1, action: 'x' }),
    (e) => e instanceof DomainError && e.code === 'principal_required',
  );
});

test('不变量 1：缺 base_snapshot 的变更被拒绝', () => {
  assert.throws(
    () => assertAuditedChange({ entity_type: 'task', entity_id: 1n, principal_id: 2n, action: 'x' }),
    (e) => e instanceof DomainError && e.code === 'base_snapshot_required',
  );
});

test('不变量 1：合法命令生成完整审计事件', () => {
  const evt = toAuditEvent(
    {
      entity_type: 'task',
      entity_id: 1n,
      from: 'running',
      to: 'self_tested',
      principal_id: 2n,
      run_id: 3n,
      base_snapshot: 28,
      action: 'task.status_changed',
    },
    '00000000000000000004',
    '2026-08-13T10:00:00Z',
  );
  assert.equal(evt.principal_id, 2n);
  assert.equal(evt.run_id, 3n);
  assert.equal(evt.base_snapshot, 28);
  assert.equal(evt.from, 'running');
  assert.equal(evt.to, 'self_tested');
});

// ---- 不变量 3：Run 绑定 ----
test('不变量 3：Run 缺 Task/Profile/Workspace 绑定分别被拒绝', () => {
  assert.throws(
    () => assertRunBindings({ run_id: 1n, task_id: 0n, profile: 'builder', workspace_id: 3n }),
    (e) => e.code === 'run_task_required',
  );
  assert.throws(
    () => assertRunBindings({ run_id: 1n, task_id: 2n, profile: undefined, workspace_id: 3n }),
    (e) => e.code === 'run_profile_required',
  );
  assert.throws(
    () => assertRunBindings({ run_id: 1n, task_id: 2n, profile: 'builder', workspace_id: 0n }),
    (e) => e.code === 'run_workspace_required',
  );
});

// ---- 不变量 4：Artifact 显式发布 ----
test('不变量 4：未发布 Artifact 不属于项目状态', () => {
  const unpublished = { artifact_code: '00000000000000000005', published: false, uri: 'file://x' };
  assert.equal(isProjectStateArtifact(unpublished), false);
  assert.throws(() => assertExplicitPublication(unpublished), (e) => e.code === 'artifact_not_published');
  assert.equal(isProjectStateArtifact({ artifact_code: '00000000000000000006', published: true, uri: 'git:a92f81c' }), true);
});

// ---- 不变量 6：Run 身份不可覆盖 ----
test('不变量 6：请求参数覆盖 Run 身份被拒绝', () => {
  const ctx = { run_code: '00000000000000000007', task_code: '00000000000000000008', profile: 'builder' };
  assert.throws(
    () => assertIdentityImmutable(ctx, { run_code: '00000000000000000009' }),
    (e) => e.code === 'run_identity_override' && e.details.requested_run_code === '00000000000000000009',
  );
  assert.doesNotThrow(() => assertIdentityImmutable(ctx, { run_code: '00000000000000000007' }));
  assert.doesNotThrow(() => assertIdentityImmutable(ctx, {}));
});

// ---- 不变量 7：工作区清理 ----
test('不变量 7：被引用 → block；未提交且未存 Patch → require_patch；否则 recyclable', () => {
  assert.equal(cleanupDecision({ referencedByActive: ['TASK-301'], hasUncommittedChanges: false, patchSaved: false }), 'block');
  assert.equal(cleanupDecision({ referencedByActive: [], hasUncommittedChanges: true, patchSaved: false }), 'require_patch');
  assert.equal(cleanupDecision({ referencedByActive: [], hasUncommittedChanges: true, patchSaved: true }), 'recyclable');
  assert.equal(cleanupDecision({ referencedByActive: [], hasUncommittedChanges: false, patchSaved: false }), 'recyclable');
  assert.throws(
    () => assertRecyclable({ referencedByActive: [], hasUncommittedChanges: true, patchSaved: false }),
    (e) => e.code === 'cleanup_patch_required',
  );
});

// ---- 不变量 8：状态派生 ----
test('不变量 8：展示视图全部由事实派生', () => {
  assert.equal(deriveView({ status: 'running', hasActiveRun: true, selfTestEvidence: [], verifierEvidence: [], artifacts: [] }), 'working');
  assert.equal(deriveView({ status: 'submitted', hasActiveRun: false, selfTestEvidence: [], verifierEvidence: [], artifacts: [] }), 'waiting_review');
  assert.equal(deriveView({ status: 'blocked', hasActiveRun: false, selfTestEvidence: [], verifierEvidence: [], artifacts: [] }), 'blocked');
  assert.equal(deriveView({ status: 'verified', hasActiveRun: false, selfTestEvidence: [], verifierEvidence: [], artifacts: [], ciFailed: true }), 'ci_failed');
  assert.equal(deriveView({ status: 'closed', hasActiveRun: false, selfTestEvidence: [], verifierEvidence: [], artifacts: [] }), 'closed');
});

// ---- 不变量 9：节点完整性 ----
test('不变量 9：无来源节点被拒绝', () => {
  assert.throws(
    () => assertNodeIntegrity({ node_id: 'N1', kind: 'business_rule', verification: 'inferred', freshness: 'current', sources: [] }),
    (e) => e.code === 'node_source_required',
  );
});

test('不变量 9：纯扫描来源不能 confirmed', () => {
  assert.throws(
    () =>
      assertNodeIntegrity({
        node_id: 'N2',
        kind: 'business_rule',
        verification: 'confirmed',
        freshness: 'current',
        sources: [{ kind: 'scan', uri: 'x', revision: '1' }],
      }),
    (e) => e.code === 'scan_cannot_confirm',
  );
  assert.doesNotThrow(() =>
    assertNodeIntegrity({
      node_id: 'N3',
      kind: 'business_rule',
      verification: 'confirmed',
      freshness: 'current',
      sources: [{ kind: 'discussion', uri: 'doc:REQ-0142', revision: '3' }],
    }),
  );
});

// ---- 不变量 10：先过滤后遍历，隐藏节点不泄露 ----
test('不变量 10：投影必须先权限过滤再遍历；隐藏节点不出现', () => {
  const nodes = [
    { node_id: 'A', kind: 'feature' },
    { node_id: 'B', kind: 'service' },
    { node_id: 'SECRET', kind: 'service' },
  ];
  const edges = [
    { from: 'A', to: 'B', relation: 'contains' },
    { from: 'A', to: 'SECRET', relation: 'contains' },
  ];
  const req = { focus_nodes: ['A'], depth: 1, isVisible: (id) => id !== 'SECRET' };
  const result = projectSubgraph(nodes, edges, req);
  assert.deepEqual(result.nodes.map((n) => n.node_id).sort(), ['A', 'B']);
  assert.deepEqual(result.edges.map((e) => e.to), ['B']);
  assert.equal(result.filteredCount, 1);
});

test('不变量 10：缺权限过滤函数被拒绝', () => {
  assert.throws(
    () => assertPermissionFilter({ focus_nodes: ['A'], depth: 1, isVisible: undefined }),
    (e) => e.code === 'permission_filter_required',
  );
});

// ---- 不变量 11：Graph Delta ----
test('不变量 11：base snapshot 不匹配被拒绝', () => {
  const delta = { delta_code: '00000000000000000010', base_graph_snapshot: 27, run_code: '00000000000000000007', changes: [] };
  assert.throws(
    () => assertDeltaBase(delta, 28),
    (e) => e.code === 'delta_base_mismatch' && e.details.delta_base === 27,
  );
  assert.doesNotThrow(() => assertDeltaBase(delta, 27));
});

test('不变量 11：扫描来源的变更不能 confirmed', () => {
  const delta = {
    delta_code: '00000000000000000011',
    base_graph_snapshot: 28,
    run_code: '00000000000000000007',
    changes: [
      {
        operation: 'add_edge',
        from: 'api.post-login',
        relation: 'calls',
        to: 'service.risk-control',
        verification: 'confirmed',
        source: { kind: 'scan', uri: 'x', revision: '1' },
      },
    ],
  };
  assert.throws(() => assertDeltaChanges(delta), (e) => e.code === 'delta_scan_cannot_confirm');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpStatusForError } from '../dist/error-status.js';

test('认证类错误码映射为 401', () => {
  assert.equal(httpStatusForError('unauthorized'), 401);
  assert.equal(httpStatusForError('auth_credentials_invalid'), 401);
  assert.equal(httpStatusForError('auth_token_invalid'), 401);
  assert.equal(httpStatusForError('legacy_identity_disabled'), 401);
});

test('权限与会话状态类错误码映射为 403', () => {
  assert.equal(httpStatusForError('password_change_required'), 403);
  assert.equal(httpStatusForError('team_forbidden'), 403);
  assert.equal(httpStatusForError('project_forbidden'), 403);
  assert.equal(httpStatusForError('claim_assignee_mismatch'), 403);
  assert.equal(httpStatusForError('member_forbidden'), 403);
  assert.equal(httpStatusForError('ownership_forbidden'), 403);
  assert.equal(httpStatusForError('ownership_recipient_required'), 403);
  assert.equal(httpStatusForError('ownership_recovery_forbidden'), 403);
});

test('资源不存在类错误码映射为 404', () => {
  assert.equal(httpStatusForError('task_not_found'), 404);
  assert.equal(httpStatusForError('user_not_found'), 404);
  assert.equal(httpStatusForError('document_not_found'), 404);
});

test('冲突与并发类错误码映射为 409', () => {
  assert.equal(httpStatusForError('snapshot_conflict'), 409);
  assert.equal(httpStatusForError('claim_not_assigned'), 409);
  assert.equal(httpStatusForError('task_contract_locked'), 409);
  assert.equal(httpStatusForError('milestone_feature_schedule_conflict'), 409);
  assert.equal(httpStatusForError('auth_device_limit_reached'), 409);
  assert.equal(httpStatusForError('project_owner_protected'), 409);
  assert.equal(httpStatusForError('team_owner_protected'), 409);
  assert.equal(httpStatusForError('account_closure_blocked'), 409);
  assert.equal(httpStatusForError('account_pending_deletion'), 409);
});

test('参数校验类错误码映射为 422，未收录的校验码回落 400', () => {
  assert.equal(httpStatusForError('invalid_status'), 422);
  assert.equal(httpStatusForError('invalid_profile'), 422);
  // 路由层的 `*_invalid` 校验码族未逐一收录，回落规则统一 400
  assert.equal(httpStatusForError('member_role_invalid'), 422);
  assert.equal(httpStatusForError('phase_status_invalid'), 400);
});

test('internal_error 显式映射为 500，避免服务端故障伪装成客户端错误', () => {
  assert.equal(httpStatusForError('internal_error'), 500);
});

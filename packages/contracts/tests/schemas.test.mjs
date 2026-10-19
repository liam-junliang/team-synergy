import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskContractSchema, EvidenceSchema, TaskSourceSchema } from '../dist/schemas.js';
import {
  PUBLIC_CODE_ALPHABET,
  PUBLIC_CODE_LENGTH,
  isPublicCode,
  publicCodeFromBytes,
} from '../dist/public-code.js';

test('公开编码：固定 20 位且不包含实体前缀或易混淆字符', () => {
  const code = publicCodeFromBytes(Uint8Array.from({ length: 13 }, (_, index) => index * 17));
  assert.equal(code.length, PUBLIC_CODE_LENGTH);
  assert.equal(isPublicCode(code), true);
  assert.equal([...code].every((character) => PUBLIC_CODE_ALPHABET.includes(character)), true);
  assert.equal(isPublicCode(`TEAM-${code}`), false);
  assert.equal(isPublicCode(code.toLowerCase()), false);
});

test('公开编码：随机字节不足时拒绝生成', () => {
  assert.throws(() => publicCodeFromBytes(new Uint8Array(12)), /至少需要 13 个随机字节/);
});

test('TaskContractSchema：缺验收标准的任务被拒绝（架构不变量 2）', () => {
  const result = TaskContractSchema.safeParse({
    task_code: '00000000000000000001',
    feature_code: '00000000000000000002',
    title: '实现认证失败统一响应与锁定策略',
    profile: 'builder',
    acceptance: [], // 违反 min(1)
  });
  assert.equal(result.success, false);
});

test('TaskContractSchema：最小合法任务契约通过', () => {
  const result = TaskContractSchema.safeParse({
    task_code: '00000000000000000001',
    feature_code: '00000000000000000002',
    title: '实现认证失败统一响应与锁定策略',
    profile: 'builder',
    acceptance: [{ id: 'AC-1', text: '账号不存在与密码错误返回相同响应' }],
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.source, 'requirement'); // 默认值生效
    assert.deepEqual(result.data.dependencies, []);
  }
});

test('TaskSourceSchema：四种来源分类合法，未知来源被拒绝', () => {
  for (const s of ['requirement', 'ad-hoc', 'defect-fix', 'integration']) {
    assert.equal(TaskSourceSchema.safeParse(s).success, true);
  }
  assert.equal(TaskSourceSchema.safeParse('unknown').success, false);
});

test('EvidenceSchema：acceptance_refs 默认空数组，显式声明可覆盖', () => {
  const result = EvidenceSchema.safeParse({
    evidence_code: '00000000000000000003',
    task_code: '00000000000000000001',
    type: 'self_test',
    result: 'pass',
    recorded_at: '2026-08-12T10:00:00Z',
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(result.data.acceptance_refs, []);
  }
  const withRefs = EvidenceSchema.safeParse({
    evidence_code: '00000000000000000004',
    task_code: '00000000000000000001',
    type: 'verifier_review',
    acceptance_refs: ['AC-1', 'AC-2'],
    result: 'pass',
    recorded_at: '2026-08-12T10:00:00Z',
  });
  assert.equal(withRefs.success, true);
  if (withRefs.success) {
    assert.deepEqual(withRefs.data.acceptance_refs, ['AC-1', 'AC-2']);
  }
});

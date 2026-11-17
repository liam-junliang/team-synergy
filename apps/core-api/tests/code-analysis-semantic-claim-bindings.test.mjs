import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaimBindings, assertClaimBindingPlan, CLAIM_BINDING_PROTOCOL, CLAIM_BINDING_MAX_TEXT_LENGTH, CLAIM_BINDING_MAX_BINDINGS } from '../dist/code-analysis-semantic-claim-bindings.js';
import { semanticDigest } from '../dist/code-analysis-semantic-source.js';

const failure = reason => error => error.code === 'code_analysis_model_invalid' && error.details?.reason === reason && error.details.repairable === false;
function assertRawSpans(text, plan) {
  assert.equal(plan.text_sha256, semanticDigest(text)); assert.equal(plan.coverage.bindings, plan.bindings.length);
  for (const row of plan.bindings) {
    assert.equal(row.text_sha256, plan.text_sha256); assert.equal(row.protocol, CLAIM_BINDING_PROTOCOL);
    for (const field of ['clause', 'assignment', 'target', 'operator', 'value']) {
      const span = row[field]; assert(Number.isSafeInteger(span.start)); assert(Number.isSafeInteger(span.end)); assert(span.start >= 0 && span.end > span.start && span.end <= text.length);
      assert.equal(text.slice(span.start, span.end), span.raw);
    }
    const { id, interpretation: _interpretation, ...identity } = row;
    assert.equal(id, 'CB-' + semanticDigest(identity).slice(0, 24));
    assert.equal(row.interpretation, 'raw_claim_fragment_in_original_whole_scope_not_an_independent_fact');
  }
  for (const skipped of plan.coverage.skipped) {
    assert(Number.isSafeInteger(skipped.start)); assert(Number.isSafeInteger(skipped.end)); assert(skipped.start >= 0 && skipped.end > skipped.start && skipped.end <= text.length);
  }
  assert.equal(plan.mandatory_whole_claim_check, true); assert.equal(plan.source_facts_approved, false);
}

test('parallel and single assignment views preserve raw tuples, condition prefixes and stable UTF16 identity', () => {
  const text = '校验成功后把 queue.left、queue.right 设置为 READY，将计数器设为 -2。', plan = parseClaimBindings(text);
  assert.deepEqual(plan.bindings.map(row => [row.target.raw, row.operator.raw, row.value.raw]), [['queue.left', '设置为', 'READY'], ['queue.right', '设置为', 'READY'], ['计数器', '设为', '-2']]);
  assert(plan.bindings[0].clause.raw.startsWith('校验成功后')); assertRawSpans(text, plan); assert.deepEqual(parseClaimBindings(text), plan);
  assert.equal(plan.coverage.parsed_groups, 2);
});

test('property values, quoted punctuation and Unicode identifiers retain original raw text and offsets', () => {
  for (const [text, value] of [['把 cache.key 设为 result.value。', 'result.value'], ['将 槽位 设为 "A，B；C"。', '"A，B；C"'], ["将 flag 设为 'not_ready'。", "'not_ready'"], ['😀 后把 状态 设为 0x10。', '0x10'], ['😀 后将 𠮷名 设为 "待审核"。', '"待审核"'], ['把 `queue.slot` 设为 `result.value`。', '`result.value`']]) {
    const plan = parseClaimBindings(text); assert.equal(plan.bindings.length, 1, text); assert.equal(plan.bindings[0].value.raw, value); assertRawSpans(text, plan);
  }
});

test('bare RHS accepts only code-like ASCII or numbers while quoted Unicode remains data', () => {
  for (const value of ['READY', '$next', 'result.value', 'module/value', 'items[2]', '-2', '+3.5', '0xA0']) assert.equal(parseClaimBindings(`将 槽位 设为 ${value}。`).bindings.length, 1, value);
  for (const value of ['待审核', '状态.当前', 'READY只是方案', 'VALUE仅是方案', 'Z是禁止的']) {
    const plan = parseClaimBindings(`将 槽位 设为 ${value}。`); assert.equal(plan.bindings.length, 0, value); assert(plan.coverage.skipped.some(row => row.reason === 'ambiguous_or_missing_value'));
  }
  const quoted = parseClaimBindings('将 槽位 设为 “待审核”。'); assert.equal(quoted.bindings.length, 1); assert.equal(quoted.bindings[0].value.raw, '“待审核”');
});

test('negation, plans, requests, hypotheticals and questions retain whole-claim fallback', () => {
  for (const text of ['不能把 x、y 设为 Z。', '未将 x 设置为 Z。', '不把 x 设为 Z。', '勿将 x 设为 Z。', '禁止修改，将 x 设置为 Z。', '如果条件成立，将 x、y 设为 Z。', '当条件成立时，将 x 设为 Z。', '计划将 x 设为 Z。', '希望把 x 设为 Z。', '如果条件成立将 x、y 设为 Z。', '假设将 x 设为 Z。', '只有条件成立将 x 设为 Z。', '请把 x 设为 Z。', '是否把 x 设为 Z？', '把 x 设为 Z？', '将来把 x 设为 Z。']) {
    const plan = parseClaimBindings(text); assert.equal(plan.bindings.length, 0, text); assert(plan.coverage.skipped.length, text); assertRawSpans(text, plan);
  }
});

test('quoted prose and fenced code are not promoted into independent bindings', () => {
  for (const text of ['示例：“把 x、y 设为 Z”。', '原话是“将 x 设为 Z”，尚未决定。', '`将 x 设为 Z` 是待讨论文本。', '```text\n把 x、y 设为 Z\n```', '样例：把 x 设为 Z。']) assert.equal(parseClaimBindings(text).bindings.length, 0, text);
  const text = '“将 x 设为 Z”只是引用。源码将 actual 设为 LIVE。', plan = parseClaimBindings(text);
  assert.deepEqual(plan.bindings.map(row => row.target.raw), ['actual']); assertRawSpans(text, plan);
});

test('separate mappings, conjunctions, duplicate targets and compound RHS report unsupported coverage', () => {
  for (const text of ['将 x、y 分别设为 A、B。', '将 x 与 y 设为 Z。', '把 x和y 设为 Z。', '把 x不设为 Z。', '将 x 未设为 Z。', '将 x、、y 设为 Z。', '将 x、x 设为 Z。', '将 x 设为 A 或 B。', '将 x 设为 A并执行下一步。', '把 x 设为 Z是禁止的。', '将 x、y 设为 V仅是方案。', '将 槽位 设为 待审核。', '把 x 设为。', '将 x 设为 "unfinished。']) {
    const plan = parseClaimBindings(text); assert.equal(plan.bindings.length, 0, text); assert(plan.coverage.skipped.length, text); assertRawSpans(text, plan);
  }
});

test('partial parser coverage never drops unsupported sibling meaning or changes original scope', () => {
  const text = '解析完成后将 local.flag 设为 resolved.flag，将 local.a 与 local.b 分别设为 resolved.a 与 resolved.b，仅将 local.kind 设为 FIXED。', original = text, plan = parseClaimBindings(text);
  assert.deepEqual(plan.bindings.map(row => [row.target.raw, row.value.raw]), [['local.flag', 'resolved.flag'], ['local.kind', 'FIXED']]);
  assert(plan.coverage.skipped.some(row => row.reason === 'separate_or_ordered_mapping'));
  assert.equal(plan.bindings[0].clause.raw, '解析完成后将 local.flag 设为 resolved.flag'); assert.equal(text, original); assertRawSpans(text, plan);
});

test('tuples, host keys, raw spans and coverage must match a complete recomputed plan', () => {
  const text = '把 left、right 设为 ACTIVE。', plan = parseClaimBindings(text); assert.deepEqual(assertClaimBindingPlan(text, plan), plan);
  for (const mutate of [value => value.bindings.pop(), value => { value.bindings[0].value.raw = 'OTHER'; }, value => { value.bindings[0].target.start++; }, value => { value.bindings[0].target.end = text.length + 1; }, value => { value.bindings[0].id = 'invented'; }, value => { value.text_sha256 = 'f'.repeat(64); }, value => { value.coverage.parsed_groups++; }, value => { value.coverage.bindings--; }, value => { value.mandatory_whole_claim_check = false; }, value => { value.source_facts_approved = true; }]) {
    const forged = structuredClone(plan); mutate(forged); assert.throws(() => assertClaimBindingPlan(text, forged), failure('claim_binding_plan_forged'));
  }
  assert.throws(() => assertClaimBindingPlan(text + ' changed', plan), failure('claim_binding_plan_forged'));
  assert.notEqual(parseClaimBindings(text + ' changed').bindings[0].id, plan.bindings[0].id, 'every tuple stays bound to the full unchanged claim');
});

test('serialized plans, arrays and nonobjects cannot impersonate the host plan hash', () => {
  const text = '将 slot 设为 READY。', plan = parseClaimBindings(text), cyclic = {}; cyclic.self = cyclic;
  for (const forged of [JSON.stringify(plan), [plan], null, undefined, false, 1, cyclic]) assert.throws(() => assertClaimBindingPlan(text, forged), failure('claim_binding_plan_forged'));
});

test('exact parser limits retain every tuple and overflows withhold the entire plan', () => {
  assert.equal(CLAIM_BINDING_MAX_TEXT_LENGTH, 20_000); assert.equal(CLAIM_BINDING_MAX_BINDINGS, 64);
  assert.equal(parseClaimBindings('x'.repeat(CLAIM_BINDING_MAX_TEXT_LENGTH)).bindings.length, 0);
  assert.throws(() => parseClaimBindings('x'.repeat(CLAIM_BINDING_MAX_TEXT_LENGTH + 1)), failure('claim_binding_text_budget'));
  assert.throws(() => parseClaimBindings(null), failure('claim_binding_text_budget'));
  const text = '把 ' + Array.from({ length: CLAIM_BINDING_MAX_BINDINGS }, (_, i) => 'slot' + i).join('、') + ' 设为 VALUE。', plan = parseClaimBindings(text);
  assert.equal(plan.bindings.length, 64); assert.equal(new Set(plan.bindings.map(row => row.id)).size, 64); assertRawSpans(text, plan);
  assert.throws(() => parseClaimBindings('把 ' + Array.from({ length: 65 }, (_, i) => 'slot' + i).join('、') + ' 设为 VALUE。'), failure('claim_binding_count_budget'));
});

test('an assignment-looking string inside a quoted RHS stays one raw value', () => {
  const text = '把 text 设为 "将 nested 设为 READY"。', plan = parseClaimBindings(text);
  assert.equal(plan.bindings.length, 1); assert.equal(plan.bindings[0].target.raw, 'text'); assert.equal(plan.bindings[0].value.raw, '"将 nested 设为 READY"'); assertRawSpans(text, plan);
});

test('unrecognized syntax and empty text never become approval or complete semantic coverage', () => {
  for (const text of ['', 'slot = READY;', '有一段普通业务说明。']) {
    const plan = parseClaimBindings(text); assert.equal(plan.bindings.length, 0); assert.equal(plan.coverage.parsed_groups, 0); assertRawSpans(text, plan);
    assert.equal('supported' in plan, false); assert.equal('status' in plan, false); assert.equal('complete' in plan.coverage, false);
  }
});

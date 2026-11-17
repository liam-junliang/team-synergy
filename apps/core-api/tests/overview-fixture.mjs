// Offline transport fixture only: schema/budget coverage, never a semantic quality score.
export function overviewFixture(prompt) {
  const evidence_ids = prompt.evidence_catalog.length ? [prompt.evidence_catalog[0].id] : [];
  const detail_file_ids = [prompt.related_path_catalog[0].id];
  return { covered_file_ids: prompt.related_path_catalog.map(row => row.id),
    candidates: [{ candidate_id: 'C1', name: '受约束状态职责', responsibility: '保留状态职责与用户目的的概览；详细规则仍在文件节点。', state_owners: ['受约束状态'], user_purposes: ['完成有前置条件的操作'], epistemic_status: evidence_ids.length ? 'source_inference' : 'uncertain', detail_file_ids, evidence_ids }],
    shared_invariants: prompt.leaf_rule_catalog.slice(0, 1).map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: ['C1'], epistemic_status: rule.epistemic_status })), boundary_contracts: [],
    important_unknowns: [{ description: '完整低级规则及未决问题需定位文件详情；本fixture不评估语义正确性。', detail_file_ids, evidence_ids: [] }],
  };
}

export function overviewBudgetFixture(prompt, validate) {
  const detail_file_ids = [prompt.related_path_catalog[0].id], evidence_ids = prompt.evidence_catalog.slice(0, 2).map(row => row.id);
  for (const count of [4, 3, 2, 1]) {
    let result, low = 1, high = 200;
    while (low <= high) {
      const size = Math.floor((low + high) / 2), value = {
        covered_file_ids: prompt.related_path_catalog.map(row => row.id),
        candidates: Array.from({ length: count }, (_, index) => ({ candidate_id: `C${index + 1}`, name: '离线预算' + '概'.repeat(Math.min(size, 70)), responsibility: '概'.repeat(size), state_owners: ['概'.repeat(Math.min(size, 80))], user_purposes: ['概'.repeat(Math.min(size, 80))], epistemic_status: 'uncertain', detail_file_ids, evidence_ids })),
        shared_invariants: prompt.leaf_rule_catalog.slice(0, Math.min(6, count * 2)).map(rule => ({ parent_rule_id: rule.parent_rule_id, candidate_ids: ['C1'], epistemic_status: 'uncertain' })),
        boundary_contracts: prompt.leaf_rule_catalog.slice(6, count === 1 ? 6 : 6 + count).map(rule => ({ parent_rule_id: rule.parent_rule_id, counterparty: '离线边界', candidate_ids: ['C1'], epistemic_status: 'uncertain' })),
        important_unknowns: [{ description: '仅为字节和目录预算测试，不代表语义质量。', detail_file_ids, evidence_ids: [] }],
      };
      try { validate(value); result = value; low = size + 1; }
      catch (error) { if (!['overview_text_budget', 'overview_convergence_budget'].includes(error.details?.reason)) throw error; high = size - 1; }
    }
    if (result) return result;
  }
  throw Error('Offline schema fixture has no feasible byte budget');
}

export function globalRuleReferenceFixture(value, prompt) {
  if (!prompt.global_rule_protocol) return value;
  if (Array.isArray(value)) return value.map(item => globalRuleReferenceFixture(item, prompt));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === 'business_rules' ? child.map(rule => prompt.leaf_rule_catalog.find(source => source.description === rule.description) ?? prompt.leaf_rule_catalog[0]).filter(Boolean).map(source => ({ parent_rule_id: source.parent_rule_id, origin_scope_id: prompt.global_scope_catalog.find(scope => scope.parent_rule_id === source.parent_rule_id).origin_scope_id, epistemic_status: source.epistemic_status })) : globalRuleReferenceFixture(child, prompt)]));
}

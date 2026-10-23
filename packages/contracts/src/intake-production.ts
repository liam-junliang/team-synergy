import type { IntakeBundle, IntakeItem } from './intake.js';
import type { IntakeQualityIssue } from './intake-quality.js';

export interface IntakeCoverageReport {
  status: 'unknown' | 'gaps' | 'mapped';
  scope: string; discovery_status: 'unknown' | 'partial' | 'reviewed';
  declared: number; in_scope: number; specified: number; pending: number; excluded: number; unknown: number;
  requirements: number; with_acceptance: number; with_verification: number; open_conflicts: number;
  rows: Array<{ key: string; title: string; disposition: 'included' | 'excluded' | 'unknown';
    state: 'specified' | 'pending' | 'excluded' | 'unknown'; reason: string; requirement_keys: string[]; feature_key?: string }>;
}
const substantive = (values: string[]) => values.length > 0 && values.every(value => value.trim().length > 0);
function hasSpecification(item: IntakeItem): boolean {
  const spec = item.specification;
  return Boolean(spec && spec.actor.trim() && spec.trigger.trim() && substantive(spec.preconditions) && substantive(spec.main_flow)
    && substantive(spec.business_rules) && spec.exceptions.length && spec.exceptions.every(exception => exception.condition.trim() && exception.handling.trim())
    && substantive(spec.state_changes) && substantive(spec.data_contracts));
}
function hasVerification(item: IntakeItem): boolean {
  return Boolean(item.acceptance_criteria?.length && item.acceptance_criteria.every(criterion => item.verification_plan?.some(plan => plan.ac_id === criterion.id
    && plan.preconditions.trim() && substantive(plan.steps) && plan.expected.trim())));
}

/** Declared inventory coverage, not a claim that undiscovered product behavior does not exist. */
export function evaluateIntakeProduction(bundle: IntakeBundle): { coverage: IntakeCoverageReport; issues: IntakeQualityIssue[] } {
  const production = bundle.source.production;
  const requirements = bundle.items.filter(item => item.kind === 'requirement');
  const issues: IntakeQualityIssue[] = [];
  const coverage: IntakeCoverageReport = {
    status: 'unknown', scope: production?.scope_statement ?? '', discovery_status: production?.discovery_status ?? 'unknown',
    declared: 0, in_scope: 0, specified: 0, pending: 0, excluded: 0, unknown: 0,
    requirements: requirements.length, with_acceptance: requirements.filter(item => item.acceptance_criteria?.length).length,
    with_verification: requirements.filter(hasVerification).length, open_conflicts: 0, rows: [],
  };
  if (!production) return { coverage, issues };
  const add = (rule: string, message: string, suggestion: string, item_key?: string, severity: IntakeQualityIssue['severity'] = 'blocker') =>
    issues.push({ rule_id: `production.${rule}`, message, suggestion, severity, ...(item_key ? { item_key } : {}) });
  if (!production.scope_statement.trim()) add('scope', '尚未说明本次产品分析范围。', '定义目标用户、业务边界及此次纳入的能力；不要用文件数量代替范围。');
  if (!production.capabilities.length) add('inventory', '尚未形成能力清单，无法计算规格覆盖。', '交叉检查用户入口、业务用例、接口、实体和测试，记录能力与排除理由。');
  if (production.discovery_status === 'partial') add('discovery', '能力发现仍为局部分析，清单分母尚未确认。', '保留未知项并复核遗漏；覆盖数字只适用于声明清单。', undefined, 'needs_review');
  const items = new Map(bundle.items.map(item => [item.key, item]));
  const linked = new Set<string>();
  for (const capability of production.capabilities) {
    const refs = capability.requirement_keys.map(key => items.get(key));
    const specified = capability.disposition === 'included' && Boolean(capability.feature_key) && refs.length > 0
      && refs.every(item => item?.kind === 'requirement' && hasSpecification(item) && hasVerification(item));
    const state = capability.disposition === 'excluded' ? 'excluded' : capability.disposition === 'unknown' ? 'unknown' : specified ? 'specified' : 'pending';
    coverage.rows.push({ key: capability.key, title: capability.title, disposition: capability.disposition, state, reason: capability.reason,
      requirement_keys: capability.requirement_keys, ...(capability.feature_key ? { feature_key: capability.feature_key } : {}) });
    for (const key of capability.requirement_keys) linked.add(key);
    if (capability.disposition !== 'included' && !capability.reason.trim()) add('disposition_reason', `能力“${capability.title}”缺少范围外或未知原因。`, '说明为什么不纳入或还不能判断，避免借排除提高覆盖数字。', capability.feature_key);
    if (capability.disposition === 'included' && !capability.evidence.length) add('capability_evidence', `能力“${capability.title}”缺少发现依据。`, '引用实际材料或实现位置，标明事实与目标的差别。', capability.feature_key);
    if (capability.disposition === 'included' && !specified) add('capability_specification', `能力“${capability.title}”尚未形成可验收的功能规格。`, '关联 Feature、结构化需求、深度规格、验收标准及逐条验证计划。', capability.feature_key);
    if (capability.disposition === 'unknown') add('unknown_capability', `能力“${capability.title}”尚未完成范围判定。`, capability.reason || '查阅补充材料或由业务负责人澄清。', capability.feature_key, 'warning');
  }
  for (const item of requirements) {
    if (!linked.has(item.key)) add('orphan_requirement', '需求尚未关联能力清单。', '将需求关联对应业务能力，避免无法解释的孤立需求。', item.key);
    if (!item.acceptance_criteria?.length) add('acceptance', '缺少可发布的结构化验收标准。', '填写稳定 AC 编号和可判断的预期行为；正文中的编号不会自动转为验收对象。', item.key);
    if (!hasSpecification(item)) add('specification_depth', '功能规格缺少角色、流程、例外、规则、状态或数据约束。', '明确所有维度；确实不适用时解释原因，避免通用占位描述。', item.key);
    if (!hasVerification(item)) add('verification', '部分验收标准没有具体的验证计划。', '为每条 AC 指定前置条件、步骤和预期结果；计划不代表执行通过。', item.key);
  }
  for (const conflict of production.conflicts) {
    if (conflict.status === 'open') add('conflict', `来源冲突待处理：${conflict.summary}`, '保留双方证据，明确现状与目标；由负责该业务的人员处理冲突。');
    else if (!conflict.resolution.trim()) add('conflict_resolution', '来源冲突标记已解决，但没有处理依据。', '记录取舍、适用版本和决定来源。');
  }
  coverage.declared = coverage.rows.length;
  coverage.in_scope = coverage.rows.filter(row => row.disposition === 'included').length;
  coverage.specified = coverage.rows.filter(row => row.state === 'specified').length;
  coverage.pending = coverage.in_scope - coverage.specified;
  coverage.excluded = coverage.rows.filter(row => row.state === 'excluded').length;
  coverage.unknown = coverage.rows.filter(row => row.state === 'unknown').length;
  coverage.open_conflicts = production.conflicts.filter(conflict => conflict.status === 'open').length;
  coverage.status = issues.length ? 'gaps' : 'mapped';
  return { coverage, issues };
}

/** Canonical projection keeps authored specification, AC IDs and verification plans together. */
export function renderIntakeSpecification(item: IntakeItem): string {
  const lines = [`# ${item.title}`, '', `规格标识：${item.key}`, '', `依据类型：${item.assessment}`, ''];
  const spec = item.specification;
  const section = (title: string, values: string[]) => { lines.push(`## ${title}`, '', ...values.map(value => `- ${value}`), ''); };
  if (spec) {
    section('角色与触发', [spec.actor, spec.trigger]); section('前置条件', spec.preconditions); section('主流程', spec.main_flow);
    section('异常与恢复', spec.exceptions.map(exception => `${exception.condition}：${exception.handling}`));
    section('业务规则', spec.business_rules); section('状态变化', spec.state_changes); section('数据与接口约束', spec.data_contracts);
  }
  section('验收标准', (item.acceptance_criteria ?? []).map(criterion => `${criterion.id}：${criterion.text}`));
  lines.push('## 验证计划', '', '以下为验证定义，未执行的计划不代表通过。', '');
  for (const plan of item.verification_plan ?? []) lines.push(`### ${plan.ac_id} · ${plan.method}`, '', `前置条件：${plan.preconditions}`, '', ...plan.steps.map((step, index) => `${index + 1}. ${step}`), '', `预期结果：${plan.expected}`, '');
  section('来源证据', item.evidence.map(evidence => `${evidence.path}:${evidence.line_start}–${evidence.line_end} · SHA-256 ${evidence.sha256}`));
  section('待确认', item.gaps);
  return lines.join('\n');
}

import { DOCUMENT_QUALITY_RULE_VERSION, evaluateDocumentQuality, type DocumentQualityPurpose } from './document-quality.js';
import { ENTERPRISE_ARTIFACTS, type EnterpriseArtifact } from './intake-quality-catalog.js';
import type { IntakeArtifactType, IntakeBundle, IntakeItem, IntakeProfile } from './intake.js';
import { evaluateIntakeProduction, type IntakeCoverageReport } from './intake-production.js';

/** Bump when intake rules change; the embedded text-rule version also freezes their basis. */
export const INTAKE_QUALITY_RULE_VERSION = `3.0.0+document.${DOCUMENT_QUALITY_RULE_VERSION}`;

export interface IntakeQualityIssue {
  rule_id: string;
  item_key?: string;
  artifact_type?: IntakeArtifactType;
  severity: 'blocker' | 'warning' | 'needs_review';
  message: string;
  suggestion: string;
  line_start?: number;
}

export interface IntakeQualityReport {
  rule_version: string;
  profile: IntakeProfile;
  batch_revision?: number;
  payload_hash?: string;
  status: 'blocked' | 'needs_review' | 'eligible';
  summary: { blockers: number; warnings: number; needs_review: number };
  issues: IntakeQualityIssue[];
  /** This is an inventory, never a publication, approval, or semantic-completeness claim. */
  artifacts: { required: number; present: number; missing: IntakeArtifactType[]; complete: boolean };
  coverage: IntakeCoverageReport;
  scope_note: string;
}

const purposes: Record<IntakeArtifactType, DocumentQualityPurpose> = {
  charter: 'overview', context: 'overview', domain: 'reference', requirements: 'requirements',
  nfr: 'nonfunctional', architecture: 'architecture', api_data: 'api', test_strategy: 'testing',
  security: 'security', runbook: 'operations', adr: 'architecture', onboarding: 'operations', risk: 'reference',
};

interface Section { line: number; body: string }
function markdownSections(content: string): Map<string, Section> {
  const sections = new Map<string, Section>();
  const lines = content.split(/\r?\n/);
  const headings: Array<{ title: string; line: number; level: number }> = [];
  let fence: { char: string; length: number } | undefined;
  let comment = false;
  const visible = lines.map((line, index) => {
    let prose = '';
    let remainder = line;
    // Ignore multiline comments as both headings and substantive section content.
    while (remainder) {
      if (comment) {
        const end = remainder.indexOf('-->');
        if (end < 0) break;
        comment = false;
        remainder = remainder.slice(end + 3);
      } else {
        const start = remainder.indexOf('<!--');
        if (start < 0) { prose += remainder; break; }
        prose += remainder.slice(0, start);
        comment = true;
        remainder = remainder.slice(start + 4);
      }
    }
    const marker = prose.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1]?.[0] === fence.char && marker[1].length >= fence.length && !marker[2]?.trim()) fence = undefined;
      return prose;
    }
    if (marker) { fence = { char: marker[1]?.[0] ?? '`', length: marker[1]?.length ?? 3 }; return prose; }
    const heading = prose.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ title: (heading[2] ?? '').replace(/^\d+(?:\.\d+)*[.、)]?\s*/, '').trim(), line: index + 1, level: heading[1]?.length ?? 1 });
    return prose;
  });
  // A stack finds the next sibling/ancestor in linear time. Slicing the entire
  // remaining heading list per heading made valid, heading-heavy input quadratic.
  const ends = new Array<number>(headings.length).fill(lines.length + 1);
  const open: number[] = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (!heading) continue;
    while (open.length) {
      const priorIndex = open.at(-1);
      if (priorIndex === undefined || (headings[priorIndex]?.level ?? 0) < heading.level) break;
      ends[priorIndex] = heading.line;
      open.pop();
    }
    open.push(index);
  }
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    if (!heading) continue;
    const end = ends[index] ?? lines.length + 1;
    // Nested headings are structural and do not make an otherwise empty section substantive.
    const body = visible.slice(heading.line, end - 1).filter(line => !/^\s{0,3}#{1,6}\s/.test(line))
      .filter(line => !/^\s*(?:[`~]{3,}[^\s]*|[|\s:-]+)\s*$/.test(line)).join('\n').trim();
    if (!sections.has(heading.title)) sections.set(heading.title, { line: heading.line, body });
  }
  return sections;
}

function distinctEvidence(item: IntakeItem): number {
  // A different symbol label does not turn the same captured location into new evidence.
  return new Set(item.evidence.map(evidence => `${evidence.path}\0${evidence.sha256}\0${evidence.line_start}\0${evidence.line_end}`)).size;
}

export function evaluateIntakeQuality(bundle: IntakeBundle, options: { batch_revision?: number; payload_hash?: string } = {}): IntakeQualityReport {
  const issues: IntakeQualityIssue[] = [];
  const enterprise = bundle.profile === 'enterprise';
  const add = (issue: IntakeQualityIssue) => issues.push(issue);
  const byType = new Map<IntakeArtifactType, IntakeItem[]>();
  for (const item of bundle.items) {
    if (item.artifact_type) byType.set(item.artifact_type, [...(byType.get(item.artifact_type) ?? []), item]);
  }
  const required = ENTERPRISE_ARTIFACTS.filter(artifact => artifact.required);
  const missing = required.filter(artifact => !byType.has(artifact.type)).map(artifact => artifact.type);
  const present = required.filter(artifact => byType.get(artifact.type)?.length === 1).length;
  if (enterprise) {
    for (const artifact of ENTERPRISE_ARTIFACTS) {
      const items = byType.get(artifact.type) ?? [];
      if (artifact.required && !items.length) add({ rule_id: 'artifact.required', artifact_type: artifact.type, severity: 'blocker', message: `缺少必交产物：${artifact.type}（${artifact.title}）`, suggestion: '新增该类型的证据支持候选；允许保留明确的未知项。' });
      if (items.length > 1) add({ rule_id: 'artifact.unique', artifact_type: artifact.type, item_key: items[1]?.key, severity: 'blocker', message: `artifact_type 重复：${artifact.type}`, suggestion: '每种档案类型保留一个候选，将详细内容组织为章节或引用。' });
      for (const item of items) inspectArtifact(item, artifact);
    }
    for (const item of bundle.items) {
      if (['requirement_document', 'architecture'].includes(item.kind) && !item.artifact_type) add({ rule_id: 'artifact.classification', item_key: item.key, severity: 'warning', message: '文档候选未标明 artifact_type，不计入企业必交档案。', suggestion: '为属于企业档案的候选选择对应类型；其他补充资料可保留未分类。' });
      if (item.kind === 'requirement') inspectRequirement(item, item.content_markdown);
    }
    add({ rule_id: 'review.source', severity: 'needs_review', message: '来源摘要和证据位置不能证明证据含义及全部事实真实。', suggestion: '复查对应提交、工作区状态、证据片段与正文声明；当前规则不会读取外部仓库。' });
    add({ rule_id: 'review.intent', severity: 'needs_review', message: '业务意图、设计取舍及跨文档一致性尚未取得独立审查结论。', suggestion: '关键事项由负责人确认；独立 Agent 语义审查为后续能力，本次没有调用 Agent。' });
    add({ rule_id: 'review.runtime', severity: 'needs_review', message: '实现、测试执行及运行测量结果尚未独立核验。', suggestion: '区分实现观察、推断、预期目标、验证计划和实际结果；不得为通过规则虚构测试或性能数据。' });
  }
  if (!bundle.source.complete) add({ rule_id: 'source.coverage', severity: 'warning', message: 'source.complete=false：声明范围仍有未覆盖或未分析内容。', suggestion: '记录具体遗漏、排除项及分析边界；未完成分析不能声称全量项目资料已核验。' });
  if (bundle.source.dirty) add({ rule_id: 'source.dirty', severity: 'warning', message: 'source.dirty=true：候选对应未提交工作区，不能代表已发布版本。', suggestion: '保留真实指纹，说明工作区差异与适用范围；提交代码后重新采集和核验。' });
  const production = evaluateIntakeProduction(bundle);
  issues.push(...production.issues);
  const summary = {
    blockers: issues.filter(issue => issue.severity === 'blocker').length,
    warnings: issues.filter(issue => issue.severity === 'warning').length,
    needs_review: issues.filter(issue => issue.severity === 'needs_review').length,
  };
  return {
    rule_version: INTAKE_QUALITY_RULE_VERSION, profile: bundle.profile,
    ...(options.batch_revision !== undefined ? { batch_revision: options.batch_revision } : {}),
    ...(options.payload_hash !== undefined ? { payload_hash: options.payload_hash } : {}),
    status: summary.blockers ? 'blocked' : summary.warnings || summary.needs_review ? 'needs_review' : 'eligible',
    summary, issues, coverage: production.coverage,
    artifacts: { required: required.length, present, missing, complete: present === required.length },
    scope_note: '本报告检查候选文本、档案目录与已声明证据结构；不执行 Agent 语义审查、测试、代码读取或运行测量。标准主题仅作为项目规则参考，不代表认证、人工批准或发布执行。绑定已有目标不会自动核验目标内容；跳过必交项不会使档案完整。',
  };

  function inspectArtifact(item: IntakeItem, artifact: EnterpriseArtifact) {
    const issue = (rule_id: string, severity: IntakeQualityIssue['severity'], message: string, suggestion: string, line_start?: number) => add({ rule_id, item_key: item.key, artifact_type: artifact.type, severity, message, suggestion, ...(line_start !== undefined ? { line_start } : {}) });
    if (item.kind !== artifact.kind) issue('artifact.kind', 'blocker', `${artifact.type}: kind 必须是 ${artifact.kind}`, '修正文档候选类型，保留真实关联。');
    if (distinctEvidence(item) < (artifact.required ? 2 : 1)) issue('evidence.distinct', 'blocker', `${artifact.type}: 不同位置的证据不足；重复路径、摘要和行范围只计一次。`, '补充直接支撑本资料的不同代码或测试位置，不能复制同一证据凑数。');
    if (!item.gaps.some(gap => gap.trim()) && artifact.required) issue('evidence.gaps', 'needs_review', `${artifact.type}: 未记录未验证项或确认边界。`, '复查是否存在未知项；确无缺口时说明核验边界，不要虚构风险或人员批准。');
    const sections = markdownSections(item.content_markdown);
    for (const section of artifact.sections) {
      const found = sections.get(section);
      if (!found) issue('section.required', 'blocker', `${artifact.type}: 缺少章节“${section}”`, '补充实际内容；不适用时保留章节并说明理由。');
      else if (!found.body) issue('section.nonempty', 'blocker', `${artifact.type}: 章节“${section}”没有实际正文。`, '填入证据支持的内容，或说明未知、原因及后续验证方式；注释与子标题不算正文。', found.line);
    }
    const text = evaluateDocumentQuality({ title: item.title, content: item.content_markdown, purpose: purposes[artifact.type], revision: options.batch_revision ?? 1, document_code: item.key, content_sha256: options.payload_hash ?? '', checked_at: bundle.source.analyzed_at, diagram_source: item.diagram_source });
    for (const check of text.checks) {
      if (check.status !== 'failed') continue;
      const structural = ['text.title', 'text.body', 'text.placeholders', 'text.empty_sections', 'text.fences', 'text.requirement_ids'].includes(check.id);
      issue(`document.${check.id}`, structural ? 'blocker' : 'warning', check.message, check.suggestion, check.line_start);
    }
    if (artifact.type === 'requirements') inspectRequirement(item, sections.get('验收场景')?.body ?? '');
    if (artifact.type === 'nfr') {
      if (!/\d+(?:\.\d+)?\s*(?:ms\b|s\b|%|分钟|小时|天|次|TPS\b|QPS\b|MB\b|GB\b)/i.test(item.content_markdown)) issue('nfr.measurement_plan', 'warning', '未发现可度量阈值；这不要求伪造性能实测结果。', '对已确定目标注明单位、负载与验证方法；尚未确定时说明原因、确认责任与验证计划。');
      if (!/目标|未测|待验证|待确认|实测|测量结果|target|unmeasured|not measured|pending|measured/i.test(item.content_markdown)) issue('nfr.claim_state', 'needs_review', '未明确区分质量目标与实测结果。', '标明每项是目标、待确认约束、代码观察还是带环境与时间的实测结果。');
    }
    if (artifact.type === 'architecture' && !item.diagram_source?.trim()) issue('architecture.diagram', 'blocker', '架构候选缺少 Mermaid diagram_source。', '提供反映真实组件与交互关系的图源，图中未知边界需明确标注。');
  }

  function inspectRequirement(item: IntakeItem, acceptance: string) {
    const issue = (rule_id: string, severity: IntakeQualityIssue['severity'], message: string, suggestion: string) => add({ rule_id, item_key: item.key, ...(item.artifact_type ? { artifact_type: item.artifact_type } : {}), severity, message, suggestion });
    if (!/\bREQ-[A-Z0-9][A-Z0-9-]+/i.test(item.content_markdown)) issue('requirements.identifier', 'blocker', '需求缺少稳定的 REQ 编号。', '为需求定义稳定编号，正文引用使用同一编号；不同需求不能重复定义。');
    if (!item.tests.length && !item.verification_plan?.some(plan => plan.preconditions.trim() && plan.steps.some(step => step.trim()) && plan.expected.trim())) issue('requirements.test_reference', 'blocker', '需求缺少测试引用或具体验证计划。', '引用真实测试，或为无实现/纯资料需求定义具备步骤和预期结果的验证计划；不要虚构测试文件或执行结果。');
    const condition = /(?:given|when)\s+\S|(?:当|如果).{2,}|(?:前置|条件)\s*[:：]?\s*\S{2,}/i.test(acceptance);
    const expected = /then\s+\S|(?:应当|应该|必须|预期|期望|断言)\s*[:：]?\s*\S{2,}|应(?:返回|显示|拒绝|保留|创建|更新|允许|阻止)\S+/i.test(acceptance);
    const bareLabels = !acceptance.replace(/\b(?:given|when|then)\b|场景|必须|预期|当|如果|前置|条件|[\s:：,，。.]/gi, '').trim();
    const structuredAcceptance = Boolean(item.acceptance_criteria?.length && item.acceptance_criteria.every(criterion =>
      criterion.text.trim() && item.verification_plan?.some(plan => plan.ac_id === criterion.id && plan.preconditions.trim()
        && plan.steps.length > 0 && plan.steps.every(step => step.trim()) && plan.expected.trim())));
    if (!structuredAcceptance && (!condition || !expected || bareLabels)) issue('requirements.acceptance', 'blocker', '未发现同时说明触发条件和可判断预期结果的验收场景。', '描述具体角色、条件、操作与预期结果；结构检查不能证明场景正确，仍需内容审查。');
  }
}

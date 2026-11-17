/** Text-only, reproducible project checks. These are not a standards certification. */
export const DOCUMENT_QUALITY_RULE_VERSION = '1.1.0';

export const DOCUMENT_QUALITY_PURPOSES = [
  'reference', 'requirements', 'architecture', 'api', 'operations', 'testing',
  'overview', 'standards', 'security', 'nonfunctional',
] as const;

export type DocumentQualityPurpose = typeof DOCUMENT_QUALITY_PURPOSES[number];

export const DOCUMENT_QUALITY_PURPOSE_LABELS: Record<DocumentQualityPurpose, string> = {
  reference: '参考与记录', requirements: '需求规格', architecture: '架构与设计',
  api: '接口契约', operations: '发布与运维', testing: '测试与验证', overview: '项目概览',
  standards: '规范与标准', security: '安全设计', nonfunctional: '非功能需求',
};

export interface DocumentQualityInput {
  title: string;
  content: string;
  purpose: DocumentQualityPurpose;
  source_kind?: string;
  revision: number;
  document_code: string;
  content_sha256: string;
  checked_at: string;
  diagram_source?: string | null;
  purpose_source?: 'inferred' | 'selected';
}

export interface DocumentQualityStandard {
  id: string;
  title: string;
  url: string;
  note: string;
}

export interface DocumentQualityCheck {
  id: string;
  title: string;
  category: string;
  status: 'passed' | 'failed' | 'needs_review' | 'not_applicable';
  severity: 'blocker' | 'warning' | 'info';
  message: string;
  suggestion: string;
  line_start?: number;
  line_end?: number;
  standard_ids: string[];
}

export interface DocumentQualityReport {
  title: string;
  source_kind?: string;
  revision: number;
  document_code: string;
  content_sha256: string;
  checked_at: string;
  rule_version: string;
  purpose: DocumentQualityPurpose;
  purpose_label: string;
  purpose_source: 'inferred' | 'selected';
  status: 'needs_changes' | 'needs_review' | 'checks_passed';
  summary: {
    applicable: number;
    checked: number;
    passed: number;
    failed: number;
    needs_review: number;
    not_applicable: number;
    blockers: number;
    warnings: number;
  };
  standards: DocumentQualityStandard[];
  checks: DocumentQualityCheck[];
  scope_note: string;
}

const referenceNote = '仅作为项目检查规则的参考；本报告不证明标准符合性、认证或人工批准。';
const standards: Record<string, DocumentQualityStandard> = {
  'ISO15289': { id: 'ISO15289', title: 'ISO/IEC/IEEE 15289:2019 生命周期信息项', url: 'https://www.iso.org/standard/74909.html', note: referenceNote },
  'ISO29148': { id: 'ISO29148', title: 'ISO/IEC/IEEE 29148:2018 需求工程', url: 'https://www.iso.org/standard/72089.html', note: referenceNote },
  'ISO42010': { id: 'ISO42010', title: 'ISO/IEC/IEEE 42010:2022 架构描述', url: 'https://www.iso.org/standard/74393.html', note: referenceNote },
  'ISO25010': { id: 'ISO25010', title: 'ISO/IEC 25010:2023 产品质量模型', url: 'https://www.iso.org/standard/78176.html', note: referenceNote },
  'ISO29119': { id: 'ISO29119', title: 'ISO/IEC/IEEE 29119-3:2021 测试文档', url: 'https://www.iso.org/standard/79429.html', note: referenceNote },
  'ISO9241': { id: 'ISO9241', title: 'ISO 9241-210:2019 以人为中心的设计', url: 'https://www.iso.org/standard/77520.html', note: referenceNote },
  'ASVS5': { id: 'ASVS5', title: 'OWASP ASVS 5.0 应用安全验证', url: 'https://owasp.org/www-project-application-security-verification-standard/', note: referenceNote },
};

interface StructureRule {
  id: string;
  title: string;
  cue: RegExp;
  expected: string;
  standard_ids: string[];
}

const purposeRules: Record<DocumentQualityPurpose, StructureRule[]> = {
  reference: [
    { id: 'reference.context', title: '记录背景与用途线索', cue: /背景|目的|范围|上下文|context|purpose|scope/i, expected: '资料背景、用途或适用范围', standard_ids: ['ISO15289'] },
    { id: 'reference.source', title: '资料来源线索', cue: /来源|日期|作者|会议|参考|source|date|author|https?:\/\//i, expected: '来源、记录日期或作者', standard_ids: ['ISO15289'] },
  ],
  requirements: [
    { id: 'requirements.context', title: '用户与范围线索', cue: /角色|用户|参与者|范围|actor|user|scope|stakeholder/i, expected: '相关用户、角色或范围', standard_ids: ['ISO29148', 'ISO9241'] },
    { id: 'requirements.behavior', title: '业务行为与条件线索', cue: /前置|条件|规则|流程|行为|当.+时|precondition|condition|rule|flow|shall|must|when/i, expected: '前置条件、规则或预期行为', standard_ids: ['ISO29148'] },
    { id: 'requirements.exceptions', title: '异常与权限边界线索', cue: /异常|失败|拒绝|权限|不允许|不适用|exception|failure|error|permission|forbidden|not applicable/i, expected: '异常、拒绝、权限边界，或有理由的不适用说明', standard_ids: ['ISO29148'] },
    { id: 'requirements.acceptance', title: '验收场景线索', cue: /验收|验证方式|预期结果|acceptance|given\b|then\b|expected result/i, expected: '验收场景及可判断的预期结果', standard_ids: ['ISO29148', 'ISO29119'] },
  ],
  architecture: [
    { id: 'architecture.structure', title: '边界与职责线索', cue: /边界|职责|组件|模块|系统上下文|boundary|responsibilit|component|module|container/i, expected: '系统边界、组件职责或依赖', standard_ids: ['ISO42010'] },
    { id: 'architecture.behavior', title: '关键交互线索', cue: /时序|流程|状态|交互|sequence|flow|state|interaction/i, expected: '关键流程、交互或状态变化', standard_ids: ['ISO42010'] },
    { id: 'architecture.decisions', title: '设计取舍线索', cue: /决策|取舍|替代|约束|选择理由|decision|trade.?off|alternative|constraint/i, expected: '约束、设计取舍或待确认的决策依据', standard_ids: ['ISO42010'] },
    { id: 'architecture.runtime', title: '部署与故障线索', cue: /部署|拓扑|故障|恢复|运行环境|不适用|deploy|topology|failure|recovery|runtime|not applicable/i, expected: '部署、运行或故障处理，或适用边界说明', standard_ids: ['ISO42010', 'ISO25010'] },
  ],
  api: [
    { id: 'api.contract', title: '请求与响应线索', cue: /请求|参数|响应|返回|request|parameter|response|return/i, expected: '接口请求、字段和响应定义', standard_ids: ['ISO29148'] },
    { id: 'api.errors', title: '错误与输入约束线索', cue: /错误|异常|校验|约束|error|exception|validation|constraint/i, expected: '输入约束、错误行为或错误码', standard_ids: ['ISO29148'] },
    { id: 'api.authorization', title: '鉴权边界线索', cue: /鉴权|认证|权限|匿名|公开|authorization|authentication|permission|anonymous|public/i, expected: '认证、授权或明确的公开访问边界', standard_ids: ['ASVS5'] },
    { id: 'api.evolution', title: '兼容与重试线索', cue: /兼容|版本|幂等|重试|不适用|compatib|version|idempoten|retry|not applicable/i, expected: '版本兼容、重试或幂等约定，以及不适用的理由', standard_ids: ['ISO15289'] },
  ],
  operations: [
    { id: 'operations.prerequisites', title: '操作前提线索', cue: /前置|前提|环境|权限|配置|precondition|prerequisite|environment|permission|configuration/i, expected: '操作前提、环境或权限', standard_ids: ['ISO15289'] },
    { id: 'operations.steps', title: '操作步骤线索', cue: /步骤|执行|命令|操作|step|execute|command|procedure/i, expected: '可执行的操作步骤', standard_ids: ['ISO15289'] },
    { id: 'operations.outcome', title: '结果判断线索', cue: /成功|健康|检查|验证|预期|success|health|check|verif|expected/i, expected: '操作成功或失败的判断方法', standard_ids: ['ISO15289'] },
    { id: 'operations.recovery', title: '失败与恢复线索', cue: /回滚|恢复|故障|失败|支持|不适用|rollback|recovery|failure|support|not applicable/i, expected: '失败处理、恢复办法或支持责任', standard_ids: ['ISO15289', 'ISO25010'] },
  ],
  testing: [
    { id: 'testing.scope', title: '测试范围与条件线索', cue: /范围|策略|环境|前置|scope|strategy|environment|precondition/i, expected: '测试范围、策略或执行条件', standard_ids: ['ISO29119'] },
    { id: 'testing.cases', title: '用例与预期线索', cue: /用例|场景|预期|断言|test case|scenario|expected|assert/i, expected: '测试场景、用例或可判断的预期结果', standard_ids: ['ISO29119'] },
    { id: 'testing.result', title: '结果与证据计划线索', cue: /执行|结果|证据|待执行|计划|execution|result|evidence|planned|pending/i, expected: '执行证据，或明确的待执行计划', standard_ids: ['ISO29119'] },
  ],
  overview: [
    { id: 'overview.purpose', title: '目标与范围线索', cue: /目标|目的|范围|非目标|objective|purpose|scope|non.?goal/i, expected: '项目目标、范围或非目标', standard_ids: ['ISO15289', 'ISO29148'] },
    { id: 'overview.people', title: '用户与业务线索', cue: /用户|角色|业务|参与者|成员|团队|维护者|多人|user|actor|business|stakeholder|member|team|maintainer/i, expected: '服务的用户、业务或相关方', standard_ids: ['ISO9241'] },
    { id: 'overview.capabilities', title: '能力与边界线索', cue: /功能|能力|模块|流程|约束|风险|已实现|尚未完成|闭环|边界|不追求|capabilit|feature|module|flow|constraint|risk/i, expected: '主要能力、约束或风险', standard_ids: ['ISO15289'] },
  ],
  standards: [
    { id: 'standards.scope', title: '适用范围线索', cue: /适用|范围|对象|scope|applicab|audience/i, expected: '规范适用的对象与范围', standard_ids: ['ISO15289'] },
    { id: 'standards.rules', title: '规则要求线索', cue: /必须|应当|禁止|要求|约定|shall|must|prohibit|requirement|convention/i, expected: '可遵循的规则或要求', standard_ids: ['ISO15289'] },
    { id: 'standards.maintenance', title: '例外与维护线索', cue: /例外|不适用|维护|责任|版本|复查|exception|not applicable|maintain|owner|version|review/i, expected: '例外处理、版本或维护责任', standard_ids: ['ISO15289'] },
  ],
  security: [
    { id: 'security.boundary', title: '资产与威胁线索', cue: /资产|威胁|信任|边界|风险|asset|threat|trust|boundary|risk/i, expected: '资产、威胁或信任边界', standard_ids: ['ASVS5'] },
    { id: 'security.controls', title: '安全控制线索', cue: /认证|授权|权限|加密|审计|控制|authentication|authorization|permission|encrypt|audit|control/i, expected: '适用的安全控制及其边界', standard_ids: ['ASVS5'] },
    { id: 'security.verification', title: '安全验证线索', cue: /验证|测试|检查|证据|计划|verif|test|check|evidence|plan/i, expected: '安全要求的验证方式或验证计划', standard_ids: ['ASVS5', 'ISO29119'] },
  ],
  nonfunctional: [
    { id: 'nonfunctional.target', title: '质量目标线索', cue: /目标|指标|阈值|要求|限制|target|metric|threshold|requirement|limit/i, expected: '明确的质量目标或约束', standard_ids: ['ISO25010', 'ISO29148'] },
    { id: 'nonfunctional.context', title: '使用与测量条件线索', cue: /环境|负载|并发|条件|样本|测量|情境|environment|load|concurren|condition|sample|measur|context/i, expected: '使用情境、测量条件或适用环境', standard_ids: ['ISO25010'] },
    { id: 'nonfunctional.verification', title: '目标验证线索', cue: /验证|测试|检查|证据|待验证|verif|test|check|evidence/i, expected: '质量目标的验证方法或证据计划', standard_ids: ['ISO25010', 'ISO29119'] },
  ],
};

export function inferDocumentQualityPurpose(input: { title: string; source_kind?: string; kind?: string }): DocumentQualityPurpose {
  const title = input.title;
  // Specific topics win over a generic source category such as requirement_document.
  if (/非功能|质量属性|性能|可靠性|non.?functional|performance|reliability/i.test(title)) return 'nonfunctional';
  if (/安全|威胁|security|threat/i.test(title)) return 'security';
  if (/\bapi\b|接口|契约|endpoint|contract/i.test(title)) return 'api';
  if (/运维|部署|发布|恢复|运行手册|operations|deployment|runbook|recovery/i.test(title)) return 'operations';
  if (/开发与接入指南|入门指南|onboarding/i.test(title)) return 'operations';
  if (/测试|验证|验收|追溯|test|verification|validation|traceability/i.test(title)) return 'testing';
  if (/规范|标准|约定|standard|convention|guideline/i.test(title)) return 'standards';
  if (/架构|设计|architecture|design/i.test(title)) return 'architecture';
  if (/需求|用例|业务规则|requirement|use case|business rule/i.test(title)) return 'requirements';
  if (/领域模型|术语|风险与缺口|domain model|glossary|risk register/i.test(title)) return 'reference';
  if (/系统上下文|项目章程|业务背景|system context|project charter/i.test(title)) return 'overview';
  if (/概览|概述|愿景|项目说明|overview|vision|readme/i.test(title)) return 'overview';
  const kind = `${input.source_kind ?? ''} ${input.kind ?? ''}`;
  if (/architecture|design/i.test(kind)) return 'architecture';
  if (/test/i.test(kind)) return 'testing';
  if (/requirement/i.test(kind)) return 'requirements';
  return 'reference';
}

interface TextLine { text: string; number: number; fenced: boolean }

function inspectMarkdown(content: string): { lines: TextLine[]; unclosedFence?: number } {
  let fence: { marker: string; length: number; line: number } | undefined;
  const lines = content.split(/\r?\n/).map((text, index) => {
    const number = index + 1;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    const fenced = !!fence || !!marker;
    if (fence) {
      if (marker && marker[1]?.[0] === fence.marker && marker[1].length >= fence.length && !marker[2]?.trim()) fence = undefined;
    } else if (marker?.[1]) {
      fence = { marker: marker[1][0] ?? '`', length: marker[1].length, line: number };
    }
    return { text, number, fenced };
  });
  return { lines, unclosedFence: fence?.line };
}

function emptyLeafHeading(lines: TextLine[]): TextLine | undefined {
  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const heading = current && !current.fenced ? /^ {0,3}(#{1,6})\s+\S/.exec(current.text) : null;
    if (!heading?.[1]) continue;
    let end = index + 1;
    let child = false;
    for (; end < lines.length; end += 1) {
      const next = lines[end];
      const nextHeading = next && !next.fenced ? /^ {0,3}(#{1,6})\s+\S/.exec(next.text) : null;
      if (nextHeading?.[1]) {
        child = nextHeading[1].length > heading[1].length;
        break;
      }
    }
    if (child) continue;
    const body = lines.slice(index + 1, end).map(line => line.text).join('\n')
      .replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*(?:[-*_]\s*){3,}$/gm, '').trim();
    if (!body) return current;
  }
  return undefined;
}

function duplicateDefinition(lines: TextLine[]): { id: string; first: number; duplicate: number } | undefined {
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (line.fenced) continue;
    // Only definition positions are recognized: an ID-led heading or an explicit ID: definition.
    // Inline mentions and traceability table cells are references, not duplicate definitions.
    const heading = /^\s*#{1,6}\s+(?:\*\*)?((?:REQ|FR|NFR|BR)-[A-Z0-9][A-Z0-9._-]*)(?=\s|[:：*]|$)/i.exec(line.text);
    const definition = /^\s*(?:[-*+]\s+)?(?:需求编号\s*[:：]\s*)?(?:\*\*)?((?:REQ|FR|NFR|BR)-[A-Z0-9][A-Z0-9._-]*)(?:\*\*)?\s*[:：]/i.exec(line.text);
    const id = (heading?.[1] ?? definition?.[1])?.toUpperCase();
    if (!id) continue;
    const first = seen.get(id);
    if (first !== undefined) return { id, first, duplicate: line.number };
    seen.set(id, line.number);
  }
  return undefined;
}

export function evaluateDocumentQuality(input: DocumentQualityInput): DocumentQualityReport {
  const parsed = inspectMarkdown(input.content);
  const proseLines = parsed.lines.filter(line => !line.fenced);
  const combinedContent = `${input.content}\n${input.diagram_source ?? ''}`.trim();
  const checks: DocumentQualityCheck[] = [];
  const add = (check: DocumentQualityCheck) => checks.push(check);
  add({ id: 'text.title', title: '文档标题', category: '正文完整性', status: input.title.trim() ? 'passed' : 'failed', severity: 'blocker', message: input.title.trim() ? '标题非空。' : '缺少可识别的文档标题。', suggestion: '提供能表达资料用途与主题的标题。', standard_ids: ['ISO15289'] });
  add({ id: 'text.body', title: '正文存在', category: '正文完整性', status: combinedContent ? 'passed' : 'failed', severity: 'blocker', message: combinedContent ? '存在可检查的正文或图源；长度不代表质量。' : '正文及图源均为空。', suggestion: '补充该版本的实际内容后重新检查。', standard_ids: ['ISO15289'] });

  const placeholder = proseLines.find(line => /(?:^|[\s:：>])(?:TBD|TODO|待补充|待填写|待完善|在此填写|请填写)(?:[\s:：。.!！]|$)|\{\{[^{}\n]+\}\}|\[(?:填写|补充|在此|待填)[^\]\n]*\]/i.test(line.text));
  add({ id: 'text.placeholders', title: '模板占位内容', category: '正文完整性', status: placeholder ? 'failed' : 'passed', severity: 'blocker', message: placeholder ? '发现未完成标记或模板变量；请判断它是否仍代表待填写内容。' : '未发现本规则识别的模板占位符；不保证所有内容已经补齐。', suggestion: '填写实际内容；确需记录未决事项时，说明问题、责任人与处理计划。代码示例中的标记不参与本项检查。', ...(placeholder ? { line_start: placeholder.number, line_end: placeholder.number } : {}), standard_ids: ['ISO15289'] });
  const emptyHeading = emptyLeafHeading(parsed.lines);
  add({ id: 'text.empty_sections', title: '空叶章节', category: '正文完整性', status: emptyHeading ? 'failed' : 'passed', severity: 'warning', message: emptyHeading ? '该末级章节没有正文。含有下级章节的目录标题不计为空章节。' : '未发现空的末级 Markdown 章节。', suggestion: '补充章节内容，或说明不适用的理由；删除无用途的模板章节。', ...(emptyHeading ? { line_start: emptyHeading.number, line_end: emptyHeading.number } : {}), standard_ids: ['ISO15289'] });
  add({ id: 'text.fences', title: '代码围栏闭合', category: '正文完整性', status: parsed.unclosedFence ? 'failed' : 'passed', severity: 'warning', message: parsed.unclosedFence ? '存在未闭合的 Markdown 代码围栏，可能使后文被错误展示。' : '未发现未闭合的 Markdown 代码围栏。', suggestion: '使用相同字符且长度不少于起始标记的围栏单独闭合代码块。', ...(parsed.unclosedFence ? { line_start: parsed.unclosedFence, line_end: parsed.unclosedFence } : {}), standard_ids: ['ISO15289'] });
  const duplicate = duplicateDefinition(parsed.lines);
  add({ id: 'text.requirement_ids', title: '需求定义编号重复', category: '引用与追溯', status: duplicate ? 'failed' : input.purpose === 'requirements' ? 'passed' : 'not_applicable', severity: 'blocker', message: duplicate ? `需求编号 ${duplicate.id} 在第 ${duplicate.first} 行定义后再次定义。` : '未发现可识别的重复需求定义；正文引用和表格引用不算定义，本项不强制使用需求编号。', suggestion: '为不同需求使用不同编号；引用已有需求时使用引用语句或链接。', ...(duplicate ? { line_start: duplicate.duplicate, line_end: duplicate.duplicate } : {}), standard_ids: ['ISO29148'] });

  for (const rule of purposeRules[input.purpose]) {
    const hasCue = (text: string) => {
      if (!rule.cue.test(text)) return false;
      if (input.purpose !== 'overview') return true;
      if (/^\s*#{1,6}\s/.test(text)) return false;
      // A topic label alone does not describe who the project serves or what it does.
      const description = text.replace(new RegExp(rule.cue.source, 'gi'), '').replace(/项目|主要|相关|以及|与|及|和/g, '');
      return /[\p{L}\p{N}]{2}/u.test(description);
    };
    const matchingLine = proseLines.find(line => hasCue(line.text));
    const found = !!matchingLine || (input.diagram_source ?? '').split(/\r?\n/).some(hasCue);
    add({ id: rule.id, title: rule.title, category: '用途检查（文本启发式）', status: found ? 'passed' : 'failed', severity: 'warning', message: found ? `检测到${rule.expected}的文本线索；尚未确认其完整性与正确性。` : `未检测到${rule.expected}的明确文本线索，需补充或人工确认。`, suggestion: `说明${rule.expected}；无需照搬固定章节名。不适用时记录理由，避免只填关键词。`, ...(matchingLine ? { line_start: matchingLine.number, line_end: matchingLine.number } : {}), standard_ids: rule.standard_ids });
  }

  add({ id: 'review.source', title: '来源与适用版本确认', category: '人工核验', status: 'needs_review', severity: 'info', message: '本次只检查所绑定版本的文本，未核验来源真实性、引用目标或适用的代码与运行版本。', suggestion: '由维护者确认资料来源、日期、引用有效性和适用版本；本报告的正文指纹不代表外部来源已验证。', standard_ids: ['ISO15289'] });
  add({ id: 'review.intent', title: '内容含义与责任人确认', category: '人工核验', status: 'needs_review', severity: 'info', message: '文本线索不能证明业务意图、设计取舍或结论正确；尚未取得相应责任人的评审结论。', suggestion: '按资料用途确认业务意图、适用范围和关键假设。业务目标可由业务确认，不强制要求代码证据。', standard_ids: input.purpose === 'architecture' ? ['ISO42010'] : ['ISO29148', 'ISO15289'] });
  const needsEvidence = ['requirements', 'architecture', 'api', 'operations', 'testing', 'security', 'nonfunctional'].includes(input.purpose);
  add({ id: 'review.evidence', title: '实现与运行证据核验', category: '人工核验', status: needsEvidence ? 'needs_review' : 'not_applicable', severity: 'info', message: needsEvidence ? '未读取实现、执行测试或测量运行结果；文内声明及证据链接尚未得到独立核验。' : '该用途不统一要求实现与运行证据；若声明系统已经实现或验证某行为，仍需另行核验。', suggestion: '区分预期目标、实现事实、验证计划和实际结果；为事实声明补充可追溯证据，尚未执行时明确标记待验证。', standard_ids: ['ISO29119', 'ISO25010'] });

  const count = (status: DocumentQualityCheck['status']) => checks.filter(check => check.status === status).length;
  const passed = count('passed');
  const failed = count('failed');
  const needsReview = count('needs_review');
  const usedStandardIds = new Set(checks.filter(check => check.status !== 'not_applicable').flatMap(check => check.standard_ids));
  return {
    title: input.title, ...(input.source_kind ? { source_kind: input.source_kind } : {}),
    document_code: input.document_code, revision: input.revision, content_sha256: input.content_sha256,
    checked_at: input.checked_at, rule_version: DOCUMENT_QUALITY_RULE_VERSION,
    purpose: input.purpose, purpose_label: DOCUMENT_QUALITY_PURPOSE_LABELS[input.purpose], purpose_source: input.purpose_source ?? 'inferred',
    status: failed ? 'needs_changes' : needsReview ? 'needs_review' : 'checks_passed',
    summary: { applicable: passed + failed + needsReview, checked: passed + failed, passed, failed, needs_review: needsReview, not_applicable: count('not_applicable'), blockers: checks.filter(check => check.status === 'failed' && check.severity === 'blocker').length, warnings: checks.filter(check => check.status === 'failed' && check.severity === 'warning').length },
    standards: Object.values(standards).filter(standard => usedStandardIds.has(standard.id)), checks,
    scope_note: '这是项目规则的文本质量反馈，不是综合评分、标准符合性认证或正式采用批准。用途检查只识别内容线索；未核验语义完整性、外部引用、实现及运行事实。人工待核验项不计入已检查分母。' + (input.diagram_source ? ' 已读取图源文本，未渲染或验证图形含义。' : ''),
  };
}

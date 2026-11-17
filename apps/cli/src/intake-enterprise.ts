import { DomainError } from '@team-synergy/domain';
import {
  IntakeProfileSchema,
  ENTERPRISE_ARTIFACTS,
  evaluateIntakeQuality,
  type EnterpriseArtifact,
  type IntakeArtifactType,
  type IntakeBundle,
  type IntakeProfile,
} from '@team-synergy/contracts';

export { ENTERPRISE_ARTIFACTS } from '@team-synergy/contracts';
export type { EnterpriseArtifact } from '@team-synergy/contracts';

export function parseIntakeProfile(value: string | undefined): IntakeProfile {
  const parsed = IntakeProfileSchema.safeParse(value ?? 'pilot');
  if (!parsed.success) throw new DomainError('intake_profile_invalid', 'profile 只能是 pilot 或 enterprise');
  return parsed.data;
}

export function enterpriseArtifact(type: IntakeArtifactType): EnterpriseArtifact {
  const artifact = ENTERPRISE_ARTIFACTS.find((item) => item.type === type);
  if (!artifact) throw new DomainError('intake_artifact_invalid', `未知企业级产物类型：${type}`);
  return artifact;
}

export function enterpriseTemplate(artifact: EnterpriseArtifact): string {
  const guidance: Partial<Record<IntakeArtifactType, string>> = {
    requirements: '按稳定 REQ 编号描述角色、前置、触发、行为、权限和异常；每个验收场景写明条件、操作、可判断结果及真实测试路径。',
    nfr: '逐项标记：预期目标 / 待确认约束 / 代码观察 / 实测结果。目标写单位、负载和验证方法；未测量要明确说明，不能虚构时延、SLO 或 RTO/RPO。',
    architecture: '从入口到权限、状态、事务、持久化及外部依赖追踪实际调用链；图与正文一致；区分当前实现和建议方案。',
    api_data: '列出真实路由、请求/响应字段、角色限制、错误码、重试/幂等行为；数据记录保留、删除、迁移及兼容边界。',
    test_strategy: '区分已定义测试、实际执行结果和待执行计划；将 REQ 编号映射到真实测试，记录未覆盖的异常与权限场景。',
    runbook: '提供真实命令、前置权限、环境及成功/失败判断；回滚和恢复步骤说明风险与演练状态，未演练不能称为验证通过。',
    security: '以资产、主体、入口和信任边界展开；逐项描述威胁、控制、权限拒绝路径和验证证据，未知项明确列出。',
    adr: '只有存在来源时才写历史决策；否则标为当前设计观察或待确认建议，列出方案、理由、后果和确认方式。',
  };
  const lines = [
    `# ${artifact.title}`,
    '',
    `> artifact_type: ${artifact.type}`,
    `> 说明：${artifact.purpose}`,
    '> 所有事实必须能追溯到代码、测试、文档或团队说明；注明来源与确认状态，未确认内容写入「未验证项」或 gaps。',
    '> 正文区分【实现观察】【推断】【预期目标】【运行实测】【待确认】；规则检查不等于业务批准或标准认证。',
    `<!-- ${guidance[artifact.type] ?? '先写具体场景和边界，再给证据与来源；业务目标无法从代码推导时记录待负责人确认。'} -->`,
    '<!-- 适用版本：源提交、manifest_sha256、dirty 状态及分析范围；证据：相对路径、真实行范围与摘要。 -->',
    '',
  ];
  artifact.sections.forEach((section, index) => {
    lines.push(`## ${index + 1}. ${section}`, '', '<!-- 填写具体事实/目标、适用条件、正常与异常边界、来源证据和未知项。章节不适用时说明原因；仅有标题或注释不能通过质量门禁。 -->', '');
  });
  return lines.join('\n');
}

export function enterpriseDossierPlan(): string {
  const lines = [
    '# Enterprise dossier plan',
    '',
    '本计划由 `tsp intake prepare --profile enterprise` 生成。每个必交产物需要一个候选，',
    '`kind=requirement_document` 或 `kind=architecture`，并填写 `artifact_type`。',
    '',
    '| artifact_type | 必交 | 候选 kind | 必填章节 |',
    '| --- | --- | --- | --- |',
  ];
  for (const artifact of ENTERPRISE_ARTIFACTS) {
    lines.push(`| ${artifact.type} | ${artifact.required ? '是' : '否'} | ${artifact.kind} | ${artifact.sections.join(' / ')} |`);
  }
  lines.push(
    '',
    '## 分阶段整理与复查',
    '',
    '1. 固定来源：读取 manifest 内代码、文档、团队说明与 exclusions，记录来源版本、dirty 和范围。在 source.production 建立能力清单、包含/排除/未知处置及冲突台账。',
    '2. 证据台账：沿关键场景串起路由 → 权限 → 用例 → 事务/数据 → 测试；记录真实路径/行范围，不把目录名当产品能力。',
    '3. 分批形成规格：先选一个端到端场景，建立结构化 requirement、specification、acceptance_criteria 和 verification_plan，再扩展其他能力；发现冲突写入 conflicts，不能以代码默认覆盖团队期望。',
    '4. 形成 13 类资料：区分当前实现、推断、预期目标和运行实测；记录文档之间的 REQ、接口、数据及决策引用。',
    '5. 规则校验：运行 validate 并阅读完整 quality 报告，处理 blocker；warning 与 needs_review 保留原因及证据边界。',
    '6. 草稿迭代：协议和来源有效即可 submit/replace 保存草稿；质量 blocker 阻止冻结新发布计划。替换会使旧计划失效。',
    '7. 审阅发布：负责人判断 create/bind/skip，冻结后 apply。绑定不检查目标正文，跳过必交项不等于档案完整；发布成功也不等于业务验收。',
    '8. 后续增量：重新 prepare 后运行 intake diff 比较旧/新包，按受影响项更新需求、设计、测试和证据；intake export 从结构化字段导出可读资料。独立 Agent 可按 references/evaluation.md 复查，平台尚未自动调度。',
    '',
    '## 质量门禁',
    '',
    '- 必交产物齐全，且每个 artifact_type 只出现一次。',
    '- 每个必交产物至少 2 个不同位置的来源证据，复制同一行范围不重复计数；记录真实 gaps，不虚构缺口。',
    '- 需求使用稳定编号，包含结构化验收和验证计划；有代码测试则链接真实测试，纯资料项目保留待执行计划。',
    '- 每个 included 能力关联具体需求；声明范围的覆盖、未知能力、结构化规格深度和未解决冲突独立呈现。目录齐全不能替代能力覆盖。',
    '- NFR 应给出目标单位、条件和验证计划；未确定的目标保留原因与确认责任。未测量结果必须明确写未实测，不能为通过校验编造数字。',
    '- API/数据应包含真实错误模型和生命周期；文本线索只能提示缺漏，不能代替内容判断。',
    '- 架构必须包含 Mermaid 图和风险/取舍。',
    '- 安全、运维、测试策略必须覆盖各自章节。',
    '- 不允许用无证据的“最佳实践”填充章节。',
    '- 规则版本绑定共享文档规则；报告的目录完整性、规则结果、内容核验与发布收据分别解释，无综合评分或认证声明。',
  );
  return lines.join('\n');
}

export function enterpriseSkillSection(): string {
  return [
    '',
    '## Enterprise dossier profile',
    '',
    'When the bundle profile is `enterprise`, produce the full dossier described in `dossier-plan.md` and the templates under `templates/`.',
    'Every required artifact must be a candidate item with `artifact_type`, nonempty mandatory sections and at least two distinct evidence locations. Repeating a location or changing its symbol label does not add evidence. Templates alone must fail quality checks.',
    'Do not create placeholder prose. Each factual statement needs evidence; uncertain statements go to `gaps` with an owner and review date.',
    'Requirements need stable `REQ-` identifiers, EARS-style behavior, Given/When/Then acceptance scenarios and test references.',
    'Separate observed implementation, inference, target, measured result and unknown. For NFRs, record units, load/environment and verification methods for known targets. Unconfirmed targets and unmeasured latency, availability, RTO/RPO or throughput remain explicit unknowns; never invent numbers or executed results to satisfy a rule.',
    'Architecture needs a Mermaid diagram and explicit trade-offs. ADRs need context, options, decision and consequences.',
    'Trace one complete normal/permission/exception scenario from entry point through use case and data to tests before expanding the dossier. Maintain cross-document REQ, API, data and decision references; re-read conflicting code instead of filling prose by keywords.',
    'Run `tsp intake validate <file> --profile enterprise` and read the complete report. Protocol/source errors reject submission; quality blockers allow draft submit/replace but block freezing a new publication plan. Keep warning and needs_review limitations visible.',
    'Independent Agent semantic review is deferred and is not invoked by this workflow. Candidate publication, owner decisions, semantic verification and real test execution are separate facts; do not fabricate any of them.',
  ].join('\n');
}

/** Compatibility adapter: CLI and platform share the same evaluator. */
export function validateEnterpriseBundle(bundle: IntakeBundle): { issues: string[]; warnings: string[] } {
  const report = evaluateIntakeQuality(bundle);
  return {
    issues: [...(bundle.profile !== 'enterprise' ? ['profile 不是 enterprise，不能通过企业级门禁'] : []), ...report.issues.filter(issue => issue.severity === 'blocker').map(issue => `${issue.item_key ? `${issue.item_key}: ` : ''}${issue.message}`)],
    warnings: report.issues.filter(issue => issue.severity !== 'blocker').map(issue => `${issue.item_key ? `${issue.item_key}: ` : ''}${issue.message}`),
  };
}

export function assertEnterpriseBundle(bundle: IntakeBundle): { warnings: string[] } {
  const result = validateEnterpriseBundle(bundle);
  if (result.issues.length > 0) {
    throw new DomainError('intake_quality_invalid', '企业级项目档案未通过质量门禁', { issues: result.issues });
  }
  return { warnings: result.warnings };
}

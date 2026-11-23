import { z } from 'zod';
import { code, inputText, type AgentActionDefinition } from './agent-action-definition.js';
import { CodeHostedAnalysisRequestSchema } from './code-understanding.js';
import { DefectSeveritySchema, DefectStatusSchema, DEFECT_EVIDENCE_MAX_ITEMS } from './schemas.js';

const managers = ['owner', 'admin'] as const;
const textQuery = { q: inputText(256).optional() };
const date = z.iso.date();
const revision = z.int().positive();
const sortOrder = z.int().min(-2147483648).max(2147483647).optional();
const description = z.string().max(4000).optional();
const goal = z.string().max(4000).optional();
const markdown = z.string().min(1).max(24000);
const changeSummary = inputText(2000);
const featureStatus = z.enum(['active', 'delivered', 'archived']);
const moduleStatus = z.enum(['active', 'archived']);
const phaseStatus = z.enum(['planned', 'active', 'completed', 'archived']);
const milestoneStatus = z.enum(['planned', 'active', 'at_risk', 'completed', 'cancelled']);
const ideaStatus = z.enum(['active', 'archived']);
const topicStatus = z.enum(['open', 'decided', 'reopened', 'archived']);
const requirementStatus = z.enum(['draft', 'clarifying', 'confirmed', 'implementing', 'delivered', 'change_proposed', 'deprecated']);
const documentKind = z.enum(['doc', 'api', 'diagram']);
const prototypeStatus = z.enum(['draft', 'ready', 'archived']);
const testMethod = z.enum(['manual', 'automated']);
const testPurpose = z.enum(['guide', 'script', 'data', 'environment', 'report']);
const httpLink = z.url({ protocol: /^https?$/ }).max(8192)
  .regex(/^https?:\/\/[^/?#@\s]+(?:[/?#][^\s]*)?$/i, '请输入不含账号或口令的 HTTP 或 HTTPS 链接');
const acceptance = z.array(z.strictObject({ id: inputText(64), text: inputText(2000) })).max(50);
const codeList = z.array(code).max(100);
const orderedCodes = z.array(code).max(1000);
const testDocument = {
  summary: description,
  module_code: code.nullable().optional(),
  requirement_codes: codeList.optional(),
  tags: z.array(inputText(100)).max(50).optional(),
};
const testCase = {
  ...testDocument,
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  method: testMethod.optional(),
  suite: inputText(250).optional(),
  preconditions: description,
  steps: z.array(z.strictObject({ action: inputText(4000), expected: inputText(4000) })).max(100).optional(),
  notes_markdown: z.string().max(12000).optional(),
  asset_codes: codeList.optional(),
};
const testAsset = {
  ...testDocument,
  purpose: testPurpose.optional(),
  storage_kind: z.enum(['markdown', 'url']),
  content: z.string().max(24000).optional(),
  url: httpLink.optional(),
};
const projectDocument = {
  title: inputText(512),
  kind: documentKind.optional(),
  folder_code: code.nullable().optional(),
  summary: description,
  content: markdown,
};
const prototype = {
  title: inputText(512),
  summary: description,
  content_kind: z.literal('url'),
  external_url: httpLink,
  notes_markdown: z.string().max(12000).optional(),
  requirement_codes: codeList.optional(),
  status: prototypeStatus.optional(),
};
const architecture = {
  content_kind: z.enum(['mermaid', 'drawio']),
  source_content: markdown,
  notes_markdown: z.string().max(12000).optional(),
  summary: description,
};

type ActionOptions = Pick<AgentActionDefinition, 'roles' | 'destructive' | 'projectArgument' | 'projectObject'>;

function action(
  name: string,
  module: AgentActionDefinition['module'],
  method: AgentActionDefinition['method'],
  path: string,
  description: string,
  shape: z.ZodRawShape = {},
  options: ActionOptions = {},
): AgentActionDefinition {
  return { name, module, method, path, description, schema: z.strictObject({ projectCode: code, ...shape }), scope: 'project', ...options };
}

export const projectActions: readonly AgentActionDefinition[] = [
  action('list_project_modules', 'planning', 'GET', '/projects/:projectCode/modules', '列出项目功能模块、状态和排序。'),
  action('create_project_module', 'planning', 'POST', '/projects/:projectCode/modules', '创建项目功能模块，供需求和 Feature 关联。', {
    name: inputText(240), description, sort_order: sortOrder, status: moduleStatus.optional(),
  }, { roles: managers }),
  action('update_project_module', 'planning', 'PATCH', '/modules/:module_code', '修改项目功能模块的名称、说明、顺序或状态。', {
    module_code: code, name: inputText(240).optional(), description: description.nullable(), sort_order: sortOrder, status: moduleStatus.optional(),
  }, { roles: managers, projectObject: { kind: 'module', key: 'module_code' } }),
  action('reorder_project_modules', 'planning', 'PUT', '/projects/:projectCode/modules/order', '按项目全部模块的完整编码顺序重排。', {
    module_codes: orderedCodes,
  }, { roles: managers }),
  action('get_project_feature', 'planning', 'GET', '/features/:feature_code', '查项目 Feature 的目标、状态、所属模块与里程碑。', {
    feature_code: code,
  }, { projectObject: { kind: 'feature', key: 'feature_code' } }),
  action('create_project_feature', 'planning', 'POST', '/features', '创建项目 Feature，供需求、缺陷和任务关联。', {
    title: inputText(512), goal, status: featureStatus.optional(), module_code: code.optional(), milestone_code: code.optional(),
    start_date: date.optional(), end_date: date.optional(),
  }, { roles: managers, projectArgument: 'project_code' }),
  action('update_project_feature', 'planning', 'PATCH', '/features/:feature_code', '修改项目 Feature 的目标、状态、归属或计划日期。', {
    feature_code: code, title: inputText(512).optional(), goal: goal.nullable(), status: featureStatus.optional(),
    module_code: code.nullish(), milestone_code: code.nullish(), start_date: date.nullish(), end_date: date.nullish(),
  }, { roles: managers, projectObject: { kind: 'feature', key: 'feature_code' } }),
  action('reorder_project_features', 'planning', 'PUT', '/projects/:projectCode/features/order', '按项目全部 Feature 的完整编码顺序重排。', {
    feature_codes: orderedCodes,
  }, { roles: managers }),
  action('list_project_phases', 'planning', 'GET', '/projects/:projectCode/phases', '列出项目阶段、日期和目标。'),
  action('create_project_phase', 'planning', 'POST', '/projects/:projectCode/phases', '创建项目阶段。日期使用 YYYY-MM-DD。', {
    name: inputText(240), goal, sort_order: sortOrder, start_date: date.optional(), end_date: date.optional(), status: phaseStatus.optional(),
  }, { roles: managers }),
  action('update_project_phase', 'planning', 'PATCH', '/phases/:phase_code', '修改项目阶段。显式 null 可清空目标或日期。', {
    phase_code: code, name: inputText(240).optional(), goal: goal.nullable(), sort_order: sortOrder,
    start_date: date.nullish(), end_date: date.nullish(), status: phaseStatus.optional(),
  }, { roles: managers, projectObject: { kind: 'phase', key: 'phase_code' } }),
  action('list_project_milestones', 'planning', 'GET', '/projects/:projectCode/milestones', '列出项目里程碑、所属阶段、负责人和目标日期。'),
  action('create_project_milestone', 'planning', 'POST', '/projects/:projectCode/milestones', '为当前项目已有阶段创建里程碑。', {
    phase_code: code, name: inputText(240), goal, sort_order: sortOrder, start_date: date.optional(), target_date: date.optional(),
    owner_principal_code: code.optional(), status: milestoneStatus.optional(),
  }, { roles: managers }),
  action('update_project_milestone', 'planning', 'PATCH', '/milestones/:milestone_code', '修改项目里程碑的阶段、日期、状态或负责人。', {
    milestone_code: code, phase_code: code.optional(), name: inputText(240).optional(), goal: goal.nullable(), sort_order: sortOrder,
    start_date: date.nullish(), target_date: date.nullish(), owner_principal_code: code.nullish(), status: milestoneStatus.optional(),
  }, { roles: managers, projectObject: { kind: 'milestone', key: 'milestone_code' } }),

  action('list_requirements', 'requirements', 'GET', '/requirements', '列出当前项目结构化需求、状态和来源。可按关键词筛选。', textQuery,
    { projectArgument: 'project_code' }),
  action('get_requirement', 'requirements', 'GET', '/requirements/:requirement_code', '读取结构化需求、验收条件和版本。', {
    requirement_code: code,
  }, { projectObject: { kind: 'requirement', key: 'requirement_code' } }),
  action('create_requirement', 'requirements', 'POST', '/requirements', '为当前项目的 Feature 创建需求草稿。模块、文档与 Feature 须同项目。', {
    feature_code: code, title: inputText(512), body: markdown, module_code: code.optional(), document_code: code.optional(),
    acceptance_criteria: acceptance.optional(), open_questions: z.array(inputText(2000)).max(50).optional(),
  }, { projectObject: { kind: 'feature', key: 'feature_code' } }),
  action('update_requirement', 'requirements', 'PATCH', '/requirements/:requirement_code', '修改当前需求描述、验收条件、开放问题或同项目的关联对象。', {
    requirement_code: code, title: inputText(512).optional(), body: markdown.optional(), feature_code: code.nullish(),
    module_code: code.nullish(), document_code: code.nullish(), acceptance_criteria: acceptance.optional(),
    open_questions: z.array(inputText(2000)).max(50).optional(),
  }, { roles: managers, projectObject: { kind: 'requirement', key: 'requirement_code' } }),
  action('transition_requirement', 'requirements', 'POST', '/requirements/:requirement_code/transition', '按需求状态机推进或废弃需求，先读当前状态和验收条件。', {
    requirement_code: code, to: requirementStatus,
  }, { roles: managers, projectObject: { kind: 'requirement', key: 'requirement_code' }, destructive: true }),
  action('list_requirement_documents', 'requirements', 'GET', '/projects/:projectCode/requirement-documents', '列出版本化需求文档，可按模块和状态筛选。', {
    ...textQuery, module: inputText(240).optional(), state: z.enum(['active', 'archived']).optional(),
  }),
  action('create_requirement_document', 'requirements', 'POST', '/projects/:projectCode/requirement-documents', '为已有功能模块创建需求文档及首个 Markdown 修订。', {
    module_code: code, title: inputText(512), summary: description,
    content: markdown, keywords: z.array(inputText(120)).max(40).optional(),
  }),
  action('get_requirement_document', 'requirements', 'GET', '/requirement-documents/:document_code', '读取需求文档正文、修订和关联需求。', {
    document_code: code,
  }, { projectObject: { kind: 'requirementDocument', key: 'document_code' } }),
  action('revise_requirement_document', 'requirements', 'PATCH', '/requirement-documents/:document_code', '核对当前内容后新增完整的需求文档修订，保留历史。', {
    document_code: code, module_code: code.optional(), module_key: inputText(240).optional(), title: inputText(512),
    summary: inputText(4000), content: markdown, keywords: z.array(inputText(120)).max(40), change_summary: changeSummary,
  }, { projectObject: { kind: 'requirementDocument', key: 'document_code' } }),
  action('list_requirement_baselines', 'requirements', 'GET', '/projects/:projectCode/requirement-baselines', '列出项目冻结需求基线。'),
  action('list_requirement_baseline_bindings', 'requirements', 'GET', '/projects/:projectCode/requirement-baselines/bindings', '查询任务和交接已绑定的冻结需求基线。'),
  action('get_requirement_baseline', 'requirements', 'GET', '/projects/:projectCode/requirement-baselines/:baseline_code', '读取冻结基线采用的具体需求修订和内容。', {
    baseline_code: code,
  }),
  action('compare_requirement_baseline', 'requirements', 'GET', '/projects/:projectCode/requirement-baselines/:baseline_code/diff', '比较冻结基线与当前需求或另一条基线。', {
    baseline_code: code, compare_to: z.union([z.literal('current'), code]).optional(),
  }),
  action('create_requirement_baseline', 'requirements', 'POST', '/projects/:projectCode/requirement-baselines', '确认需要冻结后创建需求基线，传入刚核对的父基线和需求修订。', {
    name: inputText(200), scope: inputText(2000), reason: inputText(4000), parent_baseline_code: code.nullable(),
    requirements: z.array(z.strictObject({ requirement_code: code, revision })).min(1).max(1000),
  }, { roles: managers, destructive: true }),
  action('list_project_ideas', 'requirements', 'GET', '/projects/:projectCode/ideas', '列出项目想法池，可按标题、详情或归档状态筛选。', {
    ...textQuery, status: ideaStatus.optional(),
  }),
  action('create_project_idea', 'requirements', 'POST', '/projects/:projectCode/ideas', '将已确认需要记录的观察或想法加入想法池。', {
    title: inputText(512), detail: z.string().max(12000).optional(), source: description,
  }),
  action('update_project_idea', 'requirements', 'PATCH', '/ideas/:idea_code', '修改想法内容或归档状态。权限由创建者和项目角色决定。', {
    idea_code: code, title: inputText(512).optional(), detail: z.string().max(12000).optional(),
    source: description.nullable(), status: ideaStatus.optional(),
  }, { projectObject: { kind: 'idea', key: 'idea_code' } }),
  action('list_requirement_topics', 'requirements', 'GET', '/projects/:projectCode/requirement-topics', '列出需求讨论议题，可区分讨论中、已决定和已归档。', {
    ...textQuery, status: topicStatus.optional(),
  }),
  action('create_requirement_topic', 'requirements', 'POST', '/projects/:projectCode/requirement-topics', '创建待讨论的需求议题，可关联同项目想法。', {
    title: inputText(512), problem_statement: z.string().max(12000).optional(), goal, idea_codes: codeList.optional(),
  }),
  action('get_requirement_topic', 'requirements', 'GET', '/requirement-topics/:topic_code', '读取议题全文、讨论条目和当前决定。', {
    topic_code: code,
  }, { projectObject: { kind: 'topic', key: 'topic_code' } }),
  action('add_requirement_topic_entry', 'requirements', 'POST', '/requirement-topics/:topic_code/entries', '向议题补充评论、备选方案或反馈。', {
    topic_code: code, entry_type: z.enum(['comment', 'alternative', 'feedback']).optional(), content: markdown, rationale: description,
  }, { projectObject: { kind: 'topic', key: 'topic_code' } }),
  action('record_requirement_topic_decision', 'requirements', 'POST', '/requirement-topics/:topic_code/entries', '经确认后登记议题决策。替代历史决定时给出原决定编码。', {
    topic_code: code, entry_type: z.literal('decision'), content: markdown, rationale: description, supersedes_entry_code: code.optional(),
  }, { roles: managers, projectObject: { kind: 'topic', key: 'topic_code' }, destructive: true }),
  action('link_requirement_topic_ideas', 'requirements', 'POST', '/requirement-topics/:topic_code/ideas', '将当前项目的想法关联到现有议题。', {
    topic_code: code, idea_codes: codeList,
  }, { projectObject: { kind: 'topic', key: 'topic_code' } }),
  action('link_requirement_topic_documents', 'requirements', 'POST', '/requirement-topics/:topic_code/documents', '将当前项目的需求文档关联到现有议题。', {
    topic_code: code, document_codes: codeList,
  }, { projectObject: { kind: 'topic', key: 'topic_code' } }),

  action('list_project_document_library', 'materials', 'GET', '/projects/:projectCode/handoff', '浏览项目文档库的文件夹及关联业务文档。', textQuery),
  action('create_project_document_folder', 'materials', 'POST', '/projects/:projectCode/handoff/folders', '在项目文档库创建普通文件夹，可指定父目录。', {
    name: inputText(240), parent_folder_code: code.nullish(),
  }),
  action('create_project_document', 'materials', 'POST', '/projects/:projectCode/handoff/documents', '发布可长期复用的项目说明、规范或接口文档。单次执行证据随关联任务或测试。', projectDocument),
  action('revise_project_document', 'materials', 'PATCH', '/handoff-documents/:document_code', '按刚读取的修订号修改普通项目文档，保留历史。', {
    ...projectDocument, document_code: code, base_revision: revision, change_summary: changeSummary,
  }, { projectObject: { kind: 'projectDocument', key: 'document_code' } }),

  action('list_design_prototypes', 'design', 'GET', '/projects/:projectCode/design-prototypes', '列出项目视觉和交互原型。', {
    ...textQuery, status: prototypeStatus.optional(),
  }),
  action('get_design_prototype', 'design', 'GET', '/design-prototypes/:prototype_code', '查看项目原型及其版本、需求关联和预览入口。', {
    prototype_code: code,
  }, { projectObject: { kind: 'designPrototype', key: 'prototype_code' } }),
  action('create_design_prototype_link', 'design', 'POST', '/projects/:projectCode/design-prototypes', '登记已有原型链接和来源需求。', prototype),
  action('revise_design_prototype_link', 'design', 'PATCH', '/design-prototypes/:prototype_code', '为已有链接原型追加新修订，保留历史。先读取原型确定关系和内容。', {
    ...prototype, prototype_code: code, requirement_codes: codeList, change_summary: changeSummary,
  }, { projectObject: { kind: 'designPrototype', key: 'prototype_code' } }),
  action('list_architecture_documents', 'design', 'GET', '/projects/:projectCode/architecture-documents', '列出架构图源和说明文档。', textQuery),
  action('create_architecture_document', 'design', 'POST', '/projects/:projectCode/architecture-documents', '创建 Mermaid 或 Draw.io 文本图源及首个修订。', {
    title: inputText(512), ...architecture,
  }),
  action('revise_architecture_document', 'design', 'PATCH', '/architecture-documents/:document_code', '按当前版本修订 Mermaid 或 Draw.io 图源，保留历史。', {
    ...architecture, document_code: code, base_revision: revision, title: inputText(512).optional(), change_summary: changeSummary,
  }, { projectObject: { kind: 'architecture', key: 'document_code' } }),

  action('list_project_defects', 'defects', 'GET', '/defects', '列出本项目缺陷及复现、预期、实际和证据。', {
    status: DefectStatusSchema.optional(), feature_code: code.optional(),
  }, { projectArgument: 'project_code' }),
  action('report_defect', 'defects', 'POST', '/defects', '用操作步骤、预期结果、实际结果和文字或链接证据提交缺陷。', {
    feature_code: code, title: inputText(512), severity: DefectSeveritySchema,
    action_steps: inputText(12000), expected_result: inputText(12000), actual_result: inputText(12000),
    evidence: z.array(z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('text'), text: inputText(12000) }),
      z.strictObject({ kind: z.literal('link'), url: httpLink }),
    ])).min(1).max(DEFECT_EVIDENCE_MAX_ITEMS),
    description, found_in: inputText(512).optional(), related_requirement_code: code.optional(),
  }, { projectArgument: 'project_code', projectObject: { kind: 'feature', key: 'feature_code' } }),
  action('transition_defect', 'defects', 'POST', '/defects/:defect_code/transition', '按缺陷状态机推进，修复中需提供同一缺陷的修复任务。', {
    defect_code: code, to: DefectStatusSchema, fix_task_code: code.optional(),
  }, { projectObject: { kind: 'defect', key: 'defect_code' }, destructive: true }),

  action('get_test_case', 'testing', 'GET', '/test-cases/:case_code', '读取测试用例、步骤和历史修订。', {
    case_code: code,
  }, { projectObject: { kind: 'testCase', key: 'case_code' } }),
  action('create_test_case', 'testing', 'POST', '/projects/:projectCode/test-cases', '在项目中创建结构化测试用例及首个修订。', {
    ...testCase, title: inputText(512),
  }),
  action('revise_test_case', 'testing', 'PATCH', '/test-cases/:case_code', '按刚读取的版本修订测试用例。', {
    ...testCase, case_code: code, title: inputText(512).optional(), base_revision: revision, change_summary: changeSummary,
  }, { projectObject: { kind: 'testCase', key: 'case_code' } }),
  action('list_test_assets', 'testing', 'GET', '/projects/:projectCode/test-assets', '列出测试资料、存储类型、长期说明和相关需求。', {
    ...textQuery, module_code: code.optional(), requirement_code: code.optional(), purpose: testPurpose.optional(),
    storage_kind: z.enum(['markdown', 'file', 'url', 'git']).optional(),
  }),
  action('create_test_asset', 'testing', 'POST', '/projects/:projectCode/test-assets', '登记 Markdown 或链接形式的测试资料。', {
    ...testAsset, title: inputText(512),
  }),
  action('revise_test_asset', 'testing', 'PATCH', '/test-assets/:asset_code', '按当前版本修订 Markdown 或链接形式的测试资料。', {
    ...testAsset, asset_code: code, title: inputText(512).optional(), base_revision: revision, change_summary: changeSummary,
  }, { projectObject: { kind: 'testAsset', key: 'asset_code' } }),
  action('list_test_executions', 'testing', 'GET', '/projects/:projectCode/test-executions', '按标题或执行环境查找项目历史测试执行和结果统计。', textQuery),

  action('get_test_execution', 'testing', 'GET', '/test-executions/:execution_code', '读取一次实际测试执行的固定用例修订、结果和证据。', {
    execution_code: code,
  }, { projectObject: { kind: 'testExecution', key: 'execution_code' } }),

  action('list_project_skill_catalog', 'skills', 'GET', '/projects/:projectCode/skills', '查看项目采用的技能、别名、修订和启用状态。'),
  action('read_project_skill_text', 'skills', 'GET', '/projects/:projectCode/skills/reader', '分页读取项目或当前 Run 固定技能的单个文本文件。', {
    run: code.optional(), skill: code, revision, path: inputText(240).optional(),
    offset: z.int().min(0).max(6291456).optional(), limit: z.int().min(1).max(8000).optional(),
  }),
  action('set_project_skill_version', 'skills', 'PUT', '/projects/:projectCode/skills/:skill_code', '管理项目使用的技能版本和启用状态。传入刚读取的版本代数。', {
    skill_code: code, revision, alias: inputText(128), enabled: z.boolean(), base_generation: z.int().nonnegative(),
  }, { roles: managers, destructive: true }),

  action('list_code_analysis_jobs', 'code', 'GET', '/projects/:projectCode/code-understanding/analyses', '列出服务端仓库分析作业及排队、运行和发布状态。'),
  action('request_project_code_analysis', 'code', 'POST', '/projects/:projectCode/code-understanding/analyses', '申请分析项目已登记仓库的唯一主线。请为同一次请求固定使用幂等键。', CodeHostedAnalysisRequestSchema.shape),
  action('get_code_analysis_job', 'code', 'GET', '/projects/:projectCode/code-understanding/analyses/:job_code', '读取指定服务端分析作业的进度和结果。', {
    job_code: code,
  }),
  action('list_code_intake_batches', 'code', 'GET', '/projects/:projectCode/intake', '列出项目规格候选批次和发布状态。'),
];

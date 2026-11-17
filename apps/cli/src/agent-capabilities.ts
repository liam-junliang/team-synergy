import { z } from 'zod';
import { DomainError } from '@team-synergy/domain';
import { CodeGraphQuerySchema, CodeHostedAnalysisRequestSchema, PersonalMemoryEditInput, PersonalMemoryWithdrawInput, isIntakeSourcePath,
  ProjectMaterialListInput, ProjectMaterialGlobInput, ProjectMaterialGrepInput, ProjectMaterialReadInput,
  PublicCodeSchema } from '@team-synergy/contracts';
import { valueOf, type MemoryContext } from './memory.js';
import { editPersonalMemory, readPersonalMemory, withdrawPersonalMemory } from './memory-personal.js';
import { queryLocalCodeRun } from './code-understanding.js';

export class AgentToolInputError extends Error {}
export interface AgentToolOptions { personalManagement?: boolean; projectCode?: string }
export const documentPlacementGuide = '文档库用于长期复用的项目背景、需求、设计、规范、指南和测试策略；测试资料按用途仅收录 guide/environment。交付源码包或构建包用 tsp task submit 引用原件；单次测试的结果和日志归入 tsp test execution record，缺陷截图和录屏用 tsp defect report。查执行证据用 tsp task status 或 tsp test execution show，原始测试资料用 tsp test asset show/download；文档可引用原记录。';

const localCodeInput = z.object({ run: PublicCodeSchema,
  command: z.enum(['overview', 'search', 'node', 'relations', 'context', 'callers', 'callees', 'impact', 'affected-tests']),
  engine: z.enum(['ua', 'codegraph']).optional(), query: z.string().trim().min(1).max(200).optional(),
  node: z.string().min(1).max(200).optional(), path: z.string().min(1).max(256).optional(),
  direction: z.enum(['in', 'out', 'both']).default('both'), limit: z.number().int().min(1).max(200).default(40),
  offset: z.number().int().min(0).max(100000).default(0),
}).strict().superRefine((value, ctx) => {
  if ((['context', 'search'].includes(value.command) && !value.query) ||
      (['node', 'relations', 'callers', 'callees', 'impact'].includes(value.command) && !value.node) ||
      (value.command === 'affected-tests' && (!value.path || !isIntakeSourcePath(value.path))) ||
      (['context', 'callers', 'callees', 'impact', 'affected-tests'].includes(value.command) && value.engine === 'ua')) {
    ctx.addIssue({ code: 'custom', message: 'Choose the required query/node/path and a compatible engine for this command' });
  }
});
const editInput = PersonalMemoryEditInput.extend({ source: PublicCodeSchema });
const withdrawInput = PersonalMemoryWithdrawInput.extend({ source: PublicCodeSchema });

function capability<T>(name: string, description: string, schema: z.ZodType<T>,
  execute: (context: MemoryContext, args: T) => Promise<unknown>, management = false,
  mutation?: { destructiveHint: boolean; idempotentHint: boolean }) {
  return { name, description, schema, management,
    definition: { name, description, inputSchema: z.toJSONSchema(schema, { io: 'input' }),
      annotations: { readOnlyHint: !management && !mutation, ...(management ? { destructiveHint: true, idempotentHint: false } : mutation ?? {}) } },
    async call(context: MemoryContext, input: unknown) {
      const parsed = schema.safeParse(input);
      if (!parsed.success) throw new AgentToolInputError('Invalid arguments for ' + name + ': ' + parsed.error.message);
      return execute(context, parsed.data);
    } };
}
const material = (context: MemoryContext, verb: string, args: unknown) =>
  context.client.request('POST', '/projects/' + encodeURIComponent(context.projectCode) + '/materials/' + verb, args).then(valueOf);
const codeBase = (context: MemoryContext) => '/projects/' + encodeURIComponent(context.projectCode) + '/code-understanding';
const skillIndex = z.object({ run: PublicCodeSchema.optional(), offset: z.int().min(0).max(6291456).optional(), limit: z.int().min(1).max(50).optional() }).strict();
const skillRead = skillIndex.extend({ skill: PublicCodeSchema, revision: z.int().positive(), path: z.string().min(1).max(240).optional(), limit: z.int().min(1).max(8000).optional() });
const platformIndex = skillIndex.omit({ run: true });
const platformRead = skillRead.omit({ run: true });
const platformTools = [
  { name: 'list_platform_skills', description: '列出平台内置已发布技能及固定修订。只需登录账号，不需要项目或工作区绑定。', schema: platformIndex },
  { name: 'read_platform_skill', description: '按平台目录的 skill 和 revision 分页读取 SKILL.md 或 path 指定文件，返回发布来源和哈希。只需登录账号，不采用到项目。', schema: platformRead },
];
export const platformSkillDefinitions = platformTools.map(tool => ({ name: tool.name, description: tool.description,
  inputSchema: z.toJSONSchema(tool.schema, { io: 'input' }), annotations: { readOnlyHint: true } }));
export function hasPlatformSkillCapability(name: string) { return platformTools.some(tool => tool.name === name); }
export async function executePlatformSkillCapability(context: Pick<MemoryContext, 'client'>, name: string, input: unknown) {
  const tool = platformTools.find(tool => tool.name === name);
  if (!tool) throw new AgentToolInputError('Unknown platform skill tool');
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) throw new AgentToolInputError('Invalid arguments for ' + name + ': ' + parsed.error.message);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) params.set(key, String(value));
  return context.client.request('GET', '/skills/platform/reader?' + params).then(valueOf);
}
function skillReader(context: MemoryContext, args: z.infer<typeof skillIndex> | z.infer<typeof skillRead>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, String(value));
  return context.client.request('GET', '/projects/' + encodeURIComponent(context.projectCode) + '/skills/reader?' + params).then(valueOf);
}
function boundCodeTour(value: unknown) {
  if (!value || typeof value !== 'object' || !('tour' in value) || !Array.isArray(value.tour) || !('nodes' in value) || !Array.isArray(value.nodes)) return value;
  const keys = new Set(value.nodes.map(node => JSON.stringify([node.run_code, node.id])));
  const relevant = value.tour.filter(step => Array.isArray(step.node_ids) && step.node_ids.some((id: string) => keys.has(JSON.stringify([step.run_code, id]))));
  const tour = [];
  let bytes = 0;
  for (const step of relevant) {
    const size = Buffer.byteLength(JSON.stringify(step), 'utf8');
    if (bytes + size > 16000) break;
    bytes += size; tour.push(step);
  }
  return { ...value, tour, tour_scope: 'selected_nodes', tour_truncated: relevant.length > tour.length };
}
async function managePersonal(context: MemoryContext, source: string, args: unknown, withdraw: boolean) {
  const account = { client: context.client, route: '/memory/personal' };
  const before = await readPersonalMemory(account, source);
  if (before.applicability === 'project' && before.projectCode !== context.projectCode) {
    throw new DomainError('memory_scope_mismatch', '该偏好不适用于当前项目，不能通过此项目的 Agent 会话管理');
  }
  const row = withdraw ? await withdrawPersonalMemory(account, source, args) : await editPersonalMemory(account, source, args);
  // Governance acknowledgements are not retrieval evidence; history/withdrawn text stays out of this project-bound model context.
  const { history: _history, text, ...current } = row;
  return { ...current, ...(row.status === 'active' ? { text } : {}), managementOnly: true, currentSourcesVerified: false };
}

const catalog = [
  capability('list_project_skills', '列出当前项目已采用的技能、固定修订与摘要。执行既有任务时传 run 读取其固定版本；选中后用 read_project_skill 按需读入口或参考文件。', skillIndex, skillReader),
  capability('read_project_skill', '按 list_project_skills 返回的 skill_code 和 revision 获取 SKILL.md，或按 path 分页读取包内单个文本文件。传同一 run 读取该次执行的固定版本。返回原始来源与文件指纹。', skillRead, skillReader),
  capability('list_project_materials', '列出项目、需求、架构与测试资料的目录、引用和版本。query 在虚拟路径、标题和摘要上匹配连续的字面子串，不是分词或多关键词语义搜索；用简短关键字，正文内容请 grep_project_materials。资料记载不代表已确认或已落实。' + documentPlacementGuide, ProjectMaterialListInput,
    (context, args) => material(context, 'list', args)),
  capability('glob_project_materials', '按虚拟路径 sourceKind/objectCode.md 用 */?/ ** 查目录。路径由对象编码组成；标题关键词请用 list_project_materials 的 query，正文关键词用 grep_project_materials。不访问本地文件系统。', ProjectMaterialGlobInput,
    (context, args) => material(context, 'glob', args)),
  capability('grep_project_materials', '在授权项目资料中搜索，返回版本、来源、行号、上下文和截断标记。mode 默认 literal，pattern 中的 | 会按普通字符匹配；多关键词择一时显式设 mode=regex。零命中只说明本次模式在已查范围未命中，不证明项目无此规定。正则有执行时限，二进制附件不参与文本检索。', ProjectMaterialGrepInput,
    (context, args) => material(context, 'grep', args)),
  capability('read_project_material', '按三种定位方式之一读取：sourceCitation；目录返回的 path；同时提供 sourceKind 和 objectCode。不要只传 objectCode，也不要混传多种定位方式。优先沿用目录或 grep 返回的 sourceCitation，引用该修订编码而非管理编码。支持历史修订、字符/行范围；检查 current/version，历史内容不能作为当前共识。已有足够检索片段时无需补读，默认不读全文。', ProjectMaterialReadInput,
    (context, args) => material(context, 'read', args)),
  capability('read_code_catalog', '查看当前项目已授权的仓库、分析运行和已选代码视图。代码图是固定版本的分析资料，不能代替当前源码或实际运行验证。', z.object({}).strict(),
    context => context.client.request('GET', codeBase(context) + '/context').then(valueOf)),
  capability('request_code_analysis', '请求服务器对已登记仓库的唯一主分支进行 UA/CodeGraph 分析；不读取成员本地文件。repository_codes 省略时更新所有仓库，重试须复用 idempotency_key。返回作业并用 get_code_analysis_status 查询；发布结果仍不等于实际部署验证。权限由平台 API 校验。', CodeHostedAnalysisRequestSchema,
    (context, args) => context.client.request('POST', codeBase(context) + '/analyses', args).then(valueOf), false, { destructiveHint: false, idempotentHint: true }),
  capability('get_code_analysis_status', '查看当前项目服务器分析作业。传 job_code 读指定作业，省略则列出项目作业。queued/running 尚未发布，failed 不影响已有分析来源。', z.object({ job_code: PublicCodeSchema.optional() }).strict(),
    (context, args) => context.client.request('GET', codeBase(context) + '/analyses' + (args.job_code ? '/' + encodeURIComponent(args.job_code) : '')).then(valueOf)),
  capability('query_code_graph', '查询已发布 UA/CodeGraph 节点、关系与源码证据。先从目录选择 run_code/view_code，按编号、路径或符号搜索；这里不是 LSP，也不提供本机完整调用分析。', CodeGraphQuerySchema,
    (context, args) => context.client.request('GET', codeBase(context) + '/graph?' + new URLSearchParams(
      Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]): [string, string] => [key, String(value)]))).then(valueOf).then(boundCodeTour)),
  capability('query_local_code', '查询当前工作区指定 run 的固定源码与已安装原生索引：context/callers/callees/impact/affected-tests 及本机图查询。实时核验项目权限和快照；本机缺索引会明确报错，不退回当前checkout或其他运行。', localCodeInput,
    (context, args) => queryLocalCodeRun(context, args)),
  capability('edit_personal_memory', '修改本人的记忆；必须给当前 expectedRevision。仅宿主显式开启个人记忆管理模式时提供，不改变项目共识，不产生推送等执行授权。', editInput,
    (context, { source, ...args }) => managePersonal(context, source, args, false), true),
  capability('withdraw_personal_memory', '撤回本人的记忆；必须给当前 expectedRevision。仅宿主显式开启个人记忆管理模式时提供。保留撤回与引擎同步记录。', withdrawInput,
    (context, { source, ...args }) => managePersonal(context, source, args, true), true),
];

export function agentCapabilityDefinitions(options: AgentToolOptions = {}) {
  return catalog.filter(tool => !tool.management || options.personalManagement).map(tool => tool.definition);
}
export function hasAgentCapability(name: string, options: AgentToolOptions = {}) {
  return catalog.some(tool => tool.name === name && (!tool.management || options.personalManagement));
}
export async function executeAgentCapability(context: MemoryContext, name: string, args: unknown, options: AgentToolOptions = {}) {
  const tool = catalog.find(tool => tool.name === name && (!tool.management || options.personalManagement));
  if (!tool) throw new AgentToolInputError('Unknown or disabled tool: ' + name);
  const result = await tool.call(context, args);
  // The API/queries impose their own pagination; never silently truncate JSON or turn omitted evidence into a complete answer.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 128_000) {
    throw new DomainError('agent_output_too_large', '结果超过128KB，请缩小范围或分页读取。');
  }
  return result;
}

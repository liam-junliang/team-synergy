import { z } from 'zod';
import { PublicCodeSchema } from '@team-synergy/contracts';

const modules = {
  projects: {
    title: '账号与项目',
    description: '先找到目标项目及其权限，再把项目编码传给后续工具。跨项目操作时逐次指定项目。',
    keywords: 'account identity authorization roles permissions project connection 账号 项目 权限 角色',
  },
  materials: {
    title: '项目资料',
    description: '按标题、路径或正文关键词找资料，再从命中的修订读取原文并引用。',
    keywords: 'documents files library requirements architecture documentation full text 文档 需求 资料 正文 全文',
  },
  memory: {
    title: '项目与个人记忆',
    description: '用简报了解近期讨论，按词查决定并核对出处。个人记忆需单独授权。',
    keywords: 'memory decisions discussion preference background consensus 记忆 讨论 决定 背景 共识 偏好 惯例',
  },
  code: {
    title: '代码规格',
    description: '先定位仓库和代码分析版本，再查询符号、依赖关系或源码证据。',
    keywords: 'code repo repository symbol dependencies graph source 代码 源码 仓库 符号 依赖',
  },
  tasks: {
    title: '任务协作',
    description: '先定位任务并核对状态、验收项和快照，再按项目角色处理任务。',
    keywords: 'task workflow delivery work item 任务 协作 工单 交付',
  },
  testing: {
    title: '测试与证据',
    description: '先确认测试用例的修订，再核对或登记实际执行结果和证据。',
    keywords: 'test testing execution verification testcase 测试 用例 验证 回归',
  },
} as const;

export type RemoteMcpToolModule = keyof typeof modules;
export const RemoteMcpToolModuleSchema = z.enum(Object.keys(modules) as RemoteMcpToolModule[]);
const moduleKeys = RemoteMcpToolModuleSchema.options;

export const SearchRemoteMcpToolsInput = z.strictObject({
  module: RemoteMcpToolModuleSchema.optional(),
  query: z.string().trim().max(128).optional().describe('工具名称或中文、英文关键词，如“记忆”“分派”“task status”。'),
  projectCode: PublicCodeSchema.optional().describe('可选目标项目。提供时，目录按当前项目角色过滤操作。'),
  limit: z.int().min(1).max(20).default(8),
});

type SearchInput = z.output<typeof SearchRemoteMcpToolsInput>;
type ToolSummary = {
  name: string;
  module: RemoteMcpToolModule;
  description: string;
  annotations: { readOnlyHint: boolean };
};

const equivalentTerms = [
  ['search', 'find', 'lookup', '查找', '检索', '搜索'],
  ['document', 'documents', 'doc', 'docs', '文档', '资料'],
  ['brief', 'overview', 'summary', '简报', '概况', '摘要'],
  ['memory', '记忆'],
  ['status', 'state', 'progress', '状态', '进度'],
  ['assign', 'assignment', '分派', '指派'],
  ['claim', '领取'],
  ['draft', '草稿'],
  ['evidence', '证据', '凭证'],
  ['test', 'testing', '测试'],
];
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s_-]+/gu, ' ').trim();

function matchScore(tool: ToolSummary, query: string, tokens: readonly string[]): number {
  const name = normalize(tool.name);
  if (name === query) return 100;
  const description = normalize(tool.description);
  const module = modules[tool.module];
  const topic = normalize(`${tool.module} ${module.title} ${module.keywords}`);
  let score = 0;
  for (const token of tokens) {
    const terms = equivalentTerms.find(group => group.includes(token)) ?? [token];
    if (terms.some(term => name.includes(term))) score += 6;
    else if (terms.some(term => description.includes(term))) score += 3;
    else if (terms.some(term => topic.includes(term))) score += 1;
    else return 0;
  }
  return score + (name.includes(query) ? 3 : 0);
}

/** Expose the live authorized descriptors without returning their full parameter schemas. */
export function searchRemoteMcpTools(visible: readonly ToolSummary[], input: SearchInput) {
  const modulesInScope = moduleKeys.flatMap(module => {
    if (input.module && module !== input.module) return [];
    const toolCount = visible.filter(tool => tool.module === module).length;
    const { title, description } = modules[module];
    return toolCount ? [{ module, title, description, toolCount }] : [];
  });
  const query = normalize(input.query ?? '');
  if (!input.module && !query) return { modules: modulesInScope };

  const tokens = [...new Set(Array.from(segmenter.segment(query)).filter(item => item.isWordLike).map(item => item.segment))];
  const candidates = visible.filter(tool => !input.module || tool.module === input.module)
    .map(tool => ({ tool, score: query ? matchScore(tool, query, tokens) : 1 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const matchedModules = new Set(candidates.map(item => item.tool.module));
  const tools = candidates.slice(0, input.limit).map(({ tool }) => ({
    name: tool.name, module: tool.module, description: tool.description, readOnly: tool.annotations.readOnlyHint,
  }));
  return {
    modules: matchedModules.size ? modulesInScope.filter(item => matchedModules.has(item.module)) : modulesInScope,
    tools,
    total: candidates.length,
    truncated: tools.length < candidates.length,
  };
}

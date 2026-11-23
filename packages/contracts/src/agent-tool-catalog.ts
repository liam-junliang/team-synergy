import { z } from 'zod';
import { AgentToolModuleSchema, agentToolModules as modules, code as PublicCodeSchema, type AgentToolModule } from './agent-action-definition.js';

const moduleKeys = AgentToolModuleSchema.options;

export const SearchAgentToolsInput = z.strictObject({
  module: AgentToolModuleSchema.optional(),
  query: z.string().trim().max(128).optional().describe('工具名称或中文、英文关键词，如“记忆”“分派”“task status”。'),
  projectCode: PublicCodeSchema.optional().describe('可选目标项目。提供时，目录按当前项目角色过滤操作。'),
  limit: z.int().min(1).max(20).default(8),
});

type SearchInput = z.output<typeof SearchAgentToolsInput>;
type ToolSummary = {
  name: string;
  module: AgentToolModule;
  description: string;
  annotations: { readOnlyHint: boolean };
};

const equivalentTerms = [
  ['search', 'find', 'lookup', '查找', '检索', '搜索'],
  ['create', 'add', '创建', '新建', '新增', '添加'],
  ['team', 'teams', '团队'],
  ['project', 'projects', '项目'],
  ['member', 'members', '成员'],
  ['rename', 'update', 'revise', '改名', '更新', '修改', '调整', '修订'],
  ['repository', 'repositories', 'repo', '仓库'],
  ['defect', 'defects', 'bug', '缺陷'],
  ['remove', '撤销', '移除', '移出'],
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
export function searchAgentTools(visible: readonly ToolSummary[], input: SearchInput) {
  const modulesInScope = moduleKeys.flatMap(module => {
    if (input.module && module !== input.module) return [];
    const toolCount = visible.filter(tool => tool.module === module).length;
    const { title, description } = modules[module];
    return toolCount ? [{ module, title, description, toolCount }] : [];
  });
  const query = normalize(input.query ?? '');
  if (!input.module && !query) return { modules: modulesInScope };

  const exactName = /^[a-z]+(?:_[a-z0-9]+)+$/i.test(input.query ?? '');
  const tokens = [...new Set(Array.from(segmenter.segment(query)).filter(item => item.isWordLike).map(item => item.segment))];
  const candidates = visible.filter(tool => !input.module || tool.module === input.module)
    .map(tool => ({ tool, score: exactName ? Number(normalize(tool.name) === query) : (query ? matchScore(tool, query, tokens) : 1) }))
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

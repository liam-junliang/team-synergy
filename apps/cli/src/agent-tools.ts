import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { AgentToolInputError } from './agent-capabilities.js';
import { createAgentToolSession, listAgentTools, serveMemoryMcp } from './memory-mcp.js';

type Print = (result: { ok: true; data: unknown }) => void;
function inputJson(text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > 64000) throw new DomainError('agent_input_too_large', '工具输入超过64KB');
  try { return JSON.parse(text); } catch { throw new DomainError('agent_invalid_input', '请输入有效JSON'); }
}
async function call(name: string, input: unknown, print: Print, personalManagement = false, projectCode?: string) {
  if (projectCode !== undefined) {
    if (!PublicCodeSchema.safeParse(projectCode).success || !input || typeof input !== 'object' || Array.isArray(input))
      throw new DomainError('agent_invalid_input', '请提供有效项目编号和工具对象参数');
    if ('projectCode' in input && input.projectCode !== projectCode)
      throw new DomainError('agent_invalid_input', '--project 与输入的 projectCode 不一致');
    input = { ...input, projectCode };
  }
  try { print({ ok: true, data: await createAgentToolSession({ personalManagement }).call(name, input) }); }
  catch (error) {
    if (error instanceof AgentToolInputError) throw new DomainError('agent_invalid_input', error.message);
    throw error;
  }
}
export function registerAgentToolCommands(program: Command, print: Print) {
  const tools = program.command('tools').description('与 MCP 共用的成员 Agent 能力目录与调用入口');
  tools.command('list').option('--allow-personal-management', '额外列出本人记忆编辑/撤回工具').action(opts =>
    print({ ok: true, data: listAgentTools({ personalManagement: !!opts.allowPersonalManagement }) }));
  tools.command('call <name>').option('--input <json>', '使用 tools list 中的同一输入schema', '{}')
    .option('--project <code>', '本次调用的项目编号，不要求本机工作区绑定')
    .option('--allow-personal-management', '显式开放本次本人记忆管理调用')
    .action((name, opts) => call(name, inputJson(opts.input), print, !!opts.allowPersonalManagement, opts.project));
  program.command('mcp').description('启动项目记忆、资料和代码检索 MCP stdio 服务')
    .option('--project <code>', '默认项目编号；可由各工具的 projectCode 覆盖，不要求本机绑定')
    .option('--allow-personal-management', '额外开放本人记忆编辑/撤回；不扩大平台权限')
    .action(async opts => {
      try { await serveMemoryMcp({ personalManagement: !!opts.allowPersonalManagement, projectCode: opts.project }); }
      catch (error) {
        process.stderr.write((error instanceof DomainError ? error.code + ': ' + error.message : 'agent_mcp_failed') + '\n');
        process.exitCode = 1;
      }
    });
}

/** Human-friendly aliases still execute the same schemas and handlers as MCP. */
export function registerProjectMaterialCommands(docs: Command, print: Print) {
  docs.command('index').description('列出项目文档目录、引用与版本；测试资料仅收录 guide/environment，执行证据从 task/test 查询')
    .option('--project <code>', '明确项目编号，不要求本机绑定')
    .option('--query <text>').option('--offset <count>', '目录偏移', Number).option('--limit <count>', '最多100', Number)
    .action(opts => { const { project, ...input } = opts; return call('list_project_materials', input, print, false, project); });
  docs.command('glob <pattern>').description('按 sourceKind/objectCode.md 的虚拟路径筛选目录')
    .option('--project <code>', '明确项目编号，不要求本机绑定')
    .option('--offset <count>', '目录偏移', Number).option('--limit <count>', '最多100', Number)
    .action((pattern, opts) => { const { project, ...input } = opts; return call('glob_project_materials', { ...input, pattern }, print, false, project); });
  docs.command('grep <pattern>').description('查当前项目资料的字面/正则文本，包含来源和行号')
    .option('--project <code>', '明确项目编号，不要求本机绑定')
    .option('--path-glob <pattern>').option('--mode <mode>', 'literal或regex')
    .option('--case-sensitive').option('--context-lines <count>', '上下文行数0..5', Number)
    .option('--offset <count>', '匹配偏移', Number).option('--limit <count>', '最多100', Number)
    .option('--max-chars <count>', '最多32000字符', Number)
    .action((pattern, opts) => { const { project, ...input } = opts; return call('grep_project_materials', { ...input, pattern }, print, false, project); });
  docs.command('read <path>').description('实时读取目录虚拟路径的当前或明确历史修订')
    .option('--project <code>', '明确项目编号，不要求本机绑定')
    .option('--revision <number>', '明确指定历史修订', Number).option('--offset <count>', '字符偏移', Number)
    .option('--limit <count>', '最多16000字符', Number).option('--start-line <count>', '起始行', Number)
    .option('--end-line <count>', '结束行', Number)
    .action((path, opts) => { const { project, ...input } = opts; return call('read_project_material', { ...input, path }, print, false, project); });
}

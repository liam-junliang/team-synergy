import { DomainError } from '@team-synergy/domain';
import { MemoryDocumentReadInput, PublicCodeSchema } from '@team-synergy/contracts';
import { z } from 'zod';
import { personalMemoryContext, projectRetrievalPolicy, readMemoryBrief, readMemoryDocument, searchMemory, valueOf, type MemoryContext } from './memory.js';
import { listPersonalMemory, readPersonalMemory } from './memory-personal.js';
import { MemoryContextReceipts } from './memory-context.js';
import { createMemoryWorkingContextStore } from './memory-working-context.js';
import { AgentToolInputError, agentCapabilityDefinitions, executeAgentCapability, hasAgentCapability, type AgentToolOptions } from './agent-capabilities.js';
import { createAgentConnection } from './agent-connection.js';

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const receiptSchema = { type: 'string', minLength: 1, maxLength: 64 };
const resources = [
  {
    uri: 'tsp-memory://project/brief', name: 'project_brief', title: '项目讨论与已确认决定',
    description: '查看当前项目近期的讨论和已确认决定。用 state 区分 discussed（讨论中）与 confirmed（已采纳），用 source 引用原记录。落实情况需另查执行证据。',
    mimeType: 'application/json',
  },
  {
    uri: 'tsp-memory://personal/preferences', name: 'personal_preferences', title: '我的工作习惯和偏好',
    description: '查看当前操作者适用于此项目的工作习惯和跨项目偏好。用 source 引用本人记录。涉及推送等操作时仍需依据本次授权。',
    mimeType: 'application/json',
  },
] as const;
const search = {
  name: 'search_memory',
  description: '给定编号、错误码、路径或特定主题时先搜索，公共业务选 project，个人问题只发到 personal。一般近期项目背景用 read_memory_brief；已有足够依据时不要同题再读简报。后续传最新 context_receipt 自动核对变化。缺原文或需逐字引用才用 read_memory_source。新聊天或压缩后无宿主管理时省略回执。偏好不授予执行权限。',
  inputSchema: { type: 'object', properties: {
    query: { type: 'string', minLength: 1, maxLength: 256 }, scope: { type: 'string', enum: ['project', 'personal'] },
    context_receipt: receiptSchema,
  }, required: ['query'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const brief = {
  name: 'read_memory_brief',
  description: '一般近期背景或决定先读简报，project=项目讨论与决定，personal=本人记录。已有足够依据就作答，不要同题同时搜索；明确编号或特定主题优先 search_memory。后续传最新 context_receipt 自动核对状态与原文变化。新聊天或压缩后无宿主管理时省略回执。恢复的历史来源须按原state与修订理解，不代表当前共识。',
  inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['project', 'personal'] }, context_receipt: receiptSchema }, required: ['scope'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const sourceTool = {
  name: 'read_memory_source',
  description: '按 source 核对当前可见来源；已有读取已核对版本与权限，不重复取证。project_material 返回短目录卡，需正文时把 locator 交给 read_project_material；旧 project_document 用 read_memory_document 分页。后续传最新 context_receipt。',
  inputSchema: { type: 'object', properties: { source: { type: 'string', minLength: 1, maxLength: 64 }, context_receipt: receiptSchema }, required: ['source'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const documentTool = {
  name: 'read_memory_document',
  description: '兼容旧原生项目文档的分页原文读取，每次最多8000字符。新 project_material 及需求/架构/测试资料统一用 read_project_material。沿用 range.nextOffset；query与offset二选一。文档记载不代表已确认或已落实，来源过期应重查。',
  inputSchema: { type: 'object', properties: {
    source: { type: 'string', minLength: 20, maxLength: 20 }, offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 2, maximum: 8000 }, query: { type: 'string', minLength: 1, maxLength: 256 },
    occurrence: { type: 'string', enum: ['first', 'last'] },
  }, required: ['source'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const personalListTool = {
  name: 'list_personal_memories',
  description: '只读查看本人的有效偏好及同步状态。没有项目上下文时只返回账号通用偏好；指定项目时包含适用于该项目的偏好。不返回历史和已撤回正文。revisionSource已向平台核对当前有效性，可按该字段引用；source仅是管理ID。',
  inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['active'] } }, additionalProperties: false },
  annotations: { readOnlyHint: true },
};
const personalReadTool = {
  name: 'read_personal_memory',
  description: '只读查看本人偏好的当前有效修订、来源与同步状态。账号通用偏好无需选择项目，项目限定偏好必须有匹配项目上下文。不返回历史和已撤回正文。revisionSource已向平台核对当前有效性，可按该字段引用；source仅是稳定管理ID。',
  inputSchema: { type: 'object', properties: { source: { type: 'string', minLength: 20, maxLength: 20 } }, required: ['source'], additionalProperties: false },
  annotations: { readOnlyHint: true },
};

const connectionTools = [
  { name: 'get_connection_context', description: '查看当前平台登录和默认项目；不需要工作区绑定。未登录时返回登录指引。项目未选时先 list_projects，再在项目工具参数中明确传 projectCode，不能自动选择第一个项目或在宿主安装目录写入绑定。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'list_projects', description: '列出当前账号有权访问的项目，支持名称/编号 query 和 limit。结合操作者意图选择准确项目，把返回的 projectCode 传给资料、记忆和代码工具；不修改本机绑定，不自动选项目。',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 },
      limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function listAgentTools(options: AgentToolOptions = {}) {
  return [...connectionTools, ...[search, brief, sourceTool, documentTool, personalListTool, personalReadTool,
    ...agentCapabilityDefinitions(options)].map(tool => ({ ...tool,
    description: tool.description + ([personalListTool.name, personalReadTool.name].includes(tool.name)
      ? ' 可选 projectCode 限定项目；无需为账号通用偏好查找或绑定项目。'
      : ' 可显式传 projectCode；省略时采用启动 --project 或有效工作区绑定，未选择项目时先 list_projects。'),
    inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
      projectCode: { ...z.toJSONSchema(PublicCodeSchema), description: '本次调用的准确项目编号；不改变连接的默认项目或本机绑定。' } } },
  }))];
}

/** Both CLI and MCP call this session. Identity and working-context receipts are transport independent. */
export function createAgentToolSession(options: AgentToolOptions = {}) {
  const connection = createAgentConnection(options);
  const receipts = new MemoryContextReceipts();
  const workingStores = new Map<string, ReturnType<typeof createMemoryWorkingContextStore>>();
  const activeEpochs = new Map<string, string>();
  const returnFull = process.env.TSP_MEMORY_CONTEXT_MODE === 'full';
  function workingFor(context: MemoryContext) {
    const session = process.env.TSP_MEMORY_SESSION;
    if (session === undefined) return;
    let store = workingStores.get(context.owner);
    if (!store) { store = createMemoryWorkingContextStore(context.owner, session); workingStores.set(context.owner, store); }
    return store;
  }
  async function readSources(context: MemoryContext, sources: string[]) {
    if (!sources.length) return [];
    const rows = valueOf(await context.client.request<unknown[]>('POST', context.route + '/sources', { sources }));
    if (!Array.isArray(rows) || rows.some(row => !record(row) || typeof row.source !== 'string' || !sources.includes(row.source))) {
      throw new DomainError('memory_invalid_sources', '平台来源回读失败。');
    }
    return rows as Record<string, unknown>[];
  }
  const content = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  const session = {
    async resource(uri: string) {
      const resource = resources.find(entry => entry.uri === uri);
      if (!resource) throw new AgentToolInputError('Resource not found');
      let context: MemoryContext;
      try { context = connection.projectContext(); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'project_selection_required' || resource.name !== 'personal_preferences') throw error;
        const personal = await session.call(personalListTool.name, {});
        const item = personal.content[0];
        if (!item) throw new DomainError('memory_invalid_sources', '本人偏好读取未返回有效内容');
        return { contents: [{ uri, mimeType: resource.mimeType, text: item.text }] };
      }
      const rows = await readMemoryBrief(context, resource.name === 'project_brief' ? 'project' : 'personal');
      connection.projectContext();
      return { contents: [{ uri, mimeType: resource.mimeType, text: JSON.stringify(rows) }] };
    },
    async call(name: string, args: unknown) {
      if (args === undefined) args = {};
      if (name === 'get_connection_context') {
        if (!record(args) || Object.keys(args).length) throw new AgentToolInputError('Expected empty connection context arguments');
        return content(await connection.getContext());
      }
      if (name === 'list_projects') {
        if (!record(args) || Object.keys(args).some(key => !['query', 'limit'].includes(key)) ||
          (args.query !== undefined && (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200)) ||
          (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)))
          throw new AgentToolInputError('Expected optional project query and limit 1..100');
        return content(await connection.listProjects(args as { query?: string; limit?: number }));
      }
      let projectCode: string | undefined;
      if (record(args) && args.projectCode !== undefined) {
        const parsed = PublicCodeSchema.safeParse(args.projectCode);
        if (!parsed.success) throw new AgentToolInputError('Invalid projectCode: use an exact code returned by list_projects');
        projectCode = parsed.data;
        const { projectCode: _projectCode, ...rest } = args;
        args = rest;
      }
      const boundContext = () => connection.projectContext(projectCode);
      if (hasAgentCapability(name, options)) {
        const data = await executeAgentCapability(boundContext(), name, args, options);
        boundContext();
        return content(data);
      }
      if (name === personalListTool.name || name === personalReadTool.name) {
        const listing = name === personalListTool.name;
        if (!record(args) || Object.keys(args).some(key => listing ? key !== 'status' : key !== 'source') ||
            (listing ? args.status !== undefined && args.status !== 'active' : typeof args.source !== 'string')) {
          throw new AgentToolInputError('Expected a personal memory read with its documented arguments');
        }
        let context: MemoryContext | undefined;
        try { context = boundContext(); } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'project_selection_required') throw error;
        }
        const account = personalMemoryContext();
        connection.assertAccount();
        if (context && account.actor !== context.actor) throw new DomainError('memory_binding_changed', '登录身份已切换，请重启工具会话');
        const data = listing ? await listPersonalMemory(account, { ...(context ? { projectCode: context.projectCode } : {}), status: 'active' }) :
          await readPersonalMemory(account, String(args.source));
        const allRows = 'items' in data ? data.items : [data];
        const rows = !context && listing ? allRows.filter(row => row.applicability === 'account') : allRows;
        if (rows.some(row => row.applicability === 'project' && row.projectCode !== context?.projectCode)) {
          throw new DomainError('memory_scope_mismatch', '该偏好不适用于当前项目');
        }
        if (rows.some(row => row.status !== 'active')) throw new DomainError('memory_source_unavailable', '该偏好当前不可引用。');
        const verified: Record<string, unknown>[] = [];
        if (context) for (let start = 0; start < rows.length; start += 40) {
          verified.push(...await readSources(context, rows.slice(start, start + 40).map(row => row.revisionSource)));
        }
        if (context && rows.some(row => !verified.some(source => source.source === row.revisionSource && source.scope === 'personal' &&
            source.state === 'preference' && source.text === row.text))) {
          throw new DomainError('memory_source_unavailable', '该偏好的引用已变化，请重新读取当前版本。');
        }
        const current = rows.map(({ history: _history, ...row }) => row);
        const safeData = 'items' in data ? { items: current, truncated: data.truncated } : current[0];
        if (context) boundContext();
        connection.assertAccount();
        return { content: [content(safeData).content[0], content({ managementOnly: true, citationSourceField: 'revisionSource', currentSourcesVerified: true }).content[0]] };
      }
      if (name === documentTool.name) {
        const input = MemoryDocumentReadInput.safeParse(args);
        if (!input.success) throw new AgentToolInputError('Expected a document source and valid page or query');
        const page = await readMemoryDocument(boundContext(), input.data);
        boundContext();
        return content([page]);
      }
      const isBrief = name === brief.name;
      const isSource = name === sourceTool.name;
      const common = ['context_receipt'];
      const keys = isBrief ? ['scope', ...common] : isSource ? ['source', ...common] : ['query', 'scope', ...common];
      if (!record(args) || Object.keys(args).some(key => !keys.includes(key)) ||
          (args.context_receipt !== undefined && (typeof args.context_receipt !== 'string' || !args.context_receipt || args.context_receipt.length > 64)) ||
          (isBrief ? (args.scope !== 'project' && args.scope !== 'personal')
          : isSource ? typeof args.source !== 'string' || !args.source || args.source.length > 64
          : name !== search.name || typeof args.query !== 'string' || !args.query.trim() || args.query.trim().length > 256 ||
            (args.scope !== undefined && args.scope !== 'project' && args.scope !== 'personal'))) {
        throw new AgentToolInputError('Expected a memory read with its documented arguments');
      }
      const context = boundContext();
      const working = workingFor(context);
      const snapshot = await working?.read();
      const activeEpoch = activeEpochs.get(context.owner);
      const restoring = !!snapshot && activeEpoch !== snapshot.epoch;
      const resetReason = snapshot && (activeEpoch === undefined && snapshot.sources.length ? 'process_restart' : snapshot.reason);
      const base = receipts.begin(context.owner, args.context_receipt as string | undefined, snapshot?.epoch);
      if (restoring) base.sources = new Map(snapshot.sources.map(ref => [ref.source, { version: ref.version }]));
      const data = isSource ? await readSources(context, [String(args.source)]) :
        isBrief ? await readMemoryBrief(context, args.scope) : await searchMemory(context, String(args.query), args.scope);
      const verified = await readSources(context, [...base.sources.keys()]);
      boundContext();
      if (isSource && !data.length) throw new DomainError('memory_source_unavailable', '该来源当前不可读，请重新检索。');
      const result = receipts.finish(base, restoring ? [...data, ...verified] : data, verified, {
        full: returnFull || restoring, forceSource: isSource ? String(args.source) : undefined,
        ...(restoring ? { restoreBudget: { textChars: 8000, rows: 6 } } : {}),
      });
      if (snapshot && working) {
        await working.commit(snapshot, receipts.references(result.metadata.context_receipt), result.metadata.unavailable_sources);
        boundContext();
        activeEpochs.set(context.owner, snapshot.epoch);
      }
      return { content: [content(result.rows).content[0], content({ ...result.metadata, ...(snapshot ? {
        context_epoch: snapshot.epoch, ...(restoring ? { context_reset: resetReason } : {}),
        ...(restoring ? { restored_sources: result.rows.filter(record).map(row => row.source)
          .filter(source => snapshot.sources.some(ref => ref.source === source)) } : {}),
      } : {}) }).content[0]] };
    },
  };
  return session;
}

// MCP stdio uses newline-delimited JSON-RPC. Stdout contains protocol frames only.
export async function serveMemoryMcp(options: AgentToolOptions = {}) {
  const session = createAgentToolSession(options);
  let initialized = false;
  const reply = (id: unknown, fields: Record<string, unknown>) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...fields }) + '\n');
  const fail = (id: unknown, code: number, message: string) => reply(id, { error: { code, message } });
  async function frame(line: string) {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, 'Parse error'); return; }
    if (!record(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' ||
        (msg.id !== undefined && typeof msg.id !== 'number' && typeof msg.id !== 'string')) {
      fail(null, -32600, 'Invalid request'); return;
    }
    if (msg.id === undefined) return;
    const id = msg.id, params = record(msg.params) ? msg.params : {};
    if (msg.method === 'initialize') {
      if (typeof params.protocolVersion !== 'string') { fail(id, -32602, 'Missing protocolVersion'); return; }
      initialized = true;
      reply(id, { result: { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'tsp-memory', version: '0.3.1' },
        instructions: [
          '平台连接与项目选择相互独立。首次需要项目资料但默认项目不明时，用 get_connection_context 查看账号和默认项目，list_projects 按操作者意图查找准确项目；随后在工具参数中传 projectCode，或使用启动 --project。不要自动选第一个项目，不要在 DSH 等宿主的安装目录创建工作区绑定。已明确项目后不必每题重复发现；不同项目的回执不能混用。',
          ...projectRetrievalPolicy,
        ].join('\n') } });
    } else if (msg.method === 'ping') reply(id, { result: {} });
    else if (!initialized) fail(id, -32002, 'Initialize the server first');
    else if (msg.method === 'tools/list') reply(id, { result: { tools: listAgentTools(options) } });
    else if (msg.method === 'resources/list' || msg.method === 'resources/templates/list') {
      if (params.cursor !== undefined) { fail(id, -32602, 'Invalid cursor'); return; }
      reply(id, { result: msg.method === 'resources/list' ? { resources } : { resourceTemplates: [] } });
    } else if (msg.method === 'resources/read') {
      if (typeof params.uri !== 'string' || Object.keys(params).some(key => key !== 'uri' && key !== '_meta')) {
        fail(id, -32602, 'Expected a resource URI'); return;
      }
      if (!resources.some(resource => resource.uri === params.uri)) { fail(id, -32002, 'Resource not found'); return; }
      try { reply(id, { result: await session.resource(params.uri) }); }
      catch (error) { fail(id, -32603, error instanceof DomainError ? error.code : 'memory_read_failed'); }
    } else if (msg.method === 'tools/call') {
      if (typeof params.name !== 'string') { fail(id, -32602, 'Expected a tool name'); return; }
      try { reply(id, { result: await session.call(params.name, params.arguments) }); }
      catch (error) {
        if (error instanceof AgentToolInputError) fail(id, -32602, error.message);
        else reply(id, { result: { isError: true, content: [{ type: 'text', text: error instanceof DomainError ? error.code + ': ' + error.message : 'agent_tool_failed' }] } });
      }
    } else fail(id, -32601, 'Method not found');
  }
  process.stdin.setEncoding('utf8');
  let pending = '';
  for await (const chunk of process.stdin) {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > 65536) throw new DomainError('mcp_frame_too_large', 'MCP 消息超出上限');
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.trim()) await frame(line);
    }
    if (pending.length > 65536) throw new DomainError('mcp_frame_too_large', 'MCP 消息超出上限');
  }
  if (pending.trim()) await frame(pending);
}

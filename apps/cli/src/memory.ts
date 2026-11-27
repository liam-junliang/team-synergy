import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { createApiClient, type ApiResult } from './api-client.js';
import { localDeviceFingerprint, readAuthConfig } from './auth-store.js';
import { normalizeApiUrl } from './device-identity.js';
import { identifyBoundProject } from './project-binding.js';

export function valueOf<T>(result: ApiResult<T>): T {
  if (result.ok) return result.data;
  throw new DomainError(result.error.code, result.error.message);
}

function resolveMemoryContext(requestTimeoutMs: number, explicitProjectCode?: string, nativeCapture?: { owner?: string }) {
  const auth = readAuthConfig();
  if (!auth?.device_token) throw new DomainError('login_required', '请先登录 tsp');
  if (explicitProjectCode !== undefined && !PublicCodeSchema.safeParse(explicitProjectCode).success) {
    throw new DomainError('invalid_project_code', '项目编码必须为 20 位公开编码');
  }
  const project = explicitProjectCode === undefined ? identifyBoundProject(process.cwd()) : null;
  if (!project && explicitProjectCode === undefined) throw new DomainError('project_binding_required', '请先在工作区绑定项目');
  const api = normalizeApiUrl(auth.api_url);
  if ((project && normalizeApiUrl(project.binding.api_url) !== api) ||
      (process.env.ACP_API_URL && normalizeApiUrl(process.env.ACP_API_URL) !== api)) {
    throw new DomainError('memory_api_mismatch', '工作区 API 地址与本机登录地址不一致');
  }
  const root = realpathSync.native(project ? path.dirname(path.dirname(project.path)) : process.cwd());
  const actor = auth.user_code;
  const code = explicitProjectCode ?? project?.binding.project_code;
  if (!code) throw new DomainError('project_binding_required', '请先在工作区绑定项目');
  const device = localDeviceFingerprint(api, auth.device_token);
  const legacyOwner = createHash('sha256').update(JSON.stringify([api, actor, device, auth.device_token, root, code])).digest('hex');
  const renewable = nativeCapture !== undefined && nativeCapture.owner !== legacyOwner &&
    PublicCodeSchema.safeParse(auth.device_code).success && PublicCodeSchema.safeParse(auth.session_code).success;
  const owner = renewable
    ? createHash('sha256').update(JSON.stringify(['native-device-session', api, actor, auth.device_code, auth.session_code, root, code])).digest('hex')
    : legacyOwner;
  const client = createApiClient({ baseUrl: api, redirect: 'error', requestTimeoutMs,
    ...(renewable ? { storedDeviceProfile: auth } : { deviceToken: auth.device_token }) });
  return { actor, root, owner, legacyOwner, client, projectCode: code, route: '/projects/' + encodeURIComponent(code) + '/memory' };
}

export function memoryContext(requestTimeoutMs = 12000, explicitProjectCode?: string) {
  return resolveMemoryContext(requestTimeoutMs, explicitProjectCode);
}

/** A new native registration is scoped to the stored login session, not its rotating access token. */
export function nativeMemoryContext(requestTimeoutMs = 5000, existingOwner?: string) {
  return resolveMemoryContext(requestTimeoutMs, undefined, { owner: existingOwner });
}

export type MemoryContext = ReturnType<typeof memoryContext>;

/** Account governance works before a project or task has been selected. */
export function personalMemoryContext(requestTimeoutMs = 12000) {
  const auth = readAuthConfig();
  if (!auth?.device_token) throw new DomainError('login_required', '请先登录 tsp');
  const api = normalizeApiUrl(auth.api_url);
  if (process.env.ACP_API_URL && normalizeApiUrl(process.env.ACP_API_URL) !== api) {
    throw new DomainError('memory_api_mismatch', 'API 地址与本机登录地址不一致');
  }
  const client = createApiClient({ baseUrl: api, deviceToken: auth.device_token, redirect: 'error', requestTimeoutMs });
  return { actor: auth.user_code, client, route: '/memory/personal' };
}

/** Persistent host guidance; user questions do not need retrieval commands. */
export const projectRetrievalPolicy = [
  '用户只提出业务问题时，也要自行判断是否需要项目依据。涉及具体项目的规则、需求、角色、设计、历史决定或进度，先读取相关当前资料再回答，不用通用经验替代本项目事实；普通常识、算术不检索。',
  '项目不明确时先核对连接的默认项目。没有默认项目且用户只说“这个项目”等指代时，直接澄清项目，不遍历多个项目的内容来猜，不以资料多少或平台同名为依据选项目。项目已明确时沿用准确 projectCode，不重复发现。',
  '项目规范和业务文档优先目录/正文检索；近期讨论与决定优先项目记忆。已经得到直接依据就作答，不再为了重复核验而同时读简报、搜索和正文。问题只需平台工具使用约定时可依据工具说明，但不能声称已读取项目资料。',
  '有足够片段即可引用，无需补读全文。通常一到两种有针对性的检索后，若仍无明确依据，说明在已查范围未找到并保留未知，不穷举资料、不搜索其他项目、不推测分钟数或保证。复杂问题仅按明确缺口补查；缺少结论就说明缺少结论，不为填满回答而扩展推断或做完整性断言。',
  '严格保留来源的条件、例外与身份含义，不能添加未记载的禁止、保证或责任人。关键项目结论附实际返回的 sourceCitation/source，并标明标题和修订；objectCode 是管理编码，不是不可变出处。未读取正文时只按实际目录摘要或检索片段表达，不声称读过全文。',
  '项目问题的记忆 scope 明确选 project；个人偏好与项目共识分开。讨论、确认与实际落实分别说明，代码和运行结论需对应执行证据；个人偏好或旧授权不能授予本轮提交、推送、合并或分析权限。',
] as const;

function memoryGuidance(harness?: string) {
  const captureGuidance = '用户仅声明新的偏好或补充信息时，先简短确认收到，是否已记录以实际采集回执为准，不为登记新信息重复检索。用户问既有规则、偏好或比较冲突时，再按当前问题取证。未拿到保存回执不声称已保存；pending仅表示已入队，completed后仍须按回执实际内容说明整理结果。';
  if (harness === 'dsh' || harness === 'opencode') {
    const name = 'read_memory_brief';
    const search = 'search_memory';
    return [
      ...projectRetrievalPolicy,
      '以下工具使用基名描述，调用时采用当前工具目录中对应的完整名称；宿主会按 MCP serverName 添加前缀，不能固定使用某个服务器前缀。',
      '你是当前项目成员的助手。团队自己的做法、决定与进度，以及我的工作风格，只有读取相应记录后才能知道。',
      captureGuidance,
      '项目资料保存在原业务库；记忆中的 project_material 是短索引卡，按需用 read_project_material 的 locator 实时读原文。问题明确指向资料时可直接 list_project_materials/glob_project_materials/grep_project_materials，不必先搜记忆。代码背景用 read_code_catalog/query_code_graph 或有固定本机运行时的 query_local_code；代码分析不代表实测。',
      '用户给了缺陷编号、错误码或文件路径时，先用原样标识调用 ' + search + '（scope=project），再围绕尚缺的依据查找。若问一般团队做法、决定或进度，先只读取 ' + name + '，参数 {"scope":"project"}。同一问题不要同时调用简报和搜索；结果缺少必要依据时再补查。',
      '若问我的做法或偏好，第一步调用 ' + name + '，参数 {"scope":"personal"}。常识和算术直接回答。',
      '共享资料只有验证方法、还需要核实过去实际做过什么时，用具体问题检索本人的实测笔记（scope=personal）。已有足够依据便可作答。',
      '检索返回 context_receipt 时，只在当前聊天沿用最新回执继续读取。读取会自动核验来源时效，无需再按 source 重读来重复校验；只有缺少原文或需要逐字核对时才调用 read_memory_source。unchanged_sources 指向本聊天仍保留的正文；压缩或摘要恢复后不再假定旧正文可见，首次读取省略回执。遇 unavailable_sources 必须停用旧出处并重新查当前材料。',
      '推送等一次性动作的许可由本轮操作者确认，绑定当前账号、项目、会话和具体操作；历史偏好或旧许可不能作为本次执行依据。',
      '每个关键判断后复制所用记录的 source。discussed、confirmed 描述议题记录；判断代码改动、测试或上线要分别引用能证明这件事的提交、运行记录或发布记录。找不到依据就说明未知。',
    ];
  }
  if (harness !== undefined) throw new DomainError('invalid_harness', '可选 dsh 或 opencode，省略时输出通用说明。');
  return [
    ...projectRetrievalPolicy,
    captureGuidance,
    '项目资料按需用 list_project_materials/glob_project_materials/grep_project_materials/read_project_material；CLI 同名能力见 tsp tools list，也有 tsp docs index/glob/grep/read。记忆中的 project_material 是短索引卡，依据 locator 实时查正文。代码检索用 read_code_catalog/query_code_graph/query_local_code，明确固定分析版本。',
    '涉及这个项目的业务规则或讨论进展时，先读取项目背景。涉及我的工作习惯时，先读取本人偏好。算术和通识直接回答。',
    '如宿主提供 read_mcp_resource，用 server="tsp_memory" 和 uri="tsp-memory://project/brief" 或 "tsp-memory://personal/preferences" 读取正文。',
    '支持 MCP 工具的宿主也可调用 read_memory_brief，scope 取 project 或 personal；命令行入口为 tsp memory brief --scope project 或 --scope personal。同一问题先选简报或搜索之一，结果缺少必要依据再补查。',
    '若给出了缺陷编号、错误码或文件路径，优先用 search_memory 在 project 搜索原样标识，再按缺口取证。需查本人的既往实测时选 personal。原样引用 source，分别核对议题状态、提交、测试和发布证据。个人偏好不授予执行权限。',
    '只在同一聊天继续传入最新 context_receipt。unchanged_sources 沿用仍保留的原文；读取自动核验时效，只有缺少原文或需逐字核对时用 read_memory_source。压缩或从摘要恢复后首次省略回执。unavailable_sources 代表当前不能再引用旧材料，须重查。一次性动作许可绑定本次具体操作，不从长期记忆推定。',
  ];
}

export async function readMemoryBrief(context: MemoryContext, scope: unknown) {
  if (scope !== 'project' && scope !== 'personal') throw new DomainError('invalid_scope', '请选择项目背景或个人偏好');
  const rows = valueOf(await context.client.request<unknown[]>('POST', context.route + '/brief', { scope }));
  if (!Array.isArray(rows) || rows.some(row => typeof row !== 'object' || row === null || !('scope' in row) || row.scope !== scope)) {
    throw new DomainError('memory_invalid_brief', '记忆摘要范围无效');
  }
  return rows;
}

export async function searchMemory(context: MemoryContext, query: string, scope?: unknown) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 256) throw new DomainError('invalid_query', '请输入 1 至 256 字符的查询');
  if (scope !== undefined && scope !== 'project' && scope !== 'personal') throw new DomainError('invalid_scope', '记忆范围应为 project 或 personal');
  return valueOf(await context.client.request<unknown[]>('POST', context.route + '/search', { query: query.trim(), scope }));
}

export async function readMemoryDocument(context: MemoryContext, input: { source: string; offset?: number; limit?: number; query?: string; occurrence?: 'first' | 'last' }) {
  const row = valueOf(await context.client.request<Record<string, unknown>>('POST', context.route + '/documents/read', input));
  if (!row || row.source !== input.source || row.sourceKind !== 'project_document' || row.scope !== 'project' ||
      typeof row.text !== 'string' || row.text.length > (input.limit ?? 4000) || !row.range || typeof row.range !== 'object') {
    throw new DomainError('memory_invalid_document', '文档原文返回的来源或范围无效。');
  }
  return row;
}

export async function stdinText(maxBytes: number) {
  if (process.stdin.isTTY) throw new DomainError('stdin_required', '请通过 stdin 提供内容');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new DomainError('input_too_large', '输入超出上限');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function registerMemoryCommands(program: Command, print: (result: { ok: true; data: unknown }) => void) {
  const memory = program.command('memory').description('检索项目与个人记忆，绑定并同步当前工作会话');
  memory.command('guidance').option('--harness <name>', 'dsh 或 opencode，省略时输出通用说明')
    .description('输出可交给宿主的检索说明').action(opts => {
    process.stdout.write(memoryGuidance(opts.harness).join('\n') + '\n');
  });
  memory.command('brief').requiredOption('--scope <scope>', 'project 或 personal')
    .description('读取当前项目近期共识或本人适用的偏好').action(async opts => {
      print({ ok: true, data: await readMemoryBrief(memoryContext(), opts.scope) });
    });
  memory.command('search <query>').option('--scope <scope>', 'project 或 personal，默认使用平台授权检索').description('按当前问题检索记忆').action(async (query, opts) => {
    print({ ok: true, data: await searchMemory(memoryContext(), query, opts.scope) });
  });
  const personal = memory.command('personal').description('管理本人偏好，source是管理ID，revisionSource才是当前可引用来源');
  personal.command('list').option('--project <code>', '仅列出适用于该项目的本人记忆')
    .option('--status <status>', 'active、withdrawn 或 all', 'active').action(async opts => {
      print({ ok: true, data: await (await import('./memory-personal.js')).listPersonalMemory(personalMemoryContext(), { projectCode: opts.project, status: opts.status }) });
    });
  personal.command('read <source>').description('读取本人记忆的当前版本、历史和同步状态').action(async source => {
    print({ ok: true, data: await (await import('./memory-personal.js')).readPersonalMemory(personalMemoryContext(), source) });
  });
  personal.command('edit <source>').requiredOption('--expected-revision <number>', '必须是刚读取的当前revision', Number)
    .option('--text <text>', '更新后的偏好原文；省略则从stdin读取').option('--reason <text>', '修订理由')
    .description('以版本并发校验修订或恢复本人偏好，不授予执行权限').action(async (source, opts) => {
      print({ ok: true, data: await (await import('./memory-personal.js')).editPersonalMemory(personalMemoryContext(), source,
        { expectedRevision: opts.expectedRevision, text: opts.text ?? await stdinText(32000), reason: opts.reason }) });
    });
  personal.command('withdraw <source>').requiredOption('--expected-revision <number>', '必须是刚读取的当前revision', Number)
    .option('--reason <text>', '撤回理由').description('撤回本人偏好并显示远端清理状态').action(async (source, opts) => {
      print({ ok: true, data: await (await import('./memory-personal.js')).withdrawPersonalMemory(personalMemoryContext(), source,
        { expectedRevision: opts.expectedRevision, reason: opts.reason }) });
    });
  memory.command('document <source>').option('--offset <number>', '沿用上次 nextOffset', Number)
    .option('--limit <number>', '每次 2 至 8000 字符，默认 4000', Number).option('--query <text>', '定位文档内字面内容，与 offset 二选一')
    .option('--occurrence <position>', 'query匹配 first 或 last，默认first')
    .description('按不可变文档来源分页读取当前有效原文').action(async (source, opts) => {
      print({ ok: true, data: await readMemoryDocument(memoryContext(), { source, offset: opts.offset, limit: opts.limit, query: opts.query, occurrence: opts.occurrence }) });
    });
  memory.command('mcp').description('启动项目记忆、资料和代码检索 MCP stdio 服务')
    .option('--project <code>', '默认项目编号，不要求工作区绑定')
    .option('--allow-personal-management', '额外开放本人记忆编辑/撤回；不扩大平台权限').action(async opts => {
    try { await (await import('./memory-mcp.js')).serveMemoryMcp({ personalManagement: !!opts.allowPersonalManagement, projectCode: opts.project }); }
    catch (error) {
      process.stderr.write((error instanceof DomainError ? error.code + ' ' + error.message : 'memory_mcp_failed') + '\n');
      process.exitCode = 1;
    }
  });
  const working = memory.command('context').description('管理当前工作会话的记忆来源恢复，不保存对话正文或动作许可');
  working.command('inspect').requiredOption('--session <id>').description('查看当前账号和项目的短期来源恢复状态').action(async opts => {
    print({ ok: true, data: await (await import('./memory-working-context.js')).inspectMemoryWorkingContext(opts.session) });
  });
  working.command('reset').requiredOption('--session <id>')
    .requiredOption('--reason <reason>', 'compaction、resume 或 new-chat')
    .description('宿主在压缩、恢复或开始新聊天时更新上下文代次').action(async opts => {
      print({ ok: true, data: await (await import('./memory-working-context.js')).resetMemoryWorkingContext(opts.session, opts.reason) });
    });
  working.command('clear').requiredOption('--session <id>').description('清除当前工作会话的短期来源记录').action(async opts => {
    print({ ok: true, data: await (await import('./memory-working-context.js')).clearMemoryWorkingContext(opts.session) });
  });
  memory.command('bind').requiredOption('--session <id>').option('--topic <code>').option('--requirement <code>')
    .option('--transcript <file>', 'Codex 会话 JSONL 的绝对路径，从当前位置开始采集')
    .description('为当前成员和项目的会话保存对象版本').action(async (opts) => {
      print({ ok: true, data: await (await import('./memory-capture.js')).bindSession(opts) });
    });
  memory.command('capture').requiredOption('--session <id>').requiredOption('--event <id>')
    .description('提交本次发言；无对象绑定时仅持久入队，旧绑定同步整理；重试沿用同一事件 ID').action(async (opts) => {
      const { captureText } = await import('./memory-capture.js');
      print({ ok: true, data: await captureText(opts.session, opts.event, await stdinText(32000)) });
    });
  const native = memory.command('native').description('原生宿主采集的本地持久队列；不作为 MCP 工具暴露');
  for (const action of ['install', 'doctor', 'uninstall'] as const) {
    native.command(action).requiredOption('--harness <name>', 'codex、dsh 或 opencode')
      .option('--workspace <directory>', '明确绑定项目的工作区根目录')
      .option('--host-home <directory>', '宿主配置根目录；默认采用该宿主的用户目录')
      .option('--config <file>', '明确的宿主配置文件绝对路径')
      .option('--runtime <file>', '已安装宿主的绝对入口；只接受已验证版本')
      .description(action === 'install' ? '持久注册当前工作区与账号，备份配置且只管理自有条目' :
        action === 'doctor' ? '检查采集权限、宿主配置、本地入队和最近的服务端采集编号' : '仅删除自有接入条目，保留其他插件与本地队列')
      .action(async opts => {
        const onboarding = await import('./memory-harness-install.js');
        const execute = action === 'install' ? onboarding.installHarness : action === 'doctor' ? onboarding.doctorHarness : onboarding.uninstallHarness;
        print({ ok: true, data: await execute(opts) });
      });
  }
  native.command('event').requiredOption('--installation <file>').description('接收已安装 Codex 原生事件；只输出合法 Hook JSON')
    .action(async opts => {
      try {
        await (await import('./memory-codex-lifecycle.js')).codexLifecycleEvent(opts.installation, JSON.parse(await stdinText(32000)));
        process.stdout.write('{}\n');
      } catch (error) {
        const code = error instanceof DomainError ? error.code : 'memory_harness_event_failed';
        process.stdout.write(JSON.stringify({ systemMessage: 'TeamSynergy 未采集当前输入：' + code + '。请运行 memory native doctor。' }) + '\n');
      }
    });
  native.command('config').requiredOption('--harness <name>', 'dsh 或 opencode').requiredOption('--host-session <id>')
    .option('--session <id>', '默认使用带宿主前缀的原生会话 ID').description('核验当前成员与项目并输出单会话插件配置').action(async opts => {
      const {nativeCaptureConfig}=await import('./memory-native-capture.js');
      print({ok:true,data:await nativeCaptureConfig({harness:opts.harness,hostSessionId:opts.hostSession,memorySession:opts.session})});
    });
  native.command('setup').requiredOption('--harness <name>', 'dsh 或 opencode').requiredOption('--host-session <id>')
    .option('--session <id>').option('--output <directory>', '仅写入新建绝对目录，默认本人私有配置目录')
    .description('生成当前项目与账号的原生采集插件配置，不修改宿主全局设置').action(async opts=>{
      const {setupNativeCapture}=await import('./memory-native-capture.js');
      print({ok:true,data:await setupNativeCapture({harness:opts.harness,hostSessionId:opts.hostSession,memorySession:opts.session,directory:opts.output})});
    });
  for (const action of ['enqueue','confirm','pending','status','drain','pump'] as const) {
    native.command(action).requiredOption('--harness <name>').requiredOption('--host-session <id>')
      .requiredOption('--session <id>').requiredOption('--owner <fingerprint>')
      .option('--message <id>', 'pending 精确读取原生消息').option('--after <cursor>', 'pending 读取游标之后的候选',Number).action(async opts => {
        const collector = await import('./memory-native-capture.js');
        const scope = { harness: opts.harness as 'dsh'|'opencode'|'codex',hostSessionId: opts.hostSession,memorySession: opts.session,owner: opts.owner };
        let data: unknown;
        if (action === 'enqueue') {
          let body: { event: import('./memory-native-capture.js').NativeCaptureEvent; ready: boolean };
          try { body = JSON.parse(await stdinText(32000)); } catch { throw new DomainError('memory_native_invalid','采集事件格式无效'); }
          if (!body || typeof body.ready !== 'boolean') throw new DomainError('memory_native_invalid','采集事件缺少持久化阶段');
          data = await collector.enqueueNativeCapture(scope,body.event,body.ready);
        } else if (action === 'confirm') {
          let body: { eventId: string; sourceText: string };
          try { body = JSON.parse(await stdinText(32000)); } catch { throw new DomainError('memory_native_invalid','确认事件格式无效'); }
          if (!body || typeof body.eventId !== 'string' || typeof body.sourceText !== 'string') throw new DomainError('memory_native_invalid','确认事件无效');
          data = await collector.confirmNativeCapture(scope,body);
        } else if (action === 'pending') data = await collector.pendingNativeCapture(scope,{nativeMessageId:opts.message,after:opts.after});
        else if (action === 'status') data = await collector.inspectNativeCapture(scope);
        else if (action === 'pump') data = await collector.pumpNativeCapture(scope);
        else data = await collector.drainNativeCapture(scope);
        print({ ok: true,data });
      });
  }
  memory.command('sync').requiredOption('--session <id>').description('同步新增的 Codex 用户发言，并单次查询未绑定会话的采集任务状态').action(async (opts) => {
    print({ ok: true, data: await (await import('./memory-capture.js')).syncSession(opts.session) });
  });
  memory.command('capture-status <captureCode>').description('查看已持久入队的采集任务；pending不代表已经整理').action(async captureCode => {
    print({ ok: true, data: await (await import('./memory-capture.js')).readCaptureJob(captureCode) });
  });
  memory.command('retry <captureCode>').description('显式重试失败采集任务，保留原事件与见证，不重跑已完成或待澄清任务').action(async captureCode => {
    print({ ok: true, data: await (await import('./memory-capture.js')).retryCaptureJob(captureCode) });
  });
  memory.command('unbind').requiredOption('--session <id>').description('停用此工作区的会话采集').action(async (opts) => {
    print({ ok: true, data: await (await import('./memory-capture.js')).unbindSession(opts.session) });
  });
  memory.command('hook').description('从 stdin 接收 Codex Stop 事件').action(async () => {
    try {
      await (await import('./memory-capture.js')).stopHook(await stdinText(32000));
    } catch (error) {
      process.stderr.write((error instanceof DomainError ? error.code + ' ' + error.message : 'memory_hook_failed') + '\n');
      process.exitCode = 1;
    }
  });
}

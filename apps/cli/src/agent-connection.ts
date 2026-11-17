import { createHash } from 'node:crypto';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import { createApiClient } from './api-client.js';
import { localDeviceFingerprint, readAuthConfig } from './auth-store.js';
import { normalizeApiUrl } from './device-identity.js';
import { identifyBoundProject } from './project-binding.js';
import { memoryContext, valueOf } from './memory.js';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectCode = (value: string) => {
  if (!PublicCodeSchema.safeParse(value).success) throw new DomainError('invalid_project_code', '项目编码必须为 20 位公开编码');
  return value;
};
const selectionHelp = '没有默认项目：用户只说“这个项目”等不明确指代时，先询问项目，停止读取项目内容，不自行猜选。用户已明确项目名称时，可调用 list_projects 定位对应编码，再传入 projectCode。也可用 tsp mcp --project <编码> 或 tsp project bind 设置默认项目。';

/** A connection can advertise tools before login or project selection. */
export function createAgentConnection(options: { projectCode?: string } = {}) {
  let accountIdentity: string | undefined;
  let defaultOwner: string | undefined;

  function authenticated() {
    const auth = readAuthConfig();
    if (!auth?.device_token) {
      if (accountIdentity) throw new DomainError('memory_binding_changed', '登录身份已变化，请重启 Agent 工具连接');
      throw new DomainError('login_required', '请先执行 tsp auth login 登录平台，再重试工具调用；无需重新配置 MCP。');
    }
    const api = normalizeApiUrl(auth.api_url);
    const identity = createHash('sha256').update(JSON.stringify([api, auth.user_code,
      localDeviceFingerprint(api, auth.device_token), auth.device_token])).digest('hex');
    if (accountIdentity && identity !== accountIdentity) throw new DomainError('memory_binding_changed', '登录身份已变化，请重启 Agent 工具连接');
    if (process.env.ACP_API_URL && normalizeApiUrl(process.env.ACP_API_URL) !== api) {
      throw new DomainError('memory_api_mismatch', 'API 地址与本机登录地址不一致');
    }
    accountIdentity ??= identity;
    return { auth, api, client: createApiClient({ baseUrl: api, deviceToken: auth.device_token,
      redirect: 'error', requestTimeoutMs: 12000 }) };
  }

  function defaultProject(api: string) {
    if (options.projectCode !== undefined) return { projectCode: projectCode(options.projectCode), projectSelection: 'startup' as const };
    try {
      const bound = identifyBoundProject(process.cwd());
      if (!bound) return { projectCode: null, projectSelection: 'required' as const };
      if (normalizeApiUrl(bound.binding.api_url) !== api) return { projectCode: null,
        projectSelection: 'required' as const, defaultProjectIssue: 'memory_api_mismatch' };
      return { projectCode: bound.binding.project_code, projectSelection: 'workspace' as const };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return { projectCode: null, projectSelection: 'required' as const, defaultProjectIssue: error.code };
    }
  }

  return {
    assertAccount() { authenticated(); },

    projectContext(explicitProjectCode?: string) {
      authenticated();
      const selected = explicitProjectCode ?? options.projectCode;
      let context;
      try { context = memoryContext(12000, selected); }
      catch (error) {
        if (error instanceof DomainError && error.code === 'project_binding_required') {
          throw new DomainError('project_selection_required', '当前连接未选择项目。' + selectionHelp);
        }
        throw error;
      }
      authenticated();
      if (explicitProjectCode === undefined) {
        if (defaultOwner && defaultOwner !== context.owner) throw new DomainError('memory_binding_changed', '默认工作区或项目绑定已变化，请重启 Agent 工具连接');
        defaultOwner ??= context.owner;
      }
      return context;
    },

    async getContext() {
      if (!readAuthConfig()?.device_token && !accountIdentity) return { connected: false, loginRequired: true,
        projectCode: null, projectSelection: 'required' as const, nextStep: '执行 tsp auth login 登录平台，然后调用 get_connection_context。' };
      const { auth, api, client } = authenticated();
      const user = valueOf(await client.request<unknown>('GET', '/auth/whoami'));
      authenticated();
      if (!record(user) || typeof user.user_code !== 'string') throw new DomainError('api_bad_response', '平台账号响应无效');
      if (user.user_code !== auth.user_code) throw new DomainError('memory_binding_changed', '登录凭据与账号记录不一致，请重新登录后重启工具连接');
      const selected = defaultProject(api);
      return { connected: true, loginRequired: false, apiUrl: api,
        account: { userCode: user.user_code,
          ...(typeof user.account === 'string' ? { account: user.account } : {}),
          ...(typeof user.display_name === 'string' ? { displayName: user.display_name } : {}) },
        ...selected, projectParameter: 'projectCode',
        nextStep: selected.projectCode ? '项目工具可沿用当前默认项目；其他项目须显式传入 projectCode。' : selectionHelp };
    },

    async listProjects(input: { query?: string; limit?: number } = {}) {
      const query = input.query?.trim() ?? '', limit = input.limit ?? 30;
      if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError('agent_invalid_input', '项目查询最多 200 字符，limit 应为 1 至 100 的整数');
      const { client } = authenticated();
      const rows = valueOf(await client.request<unknown>('GET', '/projects'));
      authenticated();
      if (!Array.isArray(rows) || rows.some(row => !record(row))) throw new DomainError('api_bad_response', '平台项目列表响应无效');
      const items = rows.flatMap(row => {
        const code = typeof row.project_code === 'string' ? row.project_code : row.code;
        if (typeof code !== 'string' || !PublicCodeSchema.safeParse(code).success) return [];
        if (typeof row.name !== 'string' || row.name.length > 500) throw new DomainError('api_bad_response', '平台项目名称响应无效');
        return [{ projectCode: code, name: row.name,
          ...(typeof row.team_code === 'string' ? { teamCode: row.team_code } : {}),
          ...(typeof row.team_name === 'string' ? { teamName: row.team_name } : {}),
          ...(row.status === 'active' || row.status === 'archived' ? { status: row.status } : {}) }];
      }).filter(row => !query || [row.projectCode, row.name, row.teamName ?? ''].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
      return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit,
        selection: '仅用此列表匹配用户明确给出的项目；用户未说明且无默认项目时先询问，不能通过读取各项目内容来猜选。在后续项目工具参数中传入所选 projectCode；不会修改本机工作区绑定。' };
    },
  };
}

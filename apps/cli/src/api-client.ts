/**
 * agentctl HTTP 同步客户端（TASK-111，docs/15 局域网共享 MVP）：
 * ACP_API_URL 设置时，任务状态一律通过 core-api HTTP 同步（服务端是状态真相源）；
 * 本地 git 操作（worktree 创建）仍在 CLI 侧完成。
 * 输出与本地模式相同 envelope：{ ok, data } / { ok: false, error }。
 */

import { authDirectory, matchesLocalDeviceFingerprint, readAuthConfig } from './auth-store.js';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface ApiClientOptions {
  baseUrl?: string;
  principalCode?: string;
  deviceToken?: string;
  skipAuth?: boolean;
  requestTimeoutMs?: number;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

function isApiEnvelope<T>(value: unknown): value is ApiResult<T> {
  return typeof value === 'object' && value !== null && 'ok' in value && typeof value.ok === 'boolean';
}

export function createApiClient(opts: ApiClientOptions) {
  const storedAuth = readAuthConfig();
  const baseUrl = (opts.baseUrl || storedAuth?.api_url || '').replace(/\/+$/, '');
  const storedToken = storedAuth?.api_url.replace(/\/+$/, '') === baseUrl ? storedAuth.device_token : undefined;
  // 身份优先级（docs/23）：显式 principalCode（机器模式/编排者指定）> 显式 deviceToken > ACP_TOKEN > 本机 auth.json
  // 显式 principalCode 时不带 Bearer，避免本机登录的 device token 覆盖编排者指定的执行身份
  const deviceToken = opts.skipAuth
    ? undefined
    : opts.principalCode
      ? undefined
      : opts.deviceToken || process.env.ACP_DEVICE_TOKEN || process.env.ACP_TOKEN || storedToken;

  async function request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResult<T>> {
    let res: Response;
    try {
      const headers: Record<string, string> = { ...extraHeaders };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (deviceToken) {
        headers.authorization = `Bearer ${deviceToken}`;
      } else if (opts.principalCode) {
        headers['x-principal-code'] = opts.principalCode;
      }
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(opts.requestTimeoutMs ? { signal: AbortSignal.timeout(opts.requestTimeoutMs) } : {}),
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'api_unreachable',
          message: `无法连接 core-api：${baseUrl}（${e instanceof Error ? e.message : String(e)}）`,
        },
      };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, error: { code: 'api_bad_response', message: `core-api 返回非 JSON（HTTP ${res.status}）` } };
    }
    if (isApiEnvelope<T>(parsed)) {
      return parsed;
    }
    return {
      ok: false,
      error: {
        code: res.ok ? 'api_bad_response' : 'api_http_error',
        message: `core-api 返回未预期响应（HTTP ${res.status}）`,
        details: parsed,
      },
    };
  }

  async function executionRequest<T>(route: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
    const headers: Record<string, string> = {};
    const runCode = typeof body.run_code === 'string' ? body.run_code : '';
    const directory = path.join(authDirectory(), 'handovers');
    if (deviceToken && runCode && existsSync(directory)) {
      for (const name of readdirSync(directory).filter((item) => /^[A-Za-z0-9_-]+\.json$/.test(item))) {
        const file = path.join(directory, name);
        let state: { api_url?: string; credential_fingerprint?: string; activated?: { run_code: string; execution_epoch: number; lease: { lease_token: string; expires_at?: string } } };
        try { state = JSON.parse(readFileSync(file, 'utf8')) as typeof state; } catch { continue; }
        const activated = state.activated;
        if (!activated || activated.run_code !== runCode || state.api_url !== baseUrl || !matchesLocalDeviceFingerprint(baseUrl, deviceToken, state.credential_fingerprint)) continue;
        if (activated.lease.expires_at && Date.parse(activated.lease.expires_at) <= Date.now() + 5000) {
          const renewed = await request<{ lease_token: string; expires_at: string }>('POST', `/runs/${encodeURIComponent(runCode)}/lease`, { execution_epoch: activated.execution_epoch });
          if (!renewed.ok) return renewed;
          activated.lease = renewed.data;
          writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        }
        headers['x-run-lease'] = activated.lease.lease_token;
        headers['x-execution-epoch'] = String(activated.execution_epoch);
        break;
      }
    }
    const environmentToken = process.env.ACP_RUN_LEASE_TOKEN;
    const environmentEpoch = process.env.ACP_EXECUTION_EPOCH;
    if (deviceToken && environmentToken && environmentEpoch && /^\d+$/.test(environmentEpoch)) {
      headers['x-run-lease'] = environmentToken;
      headers['x-execution-epoch'] = environmentEpoch;
    }
    if (deviceToken && runCode && !headers['x-run-lease']) {
      const execution = await request<{ status: string; execution_epoch: number }>('GET', `/runs/${encodeURIComponent(runCode)}/execution`);
      if (!execution.ok) return execution;
      if (execution.data.status === 'active' && execution.data.execution_epoch > 0) {
        const lease = await request<{ lease_token: string; execution_epoch: number }>('POST', `/runs/${encodeURIComponent(runCode)}/lease`, { execution_epoch: execution.data.execution_epoch });
        if (!lease.ok) return lease;
        headers['x-run-lease'] = lease.data.lease_token;
        headers['x-execution-epoch'] = String(lease.data.execution_epoch);
      }
    }
    return request('POST', route, body, headers);
  }

  return {
    request,
    async skillRequest<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: unknown): Promise<ApiResult<T>> {
      return request<T>(method, route, body);
    },
    async login(body: { bind_token: string; device_name: string; device_identity?: import('./device-identity.js').DeviceIdentity }): Promise<ApiResult<{ device_code: string; device_token: string; user_code: string; device_name: string }>> {
      return request('POST', '/auth/login', body);
    },
    async passwordLogin(body: { account: string; password: string; device_name: string; device_identity?: import('./device-identity.js').DeviceIdentity }): Promise<ApiResult<{ device_code: string; device_token: string; user_code: string; device_name: string }>> {
      return request('POST', '/auth/password-login', body);
    },
    async changePassword(body: { new_password: string; current_password?: string }): Promise<ApiResult<{ user_code: string; revoked_devices: number }>> {
      return request('POST', '/auth/password-change', body);
    },
    async logout(): Promise<ApiResult<{ logged_out: boolean; device_code: string }>> {
      return request('POST', '/auth/logout');
    },
    async whoami(): Promise<ApiResult<{
      user_code: string;
      account: string;
      display_name: string;
      status: string;
      is_system_admin: boolean;
      must_change_password: boolean;
    }>> {
      return request('GET', '/auth/whoami');
    },
    /** 读取任务当前快照（乐观并发：带 snapshot 提交） */
    async getTask(taskCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/tasks/${encodeURIComponent(taskCode)}`);
    },
    async getProjectDocument(projectCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/document`);
    },
    async getProjectHome(projectCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/home`);
    },
    async listHandoffLibrary(projectCode: string, query = ''): Promise<ApiResult<Record<string, unknown>>> {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/handoff${suffix}`);
    },
    async createHandoffFolder(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/handoff/folders`, body);
    },
    async updateHandoffFolder(folderCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/handoff-folders/${encodeURIComponent(folderCode)}`, body);
    },
    async createHandoffDocument(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/handoff/documents`, body);
    },
    async getHandoffDocument(documentCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/handoff-documents/${encodeURIComponent(documentCode)}`);
    },
    async reviseHandoffDocument(documentCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/handoff-documents/${encodeURIComponent(documentCode)}`, body);
    },
    async listRequirementDocuments(projectCode: string, query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/requirement-documents${suffix}`);
    },
    async getRequirementDocument(documentCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/requirement-documents/${encodeURIComponent(documentCode)}`);
    },
    async createRequirementDocument(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/requirement-documents`, body);
    },
    async reviseRequirementDocument(documentCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/requirement-documents/${encodeURIComponent(documentCode)}`, body);
    },
    async listArchitectureDocuments(projectCode: string, query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/architecture-documents${suffix}`);
    },
    async getArchitectureDocument(documentCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/architecture-documents/${encodeURIComponent(documentCode)}`);
    },
    async createArchitectureDocument(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/architecture-documents`, body);
    },
    async reviseArchitectureDocument(documentCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/architecture-documents/${encodeURIComponent(documentCode)}`, body);
    },
    async listRequirementIdeas(projectCode: string, query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/ideas${suffix}`);
    },
    async createRequirementIdea(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/ideas`, body);
    },
    async updateRequirementIdea(ideaCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/ideas/${encodeURIComponent(ideaCode)}`, body);
    },
    async listRequirementTopics(projectCode: string, query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/requirement-topics${suffix}`);
    },
    async createRequirementTopic(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/requirement-topics`, body);
    },
    async getRequirementTopic(topicCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/requirement-topics/${encodeURIComponent(topicCode)}`);
    },
    async updateRequirementTopic(topicCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/requirement-topics/${encodeURIComponent(topicCode)}`, body);
    },
    async addRequirementTopicEntry(topicCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-topics/${encodeURIComponent(topicCode)}/entries`, body);
    },
    async linkRequirementTopicIdeas(topicCode: string, ideaCodes: string[]): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-topics/${encodeURIComponent(topicCode)}/ideas`, { idea_codes: ideaCodes });
    },
    async linkRequirementTopicDocuments(topicCode: string, documentCodes: string[]): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-topics/${encodeURIComponent(topicCode)}/documents`, { document_codes: documentCodes });
    },
    async listRequirementDocumentReviews(documentCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/requirement-documents/${encodeURIComponent(documentCode)}/reviews`);
    },
    async startRequirementDocumentReview(documentCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-documents/${encodeURIComponent(documentCode)}/reviews`, {});
    },
    async getRequirementDocumentReview(reviewCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/requirement-document-reviews/${encodeURIComponent(reviewCode)}`);
    },
    async voteRequirementDocumentReview(reviewCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-document-reviews/${encodeURIComponent(reviewCode)}/vote`, body);
    },
    async closeRequirementDocumentReview(reviewCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/requirement-document-reviews/${encodeURIComponent(reviewCode)}/close`, body);
    },
    async listDesignPrototypes(projectCode: string, query = '', status = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      if (status.trim()) params.set('status', status.trim());
      const suffix = params.size ? `?${params.toString()}` : '';
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/design-prototypes${suffix}`);
    },
    async getDesignPrototype(prototypeCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/design-prototypes/${encodeURIComponent(prototypeCode)}`);
    },
    async downloadDesignPrototypeFile(prototypeCode: string, revision: number): Promise<ApiResult<Uint8Array>> {
      try {
        const headers: Record<string, string> = {};
        if (deviceToken) headers.authorization = `Bearer ${deviceToken}`;
        else if (opts.principalCode) headers['x-principal-code'] = opts.principalCode;
        const response = await fetch(`${baseUrl}/design-prototypes/${encodeURIComponent(prototypeCode)}/file?revision=${revision}`, { headers, redirect: 'error' });
        if (!response.ok) {
          const error: unknown = await response.json().catch(() => null);
          if (isApiEnvelope<Uint8Array>(error) && !error.ok) return error;
          return { ok: false, error: { code: 'api_http_error', message: `附件下载失败（HTTP ${response.status}）` } };
        }
        return { ok: true, data: new Uint8Array(await response.arrayBuffer()) };
      } catch (error) {
        return { ok: false, error: { code: 'api_unreachable', message: `无法下载原型附件（${error instanceof Error ? error.message : String(error)}）` } };
      }
    },
    async createDesignPrototype(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/design-prototypes`, body);
    },
    async reviseDesignPrototype(prototypeCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/design-prototypes/${encodeURIComponent(prototypeCode)}`, body);
    },
    async listTasks(query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/tasks${query}`);
    },
    async taskHistory(taskCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/tasks/${encodeURIComponent(taskCode)}/history`);
    },
    async createTask(body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/tasks', body);
    },
    async updateTaskContract(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/tasks/${encodeURIComponent(taskCode)}/contract`, body);
    },
    async cancelTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/tasks/${encodeURIComponent(taskCode)}/cancel`, body);
    },
    async assignTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/tasks/${encodeURIComponent(taskCode)}/assign`, body);
    },
    async claimTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/tasks/${encodeURIComponent(taskCode)}/claim`, body);
    },
    async submitTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return executionRequest(`/tasks/${encodeURIComponent(taskCode)}/submit`, body);
    },
    async verifyTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return executionRequest(`/tasks/${encodeURIComponent(taskCode)}/verify`, body);
    },
    async closeTask(taskCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/tasks/${encodeURIComponent(taskCode)}/close`, body);
    },
    async listMembers(): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', '/members');
    },
    async reportDefect(body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/defects', body);
    },
    async listDefects(query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/defects${query}`);
    },
    async createFeature(body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/features', body);
    },
    async listFeatures(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/features?project_code=${encodeURIComponent(projectCode)}`);
    },
    async getFeature(featureCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/features/${encodeURIComponent(featureCode)}`);
    },
    async updateFeature(featureCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/features/${encodeURIComponent(featureCode)}`, body);
    },
    async listModules(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/modules`);
    },
    async createModule(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/modules`, body);
    },
    async updateModule(moduleCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/modules/${encodeURIComponent(moduleCode)}`, body);
    },
    async listPhases(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/phases`);
    },
    async createPhase(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/phases`, body);
    },
    async updatePhase(phaseCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/phases/${encodeURIComponent(phaseCode)}`, body);
    },
    async listMilestones(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/milestones`);
    },
    async createMilestone(projectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/milestones`, body);
    },
    async updateMilestone(milestoneCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/milestones/${encodeURIComponent(milestoneCode)}`, body);
    },
    async createUser(account: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/users', { ...body, account });
    },
    async listUsers(): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', '/users');
    },
    async disableUser(userCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/users/${encodeURIComponent(userCode)}/disable`, {});
    },
    async transitionDefect(defectCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/defects/${encodeURIComponent(defectCode)}/transition`, body);
    },
    async permissionsRequest(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: unknown): Promise<ApiResult<unknown>> {
      return request(method, route, body);
    },
    async testingRequest(method: 'GET' | 'POST' | 'PATCH', route: string, body?: unknown): Promise<ApiResult<Record<string, unknown>>> {
      return request(method, route, body);
    },
    async createProject(body: { team_code: string; name: string; member_policy?: string }): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/projects', body);
    },
    async listProjects(principalCode?: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const query = principalCode ? `?principal_code=${encodeURIComponent(principalCode)}` : '';
      return request('GET', `/projects${query}`);
    },
    async listProjectRepositories(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/repositories`);
    },
    async registerProjectWorkspace(projectCode: string, body: { name: string }): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/projects/${encodeURIComponent(projectCode)}/workspaces`, body);
    },
    async listProjectMembers(projectCode: string): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', `/projects/${encodeURIComponent(projectCode)}/members`);
    },
    async createTeam(body: { name: string }): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/teams', body);
    },
    async listTeams(): Promise<ApiResult<Array<Record<string, unknown>>>> {
      return request('GET', '/teams');
    },
    async addTeamMember(teamCode: string, body: { user_code: string; role: string }): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', `/teams/${encodeURIComponent(teamCode)}/members`, body);
    },
    async createRequirement(body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('POST', '/requirements', body);
    },
    async listRequirements(projectCode?: string, query = ''): Promise<ApiResult<Array<Record<string, unknown>>>> {
      const params = new URLSearchParams();
      if (projectCode) params.set('project_code', projectCode);
      if (query.trim()) params.set('q', query.trim());
      const suffix = params.size ? `?${params.toString()}` : '';
      return request('GET', `/requirements${suffix}`);
    },
    async getRequirement(requirementCode: string): Promise<ApiResult<Record<string, unknown>>> {
      return request('GET', `/requirements/${encodeURIComponent(requirementCode)}`);
    },
    async updateRequirement(requirementCode: string, body: Record<string, unknown>): Promise<ApiResult<Record<string, unknown>>> {
      return request('PATCH', `/requirements/${encodeURIComponent(requirementCode)}`, body);
    },
  };
}

export function apiUrlConfigured(): boolean {
  // 已配置 ACP_API_URL 或本机存在登录凭据（auth.json）时，命令走 core-api 同步通道
  const configuredUrl = process.env.ACP_API_URL?.trim() || readAuthConfig()?.api_url.trim() || '';
  return configuredUrl.length > 0;
}

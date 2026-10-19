import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';

export interface BoundProject {
  schema_version?: number;
  project_code: string;
  project_workspace_code?: string;
  api_url: string;
  bound_at: string;
}

export interface IdentifiedBoundProject {
  path: string;
  binding: BoundProject;
}

function serialize(binding: BoundProject): string {
  return [
    ...(binding.schema_version ? [`schema_version: ${binding.schema_version}`] : []),
    `project_code: ${JSON.stringify(binding.project_code)}`,
    ...(binding.project_workspace_code ? [`project_workspace_code: ${JSON.stringify(binding.project_workspace_code)}`] : []),
    `api_url: ${JSON.stringify(binding.api_url)}`,
    `bound_at: ${JSON.stringify(binding.bound_at)}`,
    '',
  ].join('\n');
}

function parseScalar(value: string): string {
  if (value.startsWith('"')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') return parsed;
  }
  return value;
}

function parse(content: string): BoundProject {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(':');
    if (separator < 1) throw new DomainError('project_binding_invalid', 'bound-project.yaml 格式无效');
    values.set(line.slice(0, separator).trim(), parseScalar(line.slice(separator + 1).trim()));
  }
  // project_id 仅用于读取旧绑定文件；新文件只写 project_code。
  const projectCode = values.get('project_code') ?? values.get('project_id');
  const apiUrl = values.get('api_url');
  const boundAt = values.get('bound_at');
  if (!projectCode || !apiUrl || !boundAt) {
    throw new DomainError('project_binding_invalid', 'bound-project.yaml 缺少必要字段');
  }
  const schemaVersion = values.get('schema_version');
  const workspaceCode = values.get('project_workspace_code');
  return {
    ...(schemaVersion && Number.isInteger(Number(schemaVersion)) ? { schema_version: Number(schemaVersion) } : {}),
    project_code: projectCode,
    ...(workspaceCode ? { project_workspace_code: workspaceCode } : {}),
    api_url: apiUrl,
    bound_at: boundAt,
  };
}

export function bindProject(
  startDir: string,
  projectCode: string,
  apiUrl: string,
  options: { projectWorkspaceCode?: string; schemaVersion?: number } = {},
): IdentifiedBoundProject {
  if (!projectCode) throw new DomainError('project_code_required', 'project_code 不能为空');
  if (!apiUrl) throw new DomainError('api_url_required', '绑定项目需要 ACP_API_URL 或已登录的 API 地址');
  const agentDir = path.join(path.resolve(startDir), '.agent');
  const bindingPath = path.join(agentDir, 'bound-project.yaml');
  const binding: BoundProject = {
    ...(options.schemaVersion ? { schema_version: options.schemaVersion } : {}),
    project_code: projectCode,
    ...(options.projectWorkspaceCode ? { project_workspace_code: options.projectWorkspaceCode } : {}),
    api_url: apiUrl.replace(/\/+$/, ''),
    bound_at: new Date().toISOString(),
  };
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(bindingPath, serialize(binding), 'utf8');
  return { path: bindingPath, binding };
}

export function identifyBoundProject(startDir: string): IdentifiedBoundProject | null {
  let directory = path.resolve(startDir);
  while (true) {
    const bindingPath = path.join(directory, '.agent', 'bound-project.yaml');
    if (existsSync(bindingPath)) {
      return { path: bindingPath, binding: parse(readFileSync(bindingPath, 'utf8')) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

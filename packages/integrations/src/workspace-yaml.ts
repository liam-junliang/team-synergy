import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '@team-synergy/domain';
import { ProfileSchema, PUBLIC_CODE_PATTERN } from '@team-synergy/contracts';

/**
 * `.agent/workspace.yaml`：Run 工作区的非敏感身份与基线（docs/04）。
 * MVP 手写序列化/解析（字段为标量），但解析结果经 Zod 全量校验
 * （review 建议 2：类型校验 + 拒绝非法值）。
 */

export interface WorkspaceMeta {
  project_code: string;
  feature_code: string;
  task_code: string;
  run_code: string;
  workspace_code: string;
  agent_profile: string;
  project_snapshot: number;
  git_base: string;
}

const REQUIRED_FIELDS = [
  'project_code',
  'feature_code',
  'task_code',
  'run_code',
  'workspace_code',
  'agent_profile',
  'project_snapshot',
  'git_base',
] as const;

const MetaSchema = z.object({
  project_code: z.string().regex(PUBLIC_CODE_PATTERN),
  feature_code: z.string().regex(PUBLIC_CODE_PATTERN),
  task_code: z.string().regex(PUBLIC_CODE_PATTERN),
  run_code: z.string().regex(PUBLIC_CODE_PATTERN),
  workspace_code: z.string().regex(PUBLIC_CODE_PATTERN),
  agent_profile: ProfileSchema,
  project_snapshot: z.coerce.number().int().nonnegative(),
  git_base: z.string().min(1),
});

/** 标量字段安全断言：值不得破坏 YAML 结构（换行、冒号+空格） */
function assertSafeScalar(key: string, value: string | number): void {
  const s = String(value);
  if (/[\r\n]/.test(s) || s.includes(': ')) {
    throw new DomainError('workspace_yaml_unsafe_value', `workspace.yaml 字段 ${key} 包含不安全字符`, { key });
  }
}

export function serializeWorkspaceYaml(meta: WorkspaceMeta): string {
  const parsed = MetaSchema.safeParse(meta);
  if (!parsed.success) {
    throw new DomainError('workspace_yaml_invalid', 'workspace.yaml 元数据不合法', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  for (const [key, value] of Object.entries(meta)) {
    assertSafeScalar(key, value);
  }
  return [
    `project_code: ${meta.project_code}`,
    `feature_code: ${meta.feature_code}`,
    `task_code: ${meta.task_code}`,
    `run_code: ${meta.run_code}`,
    `workspace_code: ${meta.workspace_code}`,
    `agent_profile: ${meta.agent_profile}`,
    `project_snapshot: ${meta.project_snapshot}`,
    `git_base: ${meta.git_base}`,
    '',
  ].join('\n');
}

export function parseWorkspaceYaml(content: string): WorkspaceMeta {
  const map = new Map<string, string>();
  const seen = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (seen.has(key)) {
      throw new DomainError('workspace_yaml_duplicate_key', `workspace.yaml 存在重复字段：${key}`);
    }
    seen.add(key);
    map.set(key, value);
  }
  const legacy = !map.has('project_code') && map.has('project_id');
  for (const field of REQUIRED_FIELDS) {
    const legacyField = field.replace('_code', '_id');
    if (!map.has(field) && !(legacy && map.has(legacyField))) {
      throw new DomainError('workspace_yaml_invalid', `workspace.yaml 缺少字段：${field}`);
    }
  }
  const candidate = {
    project_code: map.get(legacy ? 'project_id' : 'project_code'),
    feature_code: map.get(legacy ? 'feature_id' : 'feature_code'),
    task_code: map.get(legacy ? 'task_id' : 'task_code'),
    run_code: map.get(legacy ? 'run_id' : 'run_code'),
    workspace_code: map.get(legacy ? 'workspace_id' : 'workspace_code'),
    agent_profile: map.get('agent_profile'),
    project_snapshot: map.get('project_snapshot'),
    git_base: map.get('git_base'),
  };
  const parsed = legacy
    ? MetaSchema.extend({
      project_code: z.string().min(1),
      feature_code: z.string().min(1),
      task_code: z.string().min(1),
      run_code: z.string().min(1),
      workspace_code: z.string().min(1),
    }).safeParse(candidate)
    : MetaSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new DomainError('workspace_yaml_invalid', 'workspace.yaml 字段校验失败', {
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  return parsed.data;
}

export interface IdentifiedWorkspace {
  workspaceRoot: string;
  meta: WorkspaceMeta;
}

/**
 * 识别工作区：从 dir 向上查找 .agent/workspace.yaml（docs/06 身份解析优先级）。
 */
export function identifyWorkspace(startDir: string): IdentifiedWorkspace | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, '.agent', 'workspace.yaml');
    if (existsSync(candidate)) {
      const meta = parseWorkspaceYaml(readFileSync(candidate, 'utf8'));
      return { workspaceRoot: dir, meta };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

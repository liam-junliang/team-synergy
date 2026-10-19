import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import type { ProjectSkillManifest, RunSkillManifest } from '@team-synergy/contracts';
import type { createApiClient } from './api-client.js';
import { syncSkillManifest } from './skill-sync.js';

export interface RunSkillContext { manifest: RunSkillManifest; directory: string }

/** A separate managed directory per Run prevents ordinary project sync from changing active execution inputs. */
export async function prepareRunSkillContext(api: ReturnType<typeof createApiClient>, workspaceRoot: string, runCode: string): Promise<RunSkillContext> {
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(runCode)) throw new DomainError('skill_run_invalid', 'Run 编码不正确');
  const response = await api.request<ProjectSkillManifest>('GET', `/runs/${encodeURIComponent(runCode)}/skills`);
  if (!response.ok) throw new DomainError(response.error.code, response.error.message,
    response.error.details && typeof response.error.details === 'object' && !Array.isArray(response.error.details)
      ? response.error.details as Record<string, unknown> : undefined);
  const manifest = response.data;
  const synced = syncSkillManifest(path.join(workspaceRoot, '.agent', 'runs', runCode), manifest, { createRoot: true });
  return { directory: synced.directory, manifest: { project_code: manifest.project_code, generation: manifest.generation,
    skills: manifest.skills.map(({ files: _files, ...metadata }) => metadata) } };
}

export function renderRunSkillIndex(context?: RunSkillContext): string {
  if (!context) return '# Run 技能\n\n本次上下文未包含技能清单。\n';
  const lines = ['# Run 固定版本技能', '', `项目：${context.manifest.project_code}；安装清单版本：${context.manifest.generation}`, '',
    '以下版本在领取或交接时固定。按用途读取 SKILL.md 及相对资源；技能说明不扩大当前账号、设备或 Run 的授权。', ''];
  for (const skill of context.manifest.skills) {
    const location = path.join(context.directory, skill.alias, 'SKILL.md').replaceAll('\\', '/');
    lines.push(`## ${skill.alias}`, '', `- 来源：${skill.scope_type} / ${skill.scope_code}`, `- 技能：${skill.skill_code} · r${skill.revision}`,
      `- SHA-256：${skill.package_sha256}`, `- 本机文件：${location}`, '', skill.description, '');
  }
  if (!context.manifest.skills.length) lines.push('该 Run 未启用技能。');
  return lines.join('\n') + '\n';
}

import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_MAX_BYTES, IntakeBundleSchema, PublicCodeSchema, intakeManifestText, type IntakeBundle } from '@team-synergy/contracts';
import { assertIntakeRegularPath, readIntakeGit, readIntakeSourceFile, scanIntakeSource, sha256 } from '@team-synergy/integrations';
import { identifyBoundProject } from './project-binding.js';
import { readRepositoryRegistry } from './project-workspace.js';
export { assertIntakeRegularPath, isExcludedIntakePath, isIntakeTextPath, normalizeIntakeScopes, readIntakeSourceFile, scanIntakeSource, sha256 } from '@team-synergy/integrations';

const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function intakeBinding(startDir: string, projectCode?: string, apiUrl?: string) {
  const identified = identifyBoundProject(startDir);
  if (!identified) throw new DomainError('project_binding_not_found', '代码规格接入需要先绑定本机项目工作空间');
  if (projectCode && projectCode !== identified.binding.project_code) throw new DomainError('intake_project_mismatch', '候选项目与当前工作空间绑定不一致');
  if (apiUrl && apiUrl.replace(/\/+$/, '') !== identified.binding.api_url.replace(/\/+$/, '')) throw new DomainError('intake_platform_mismatch', '当前 CLI 平台地址与项目绑定不一致，请检查登录和工作空间');
  PublicCodeSchema.parse(identified.binding.project_code);
  const workspace = path.dirname(path.dirname(identified.path));
  assertIntakeRegularPath(identified.path);
  return { workspace, ...identified.binding };
}

export function intakeRepository(startDir: string, projectCode: string, repositoryCode: string): string {
  PublicCodeSchema.parse(repositoryCode);
  const { workspace } = intakeBinding(startDir, projectCode);
  assertIntakeRegularPath(path.join(workspace, '.agent', 'repositories.local.yaml'));
  const registered = readRepositoryRegistry(workspace).filter(item => item.repository_code === repositoryCode);
  const repository = registered[0];
  if (registered.length !== 1 || !repository) throw new DomainError('intake_repository_not_bound', '仓库尚未绑定到当前工作空间，请先执行 tsp repository attach 或 clone');
  const root = path.resolve(workspace, repository.path);
  assertIntakeRegularPath(root);
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new DomainError('intake_repository_missing', '本机绑定仓库目录不存在');
  if (path.resolve(readIntakeGit(root, ['rev-parse', '--show-toplevel']).trim()) !== root) throw new DomainError('intake_repository_invalid', '绑定路径必须是 Git 仓库根目录');
  return root;
}

export function intakeNamespace(workspace: string, repositoryCode: string | null, materialKeys: string[] = []): string {
  const identity = repositoryCode === null ? `materials-${sha256([...materialKeys].sort(ordinal).join('\n')).slice(0, 32)}` : PublicCodeSchema.parse(repositoryCode);
  const file = path.join(workspace, '.agent', 'intake', `${identity}.json`);
  assertIntakeRegularPath(file);
  mkdirSync(path.dirname(file), { recursive: true });
  try { writeFileSync(file, JSON.stringify({ namespace: `source-${randomUUID()}` }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('namespace' in parsed) || typeof parsed.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(parsed.namespace)) throw new DomainError('intake_namespace_invalid', '本机接入来源记录损坏，请保留文件并检查');
  return parsed.namespace;
}

export function readIntakeBundle(file: string): IntakeBundle {
  const absolute = path.resolve(file);
  assertIntakeRegularPath(absolute);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.size > INTAKE_MAX_BYTES) throw new DomainError('intake_input_invalid', '候选包必须是至多 10 MiB 的普通 JSON 文件');
  let input: unknown;
  try { input = JSON.parse(readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new DomainError('intake_input_invalid', '候选包不是有效 JSON'); }
  if (input && typeof input === 'object' && 'items' in input && Array.isArray(input.items) && input.items.length === 0) throw new DomainError('intake_candidates_required', 'prepare 只生成清单。请让本机 Agent 阅读 SKILL.md、按真实源码填写 items，再 validate；不会自动调用模型');
  const result = IntakeBundleSchema.safeParse(input);
  if (!result.success) throw new DomainError('intake_bundle_invalid', '候选包不符合代码规格协议', { issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  if (sha256(intakeManifestText(result.data.source.files)) !== result.data.source.manifest_sha256) throw new DomainError('intake_manifest_invalid', '文件清单摘要不匹配，不能修改源码指纹来绕过重新分析');
  return result.data;
}

export function validateIntakeSource(bundle: IntakeBundle, startDir: string): void {
  if (!bundle.repository_code) throw new DomainError('intake_local_sources_required', '资料来源需要 prepare 生成的本机来源映射');
  const root = intakeRepository(startDir, bundle.project_code, bundle.repository_code);
  const current = scanIntakeSource(root, bundle.source.scope, bundle.source.include_untracked ?? false);
  if (current.manifest_sha256 !== bundle.source.manifest_sha256 || current.commit !== bundle.source.commit || current.dirty !== bundle.source.dirty) throw new DomainError('intake_source_changed', '本机源码或 Git 状态与候选快照不一致，请重新 prepare 并复核候选；未上传任何资料');
  const anchors = [...bundle.items.flatMap(item => item.evidence), ...(bundle.source.production?.capabilities.flatMap(item => item.evidence) ?? []), ...(bundle.source.production?.conflicts.flatMap(item => item.evidence) ?? [])];
  for (const evidence of anchors) {
    const bytes = readIntakeSourceFile(root, evidence.path);
    if (!bytes || evidence.line_end > bytes.toString('utf8').split(/\r?\n/).length) throw new DomainError('intake_evidence_invalid', '候选证据行号超出当前源码文件');
    if (sha256(bytes) !== evidence.sha256) throw new DomainError('intake_source_changed', '证据检查期间来源文件发生变化，请重新 prepare');
  }
}

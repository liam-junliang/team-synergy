import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { INTAKE_SKILL_VERSION, intakeManifestText, type IntakeBundle } from '@team-synergy/contracts';
import { assertIntakeRegularPath, intakeRepository, isExcludedIntakePath, isIntakeTextPath, normalizeIntakeScopes, readIntakeSourceFile, scanIntakeSource, sha256, validateIntakeSource } from './intake-source.js';

const LOCAL_SOURCES_FILE = 'intake.sources.local.json';
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export interface IntakeLocalInput { key: string; kind: 'document' | 'team_note'; root: string; prefix: string; label: string }
export interface IntakeLocalSources {
  version: 1; project_code: string; repository_code: string | null;
  code_scopes: string[]; include_untracked: boolean; materials: IntakeLocalInput[];
}

export function parseIntakeMaterials(materials: string[] = [], notes: string[] = []): IntakeLocalInput[] {
  const result: IntakeLocalInput[] = [];
  for (const [kind, declarations] of [['document', materials], ['team_note', notes]] as const) {
    for (const declaration of declarations) {
      const separator = declaration.indexOf('=');
      const key = declaration.slice(0, separator);
      if (separator < 1 || !/^[a-z][a-z0-9_-]{0,39}$/.test(key) || key === 'repository' || !declaration.slice(separator + 1).trim()) throw new DomainError('intake_material_invalid', '资料参数需为 key=path；key 使用小写字母开头的 1–40 个字母、数字、_ 或 -，repository 保留给代码');
      if (result.some(input => input.key === key)) throw new DomainError('intake_material_collision', '每个资料来源的 key 必须唯一');
      const root = path.resolve(declaration.slice(separator + 1));
      assertIntakeRegularPath(root);
      if (!existsSync(root) || (!lstatSync(root).isFile() && !lstatSync(root).isDirectory())) throw new DomainError('intake_material_missing', '资料来源必须是存在的普通文本文件或目录');
      if (isExcludedIntakePath(path.basename(root))) throw new DomainError('intake_material_excluded', '资料来源名称被安全规则排除');
      result.push({ key, kind, root, label: key, prefix: `materials/${key}` });
    }
  }
  if (result.length > 49) throw new DomainError('intake_source_too_large', '一次最多 49 个补充来源，请合并相关资料目录');
  return result.sort((a, b) => ordinal(a.key, b.key));
}

export function assertIntakeOutputOutsideMaterials(out: string, inputs: IntakeLocalInput[]): void {
  for (const input of inputs) {
    const relative = path.relative(input.root, out);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new DomainError('intake_output_in_materials', '输出目录不能位于输入资料目录中，以免把生成资料当作新证据');
  }
}

function scanMaterial(input: IntakeLocalInput) {
  assertIntakeRegularPath(input.root);
  if (!existsSync(input.root)) throw new DomainError('intake_material_missing', '本机资料来源已不存在');
  const directory = lstatSync(input.root).isDirectory();
  const root = directory ? input.root : path.dirname(input.root);
  const candidates: string[] = [];
  let excluded = 0;
  let visited = 0;
  const walk = (relative: string) => {
    if (++visited > 50_000) throw new DomainError('intake_source_too_large', '资料目录过大，请缩小输入目录');
    if (isExcludedIntakePath(relative)) { excluded++; return; }
    const absolute = path.join(root, relative);
    assertIntakeRegularPath(absolute);
    const info = lstatSync(absolute);
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort(ordinal)) walk(`${relative}/${name}`);
    } else if (info.isFile()) {
      if (candidates.length >= 20_000) throw new DomainError('intake_source_too_large', '资料来源超过 20000 个文件，请缩小输入目录');
      candidates.push(relative);
    }
  };
  if (directory) for (const name of readdirSync(root).sort(ordinal)) walk(name);
  else walk(path.basename(input.root));
  const files: Array<{ path: string; sha256: string }> = [];
  for (const relative of candidates) {
    if (isExcludedIntakePath(`${input.prefix}/${relative}`) || (!isIntakeTextPath(relative) && !/\.(?:csv|tsv|adoc|org)$/i.test(relative))) { excluded++; continue; }
    const bytes = readIntakeSourceFile(root, relative);
    if (bytes === null) { excluded++; continue; }
    files.push({ path: `${input.prefix}/${relative}`, sha256: sha256(bytes) });
  }
  if (!files.length) throw new DomainError('intake_source_empty', `资料 ${input.key} 没有可读取的安全 UTF-8 文本；请先在本机将二进制文档转换成文本并保留原资料版本`);
  return { files, excluded };
}

/** Absolute local roots never enter the public bundle. */
export function scanIntakeInputs(config: IntakeLocalSources, startDir: string): IntakeBundle['source'] {
  const capture = () => {
    const code = config.repository_code ? scanIntakeSource(intakeRepository(startDir, config.project_code, config.repository_code), config.code_scopes, config.include_untracked) : null;
    if (code?.files.some(file => file.path.startsWith('materials/'))) throw new DomainError('intake_material_collision', 'materials/ 保留给补充资料虚拟路径；请缩小仓库 --scope 或将该目录作为独立 --material 来源');
    const inputs: NonNullable<IntakeBundle['source']['inputs']> = code ? [{ key: 'repository', kind: 'code', label: 'repository', prefix: '.', ...(code.commit ? { revision: code.commit } : {}) }] : [];
    const files = [...(code?.files ?? [])];
    const exclusions = [...(code?.exclusions ?? [])];
    for (const material of config.materials) {
      if (files.some(file => file.path === material.prefix || file.path.startsWith(`${material.prefix}/`))) throw new DomainError('intake_material_collision', '仓库路径与资料虚拟路径冲突，请更换资料 key');
      const snapshot = scanMaterial(material);
      files.push(...snapshot.files);
      inputs.push({ key: material.key, kind: material.kind, label: material.label, prefix: material.prefix });
      exclusions.push(`${material.prefix}: excluded ${snapshot.excluded} credential, generated, unsupported, binary, non-UTF-8 or oversized entries.`);
    }
    if (files.length > 20_000) throw new DomainError('intake_source_too_large', '合并来源超过 20000 个文件，请缩小范围');
    files.sort((a, b) => ordinal(a.path, b.path));
    const source: IntakeBundle['source'] = {
      commit: code?.commit ?? null, dirty: code?.dirty ?? false,
      scope: [...(code?.scope ?? []), ...config.materials.map(input => input.prefix)].sort(ordinal),
      files, manifest_sha256: sha256(intakeManifestText(files)), complete: false, exclusions,
      analyzed_at: new Date().toISOString(), skill_version: INTAKE_SKILL_VERSION,
      mode: code ? config.materials.length ? 'mixed' : 'repository' : 'materials', inputs,
      ...(config.include_untracked ? { include_untracked: true } : {}),
    };
    return source;
  };
  const before = capture();
  // Repository capture already performs two passes; combined material inputs need
  // an additional full pass so changes between sources cannot produce a mixed snapshot.
  const after = config.materials.length ? capture() : before;
  if (before.manifest_sha256 !== after.manifest_sha256 || before.commit !== after.commit || before.dirty !== after.dirty) throw new DomainError('intake_source_changed', '采集期间输入来源发生变化，请停止修改后重新 prepare');
  return after;
}

export function writeIntakeLocalSources(directory: string, config: IntakeLocalSources): void {
  writeFileSync(path.join(directory, LOCAL_SOURCES_FILE), JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function readLocalSources(file: string, bundle: IntakeBundle): IntakeLocalSources {
  const local = path.join(path.dirname(path.resolve(file)), LOCAL_SOURCES_FILE);
  assertIntakeRegularPath(local);
  if (!existsSync(local) || !lstatSync(local).isFile() || lstatSync(local).size > 100_000) throw new DomainError('intake_local_sources_required', '缺少 prepare 生成的 intake.sources.local.json 本机来源映射；请保留候选并重新 prepare');
  let parsed: IntakeLocalSources;
  try { parsed = JSON.parse(readFileSync(local, 'utf8')); } catch { throw new DomainError('intake_local_sources_invalid', '本机来源映射不是有效 JSON'); }
  if (!parsed || parsed.version !== 1 || parsed.project_code !== bundle.project_code || parsed.repository_code !== bundle.repository_code || !Array.isArray(parsed.code_scopes) || !parsed.code_scopes.every(scope => typeof scope === 'string') || typeof parsed.include_untracked !== 'boolean' || !Array.isArray(parsed.materials) || parsed.materials.length > 50) throw new DomainError('intake_local_sources_invalid', '本机来源映射与候选不一致');
  for (const input of parsed.materials) {
    if (!input || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.key) || input.key === 'repository' || !['document', 'team_note'].includes(input.kind) || input.label !== input.key || input.prefix !== `materials/${input.key}` || typeof input.root !== 'string' || !path.isAbsolute(input.root)) throw new DomainError('intake_local_sources_invalid', '本机资料来源映射无效');
  }
  if (new Set(parsed.materials.map(input => input.key)).size !== parsed.materials.length || parsed.include_untracked !== (bundle.source.include_untracked ?? false)) throw new DomainError('intake_local_sources_invalid', '本机来源映射与候选扫描模式不一致');
  if (parsed.repository_code) normalizeIntakeScopes(parsed.code_scopes);
  else if (parsed.code_scopes.length || !parsed.materials.length || parsed.include_untracked) throw new DomainError('intake_local_sources_invalid', '纯资料接入不能包含代码范围或未跟踪文件选项');
  return parsed;
}

export function validateIntakeInputs(bundle: IntakeBundle, startDir: string, file: string): void {
  if (!bundle.source.inputs) { validateIntakeSource(bundle, startDir); return; }
  const config = readLocalSources(file, bundle);
  const current = scanIntakeInputs(config, startDir);
  if (current.manifest_sha256 !== bundle.source.manifest_sha256 || current.commit !== bundle.source.commit || current.dirty !== bundle.source.dirty || current.mode !== bundle.source.mode || JSON.stringify(current.scope) !== JSON.stringify([...bundle.source.scope].sort(ordinal)) || JSON.stringify(current.inputs) !== JSON.stringify([...bundle.source.inputs].sort((a, b) => a.kind === 'code' ? -1 : b.kind === 'code' ? 1 : ordinal(a.key, b.key)))) throw new DomainError('intake_source_changed', '本机输入资料、代码或来源配置已变化，请重新 prepare 并复核候选；未上传任何资料');
  const codeRoot = config.repository_code ? intakeRepository(startDir, bundle.project_code, config.repository_code) : null;
  const anchors = [...bundle.items.flatMap(item => item.evidence), ...(bundle.source.production?.capabilities.flatMap(item => item.evidence) ?? []), ...(bundle.source.production?.conflicts.flatMap(item => item.evidence) ?? [])];
  const checkedFiles = new Map<string, { lines: number; hash: string }>();
  for (const evidence of anchors) {
    let checked = checkedFiles.get(evidence.path);
    if (!checked) {
      const material = config.materials.find(input => evidence.path.startsWith(`${input.prefix}/`));
      const root = material ? lstatSync(material.root).isDirectory() ? material.root : path.dirname(material.root) : codeRoot;
      const relative = material ? evidence.path.slice(material.prefix.length + 1) : evidence.path;
      const bytes = root ? readIntakeSourceFile(root, relative) : null;
      if (!bytes) throw new DomainError('intake_evidence_invalid', '候选证据文件已不可读取');
      checked = { lines: bytes.toString('utf8').split(/\r?\n/).length, hash: sha256(bytes) };
      checkedFiles.set(evidence.path, checked);
    }
    if (evidence.line_end > checked.lines) throw new DomainError('intake_evidence_invalid', '候选证据行号超出当前来源文件');
    if (checked.hash !== evidence.sha256) throw new DomainError('intake_source_changed', '证据检查期间来源文件发生变化，请重新 prepare');
  }
}

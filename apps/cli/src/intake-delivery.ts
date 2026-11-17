import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { evaluateIntakeQuality, renderIntakeSpecification, type IntakeBundle, type IntakeItem } from '@team-synergy/contracts';
import { assertIntakeRegularPath, sha256 } from './intake-source.js';

const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => ordinal(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
const sorted = <T>(values: T[]) => [...values].sort((a, b) => ordinal(stable(a), stable(b)));
function comparableItem(item: IntakeItem) {
  return { ...item, evidence: sorted(item.evidence), tests: sorted(item.tests), gaps: sorted(item.gaps), ...(item.acceptance_criteria ? { acceptance_criteria: [...item.acceptance_criteria].sort((a, b) => ordinal(a.id, b.id)) } : {}), ...(item.verification_plan ? { verification_plan: sorted(item.verification_plan) } : {}) };
}
function changes<T>(before: Map<string, T>, after: Map<string, T>) {
  return {
    added: [...after.keys()].filter(key => !before.has(key)).sort(ordinal),
    removed: [...before.keys()].filter(key => !after.has(key)).sort(ordinal),
    changed: [...before.keys()].filter(key => after.has(key) && stable(before.get(key)) !== stable(after.get(key))).sort(ordinal),
  };
}
const changedKeys = (result: ReturnType<typeof changes>) => [...result.added, ...result.removed, ...result.changed];
function comparisonSnapshot(bundle: IntakeBundle) {
  const { analyzed_at: _analyzedAt, production, ...source } = bundle.source;
  return {
    ...bundle, items: bundle.items.map(comparableItem).sort((a, b) => ordinal(a.key, b.key)),
    source: { ...source, files: [...source.files].sort((a, b) => ordinal(a.path, b.path)), scope: sorted(source.scope), exclusions: sorted(source.exclusions), ...(source.inputs ? { inputs: sorted(source.inputs) } : {}), ...(production ? { production: { ...production, capabilities: [...production.capabilities].map(item => ({ ...item, requirement_keys: sorted(item.requirement_keys), evidence: sorted(item.evidence) })).sort((a, b) => ordinal(a.key, b.key)), conflicts: [...production.conflicts].map(item => ({ ...item, evidence: sorted(item.evidence) })).sort((a, b) => ordinal(a.key, b.key)) } } : {}) },
  };
}

/** Historical comparison deliberately does not re-open sources or require a workspace binding. */
export function diffIntakeBundles(before: IntakeBundle, after: IntakeBundle) {
  if (before.project_code !== after.project_code || before.namespace !== after.namespace || before.repository_code !== after.repository_code) throw new DomainError('intake_diff_identity_mismatch', '只能比较同一项目、来源 namespace 和仓库的候选；不同项目需分别评估');
  const sources = changes(new Map(before.source.files.map(file => [file.path, file.sha256])), new Map(after.source.files.map(file => [file.path, file.sha256])));
  const items = changes(new Map(before.items.map(item => [item.key, comparableItem(item)])), new Map(after.items.map(item => [item.key, comparableItem(item)])));
  const criteria = (bundle: IntakeBundle) => new Map(bundle.items.flatMap(item => (item.acceptance_criteria ?? []).map(ac => [`${item.key}/${ac.id}`, ac.text] as const)));
  const acceptance_criteria = changes(criteria(before), criteria(after));
  const capabilities = changes(new Map((before.source.production?.capabilities ?? []).map(item => [item.key, { ...item, evidence: sorted(item.evidence), requirement_keys: sorted(item.requirement_keys) }])), new Map((after.source.production?.capabilities ?? []).map(item => [item.key, { ...item, evidence: sorted(item.evidence), requirement_keys: sorted(item.requirement_keys) }])));
  const conflicts = changes(new Map((before.source.production?.conflicts ?? []).map(item => [item.key, { ...item, evidence: sorted(item.evidence) }])), new Map((after.source.production?.conflicts ?? []).map(item => [item.key, { ...item, evidence: sorted(item.evidence) }])));
  const changedPaths = new Set(changedKeys(sources));
  const affected = new Set(changedKeys(items));
  const allItems = [...before.items, ...after.items];
  for (const item of allItems) if (item.evidence.some(evidence => changedPaths.has(evidence.path)) || item.tests.some(test => changedPaths.has(test.path))) affected.add(item.key);
  const changedCapabilities = new Set(changedKeys(capabilities));
  for (const capability of [...(before.source.production?.capabilities ?? []), ...(after.source.production?.capabilities ?? [])]) {
    if (changedCapabilities.has(capability.key) || capability.evidence.some(evidence => changedPaths.has(evidence.path))) for (const key of capability.requirement_keys) affected.add(key);
  }
  const changedConflicts = new Set(changedKeys(conflicts));
  const conflictPaths = new Set([...(before.source.production?.conflicts ?? []), ...(after.source.production?.conflicts ?? [])].filter(item => changedConflicts.has(item.key)).flatMap(item => item.evidence.map(evidence => evidence.path)));
  for (const item of allItems) if (item.evidence.some(evidence => conflictPaths.has(evidence.path))) affected.add(item.key);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const item of allItems) if (!affected.has(item.key) && [item.module_key, item.feature_key, item.document_key].some(key => key && affected.has(key))) { affected.add(item.key); expanded = true; }
  }
  const previous_hash = sha256(stable(comparisonSnapshot(before)));
  const current_hash = sha256(stable(comparisonSnapshot(after)));
  return { previous_hash, current_hash, unchanged: previous_hash === current_hash, sources, items, acceptance_criteria, capabilities, conflicts, affected_keys: [...affected].sort(ordinal), source_metadata_changed: stable({ commit: before.source.commit, dirty: before.source.dirty, inputs: before.source.inputs ? sorted(before.source.inputs) : undefined }) !== stable({ commit: after.source.commit, dirty: after.source.dirty, inputs: after.source.inputs ? sorted(after.source.inputs) : undefined }), note: '影响范围来自已声明证据和父子关联；未发现或未关联的能力仍需 Agent 复查。时间戳和集合顺序不会制造差异。' };
}

export function exportIntakeBundle(bundle: IntakeBundle, output: string) {
  const directory = path.resolve(output);
  assertIntakeRegularPath(directory);
  if (existsSync(directory)) throw new DomainError('intake_output_exists', '输出目录已存在，请指定新目录');
  mkdirSync(directory, { recursive: true });
  const documents = bundle.items.filter(item => ['requirement_document', 'requirement', 'architecture'].includes(item.kind)).sort((a, b) => ordinal(a.key, b.key));
  // The hash avoids collisions on case-insensitive filesystems and never uses an untrusted title as a path.
  const files = documents.map(item => {
    const file = `${item.key.replaceAll(':', '-').slice(0, 60)}-${sha256(item.key).slice(0, 12)}.md`;
    const text = `${item.content_markdown.trim()}\n\n${renderIntakeSpecification(item)}`.trim() + '\n';
    writeFileSync(path.join(directory, file), text, { flag: 'wx', mode: 0o600 });
    return { key: item.key, title: item.title, file, sha256: sha256(text) };
  });
  const quality = evaluateIntakeQuality(bundle);
  writeFileSync(path.join(directory, 'quality-report.json'), JSON.stringify(quality, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(directory, 'index.md'), ['# 规格资料导出', '', `来源摘要：\`${bundle.source.manifest_sha256}\``, '', '这是候选规格及验证计划；规则结果不表示语义批准或测试已执行。', '', ...files.map(item => `- [${item.title.replaceAll('[', '').replaceAll(']', '').replaceAll('\\', '')}](${item.file})`), ''].join('\n'), { flag: 'wx', mode: 0o600 });
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ schema_version: 1, project_code: bundle.project_code, namespace: bundle.namespace, source_manifest_sha256: bundle.source.manifest_sha256, files }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { directory, document_count: files.length, files, quality, submitted: false };
}

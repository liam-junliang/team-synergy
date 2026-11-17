import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { assertIntakeRegularPath } from '@team-synergy/integrations';
import type { CodeSnapshot } from '@team-synergy/contracts';

export const semanticDigest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const SEMANTIC_PROMPT_VERSION = 'tsp-hosted-ua-full-2.1.0';
export interface SourceEvidence { path: string; line_start: number; line_end: number }
export interface SemanticSegment {
  id: string; path: string; file_sha256: string; input_sha256: string; byte_start: number; byte_end: number;
  line_start: number; line_end: number; text: string;
}
export interface SemanticPlan { snapshot_id: string; manifest_sha256: string; total_bytes: number; total_files: number; segments: SemanticSegment[]; batches: SemanticSegment[][] }
export interface SegmentFact {
  segment_id: string; input_sha256: string; summary: string; responsibility: string;
  behaviors: { description: string; evidence: SourceEvidence[] }[];
  state_owners: string[]; user_purposes: string[];
  dependencies: { target: string; type: string; description: string; evidence: SourceEvidence[]; status: 'observed' | 'inferred' | 'unknown' }[];
  evidence: SourceEvidence[]; unknowns: string[];
}
export interface FileBrief {
  path: string; sha256: string; input_sha256: string; summary: string; responsibility: string;
  behaviors: SegmentFact['behaviors']; state_owners: string[]; user_purposes: string[];
  dependencies: SegmentFact['dependencies']; evidence: SourceEvidence[]; unknowns: string[]; segment_ids: string[];
}
export interface SemanticProgress {
  phase: 'files' | 'reduce' | 'consistency' | 'architecture' | 'tour' | 'review'; completed: number; total: number;
  completed_segments: number; total_segments: number; cached_segments: number; completed_files: number; total_files: number;
}
export interface SemanticQuality {
  protocol_version: 2; snapshot_id: string; manifest_sha256: string; prompt_version: string;
  full_source_coverage: boolean; total_files: number; total_segments: number; completed_segments: number; total_bytes: number; covered_bytes: number;
  file_coverage: { path: string; sha256: string; total_bytes: number; covered_bytes: number; segments: { id: string; byte_start: number; byte_end: number; input_sha256: string; completed: boolean; line_start: number; line_end: number }[] }[];
  relation_evidence: { source: string; target: string; type: string; evidence: SourceEvidence[]; basis: 'native_dependency' | 'semantic_inference'; native_ids?: string[] }[];
  node_evidence: { node_id: string; evidence: SourceEvidence[] }[];
  unresolved: { scope: string; description: string }[];
  statistics: Record<string, number>; phases: string[]; review: unknown; semantic_correctness: 'requires_independent_evaluation';
  model_audits: string[]; cache_hits: number; file_ownership: { path: string; module_id: string; rationale: string }[];
}
export interface SemanticSchemaIssue {
  path: string; rule: 'type' | 'required' | 'unexpected_fields' | 'non_empty' | 'max_length' | 'max_items' | 'min_items' | 'enum' | 'unique_items' | 'exact_items';
  expected?: string; observed_type?: string; observed_length?: number; observed_count?: number; maximum?: number; minimum?: number; allowed_values?: readonly string[];
}
const schemaType = (value: unknown): string => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
export function semanticInvalid(reason: string, repairable = true, fields: string[] = [], schemaIssues: SemanticSchemaIssue[] = [], schemaIssueCount = schemaIssues.length): never {
  throw new DomainError('code_analysis_model_invalid', '全仓语义结果未通过严格校验', { reason, repairable, issue_paths: (fields.length ? fields : reason === 'schema' ? ['$'] : []).slice(0, 20), ...(schemaIssues.length ? { schema_issues: schemaIssues.slice(0, 40), schema_issue_count: schemaIssueCount } : {}) });
}
export function stopSemantic(signal?: AbortSignal) { if (signal?.aborted) throw new DomainError('code_analysis_cancelled', '服务端分析已中止'); }
export function requireSemanticValue<T>(value: T | undefined): T { if (value === undefined) return semanticInvalid('internal_reference', false); return value; }

/** Every byte occurs in exactly one segment, including trailing newlines and oversized single lines. */
export function planSemanticSource(snapshot: CodeSnapshot, sourceDirectory: string, segmentBytes = 24 * 1024, batchBytes = 40 * 1024): SemanticPlan {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 16 || segmentBytes > 32 * 1024 || batchBytes < segmentBytes || batchBytes > 48 * 1024) throw new DomainError('code_analysis_source_invalid', '语义分段预算无效');
  const segments: SemanticSegment[] = [];
  let total = 0;
  for (const file of [...snapshot.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const location = path.join(sourceDirectory, file.path); assertIntakeRegularPath(location);
    const bytes = readFileSync(location);
    if (bytes.length !== file.byte_count || semanticDigest(bytes) !== file.sha256) throw new DomainError('code_snapshot_changed', '语义分析源码与固定清单不一致');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new DomainError('code_analysis_source_invalid', '语义源码必须是有效UTF-8'); }
    total += bytes.length;
    let start = 0, line = bytes.length ? 1 : 0;
    do {
      let end = Math.min(bytes.length, start + segmentBytes);
      if (end < bytes.length) {
        while (end > start && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
        const newline = bytes.lastIndexOf(10, end - 1);
        if (newline >= start + Math.floor(segmentBytes / 2)) end = newline + 1;
      }
      const content = bytes.subarray(start, end), text = content.toString('utf8');
      const newlines = content.reduce((sum, byte) => sum + Number(byte === 10), 0);
      const lineEnd = line + newlines;
      const identity = { path: file.path, file_sha256: file.sha256, byte_start: start, byte_end: end, line_start: line, line_end: lineEnd, content_sha256: semanticDigest(content) };
      const input_sha256 = semanticDigest(identity);
      segments.push({ id: `segment:${input_sha256.slice(0, 32)}`, ...identity, input_sha256, text });
      start = end; line = lineEnd;
    } while (start < bytes.length);
  }
  const batches: SemanticSegment[][] = []; let current: SemanticSegment[] = [], size = 0;
  for (const segment of segments) {
    const bytes = segment.byte_end - segment.byte_start;
    if (current.length && (current.length >= 4 || size + bytes > batchBytes)) { batches.push(current); current = []; size = 0; }
    current.push(segment); size += bytes;
  }
  if (current.length) batches.push(current);
  return { snapshot_id: snapshot.snapshot_id, manifest_sha256: snapshot.manifest_sha256, total_bytes: total, total_files: snapshot.files.length, segments, batches };
}

export const objectRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export function strictObject(value: unknown, required: string[], optional: string[] = [], fieldPath = '$'): Record<string, unknown> {
  if (!objectRecord(value)) return semanticInvalid('schema', true, [fieldPath], [{ path: fieldPath, rule: 'type', expected: 'object', observed_type: schemaType(value) }]);
  const missing = required.filter(key => !(key in value)), unexpected = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key)).length;
  const issues: SemanticSchemaIssue[] = missing.map(key => ({ path: `${fieldPath}.${key}`, rule: 'required' }));
  if (unexpected) issues.push({ path: fieldPath, rule: 'unexpected_fields', observed_count: unexpected, maximum: 0, allowed_values: [...required, ...optional] });
  if (issues.length) return semanticInvalid('schema', true, issues.map(issue => issue.path), issues);
  return value;
}
export function textField(value: unknown, max = 1200, fieldPath = '$'): string {
  const issue: SemanticSchemaIssue | undefined = typeof value !== 'string' ? { path: fieldPath, rule: 'type', expected: 'string', observed_type: schemaType(value) } : !value.trim() ? { path: fieldPath, rule: 'non_empty', observed_length: value.length, minimum: 1 } : value.length > max ? { path: fieldPath, rule: 'max_length', observed_length: value.length, maximum: max } : undefined;
  if (issue) return semanticInvalid('schema', true, [fieldPath], [issue]);
  return value as string;
}
export function listField(value: unknown, max: number, fieldPath = '$'): unknown[] {
  if (!Array.isArray(value)) return semanticInvalid('schema', true, [fieldPath], [{ path: fieldPath, rule: 'type', expected: 'array', observed_type: schemaType(value) }]);
  if (value.length > max) return semanticInvalid('schema', true, [fieldPath], [{ path: fieldPath, rule: 'max_items', observed_count: value.length, maximum: max }]);
  return value;
}
export function stringsField(value: unknown, max = 20, fieldPath = '$'): string[] { return listField(value, max, fieldPath).map((item, index) => textField(item, 800, `${fieldPath}[${index}]`)); }
export function evidenceField(value: unknown, segments: Pick<SemanticSegment, 'path' | 'line_start' | 'line_end'>[], required = true): SourceEvidence[] {
  const rows = listField(value, 20).map(item => {
    const row = strictObject(item, ['path', 'line_start', 'line_end']);
    if (typeof row.path !== 'string' || !Number.isInteger(row.line_start) || !Number.isInteger(row.line_end) || Number(row.line_start) < 1 || Number(row.line_end) < Number(row.line_start) || !segments.some(segment => segment.path === row.path && Number(row.line_start) >= segment.line_start && Number(row.line_end) <= segment.line_end)) return semanticInvalid('source_range');
    return { path: row.path, line_start: Number(row.line_start), line_end: Number(row.line_end) };
  });
  if (required && !rows.length) return semanticInvalid('evidence_required');
  return rows;
}
export interface SemanticEvidenceCatalog { entries: (SourceEvidence & { id: string })[]; facts: Record<string, unknown>[] }
type SemanticShape =
  | { type: 'string'; maxLength?: number; minLength: 1; enum?: readonly string[] }
  | { type: 'array'; maxItems: number; minItems?: number; items: SemanticShape }
  | { type: 'object'; additionalProperties: false; required: readonly string[]; properties: Record<string, SemanticShape> };
const reduceText = (maxLength?: number): SemanticShape => ({ type: 'string', minLength: 1, ...(maxLength ? { maxLength } : {}) });
const reduceIds = (minItems = 1): SemanticShape => ({ type: 'array', minItems, maxItems: 20, items: reduceText() });
const reduceStrings: SemanticShape = { type: 'array', maxItems: 20, items: reduceText(800) };
/** This schema is also supplied to every reducer, including hierarchical merge layers. */
export const FILE_REDUCE_OUTPUT_SCHEMA: SemanticShape = {
  type: 'object', additionalProperties: false,
  required: ['path', 'input_sha256', 'summary', 'responsibility', 'behaviors', 'state_owners', 'user_purposes', 'dependencies', 'evidence_ids', 'unknowns'],
  properties: {
    path: reduceText(), input_sha256: reduceText(), summary: reduceText(1200), responsibility: reduceText(800),
    behaviors: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['description', 'evidence_ids'], properties: { description: reduceText(800), evidence_ids: reduceIds() } } },
    state_owners: reduceStrings, user_purposes: reduceStrings,
    dependencies: { type: 'array', maxItems: 24, items: { type: 'object', additionalProperties: false, required: ['target', 'type', 'description', 'evidence_ids', 'status'], properties: { target: reduceText(500), type: reduceText(80), description: reduceText(500), evidence_ids: reduceIds(), status: { type: 'string', minLength: 1, enum: ['observed', 'inferred', 'unknown'] } } } },
    evidence_ids: reduceIds(0), unknowns: reduceStrings,
  },
};
/** Shape diagnostics include only host-defined paths and sizes/types, never response text or unknown key names. */
export function inspectReducedFileBriefShape(value: unknown): { issues: SemanticSchemaIssue[]; total: number } {
  const issues: SemanticSchemaIssue[] = []; let total = 0;
  const add = (issue: SemanticSchemaIssue) => { total++; if (issues.length < 40) issues.push(issue); };
  function visit(input: unknown, schema: SemanticShape, fieldPath: string): void {
    if (schema.type === 'object') {
      if (!objectRecord(input)) { add({ path: fieldPath, rule: 'type', expected: 'object', observed_type: schemaType(input) }); return; }
      for (const key of schema.required) if (!Object.hasOwn(input, key)) add({ path: `${fieldPath}.${key}`, rule: 'required' });
      const unexpected = Object.keys(input).filter(key => !Object.hasOwn(schema.properties, key)).length;
      if (unexpected) add({ path: fieldPath, rule: 'unexpected_fields', observed_count: unexpected, maximum: 0 });
      for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(input, key)) visit(input[key], child, `${fieldPath}.${key}`);
    } else if (schema.type === 'array') {
      if (!Array.isArray(input)) { add({ path: fieldPath, rule: 'type', expected: 'array', observed_type: schemaType(input) }); return; }
      if (input.length > schema.maxItems) add({ path: fieldPath, rule: 'max_items', observed_count: input.length, maximum: schema.maxItems });
      if (input.length < (schema.minItems ?? 0)) add({ path: fieldPath, rule: 'min_items', observed_count: input.length, minimum: schema.minItems });
      input.slice(0, schema.maxItems).forEach((item, index) => visit(item, schema.items, `${fieldPath}[${index}]`));
    } else {
      if (typeof input !== 'string') { add({ path: fieldPath, rule: 'type', expected: 'string', observed_type: schemaType(input) }); return; }
      if (!input.trim()) add({ path: fieldPath, rule: 'non_empty', observed_length: input.length, minimum: 1 });
      if (schema.maxLength && input.length > schema.maxLength) add({ path: fieldPath, rule: 'max_length', observed_length: input.length, maximum: schema.maxLength });
      if (schema.enum && !schema.enum.includes(input)) add({ path: fieldPath, rule: 'enum', allowed_values: schema.enum });
    }
  }
  visit(value, FILE_REDUCE_OUTPUT_SCHEMA, '$');
  return { issues, total };
}
/** A reducer selects immutable source support; it never manufactures new line ranges. */
export function createSemanticEvidenceCatalog(facts: (SegmentFact | FileBrief)[]): SemanticEvidenceCatalog {
  const ranges = new Map<string, SourceEvidence>();
  const key = (item: SourceEvidence) => JSON.stringify([item.path, item.line_start, item.line_end]);
  for (const fact of facts) for (const item of [...fact.evidence, ...fact.behaviors.flatMap(behavior => behavior.evidence), ...fact.dependencies.flatMap(dependency => dependency.evidence)]) ranges.set(key(item), { ...item });
  const ordered = [...ranges.values()].sort((left, right) => left.path.localeCompare(right.path) || left.line_start - right.line_start || left.line_end - right.line_end);
  const entries = ordered.map((item, index) => ({ id: `E${String(index + 1).padStart(3, '0')}`, ...item }));
  const ids = new Map(entries.map(item => [key(item), item.id]));
  const refs = (items: SourceEvidence[]) => [...new Set(items.map(item => requireSemanticValue(ids.get(key(item)))))];
  return { entries, facts: facts.map(fact => {
    const { evidence, behaviors, dependencies, ...rest } = fact;
    return { ...rest, evidence_ids: refs(evidence), behaviors: behaviors.map(behavior => ({ description: behavior.description, evidence_ids: refs(behavior.evidence) })), dependencies: dependencies.map(dependency => { const { evidence, ...rest } = dependency; return { ...rest, evidence_ids: refs(evidence) }; }) };
  }) };
}
export function resolveSemanticEvidenceIds(value: unknown, catalog: SemanticEvidenceCatalog['entries'], required = true, fieldPath = '$.evidence_ids'): SourceEvidence[] {
  const ids = listField(value, 20, fieldPath);
  if (required && !ids.length) return semanticInvalid('evidence_required', true, [fieldPath]);
  if (new Set(ids).size !== ids.length) return semanticInvalid('evidence_catalog_duplicate', true, [fieldPath]);
  return ids.map(id => {
    const entry = typeof id === 'string' ? catalog.find(entry => entry.id === id) : undefined;
    if (!entry) return semanticInvalid('evidence_catalog_id', true, [fieldPath]);
    return { path: entry.path, line_start: entry.line_start, line_end: entry.line_end };
  });
}
export function validateReducedFileBrief(value: unknown, context: { file: CodeSnapshot['files'][number]; input_sha256: string; segment_ids: string[] }, catalog: SemanticEvidenceCatalog): FileBrief {
  const shape = inspectReducedFileBriefShape(value);
  if (shape.total) return semanticInvalid('schema', true, shape.issues.map(issue => issue.path), shape.issues, shape.total);
  const row = strictObject(value, ['path', 'input_sha256', 'summary', 'responsibility', 'behaviors', 'state_owners', 'user_purposes', 'dependencies', 'evidence_ids', 'unknowns']);
  const { file, input_sha256, segment_ids } = context;
  if (row.path !== file.path || row.input_sha256 !== input_sha256) return semanticInvalid('file_reduce_identity', true, ['$.path', '$.input_sha256']);
  const behaviors = listField(row.behaviors, 20).map((item, index) => { const behavior = strictObject(item, ['description', 'evidence_ids']); return { description: textField(behavior.description, 800), evidence: resolveSemanticEvidenceIds(behavior.evidence_ids, catalog.entries, true, `$.behaviors[${index}].evidence_ids`) }; });
  const dependencies = listField(row.dependencies, 24).map((item, index) => { const dependency = strictObject(item, ['target', 'type', 'description', 'evidence_ids', 'status']); return { target: textField(dependency.target, 500), type: textField(dependency.type, 80), description: textField(dependency.description, 500), evidence: resolveSemanticEvidenceIds(dependency.evidence_ids, catalog.entries, true, `$.dependencies[${index}].evidence_ids`), status: dependency.status as SegmentFact['dependencies'][number]['status'] }; });
  return { path: file.path, sha256: file.sha256, input_sha256, segment_ids, summary: textField(row.summary, 1200), responsibility: textField(row.responsibility, 800), behaviors, dependencies, evidence: resolveSemanticEvidenceIds(row.evidence_ids, catalog.entries, file.byte_count > 0), state_owners: stringsField(row.state_owners, 20), user_purposes: stringsField(row.user_purposes, 20), unknowns: stringsField(row.unknowns, 20) };
}
export function validateSegmentFacts(value: unknown, expected: SemanticSegment[]): SegmentFact[] {
  const output = strictObject(value, ['segments']);
  const items = listField(output.segments, 12);
  if (items.length !== expected.length) return semanticInvalid('segment_coverage');
  const found = new Set<string>();
  return items.map(item => {
    const row = strictObject(item, ['segment_id', 'input_sha256', 'summary', 'responsibility', 'behaviors', 'state_owners', 'user_purposes', 'dependencies', 'evidence', 'unknowns']);
    const segment = expected.find(entry => entry.id === row.segment_id);
    if (!segment || found.has(segment.id) || row.input_sha256 !== segment.input_sha256) return semanticInvalid('segment_identity');
    found.add(segment.id);
    const evidence = evidenceField(row.evidence, [segment], Boolean(segment.text.length));
    const behaviors = listField(row.behaviors, 12).map(item => { const behavior = strictObject(item, ['description', 'evidence']); return { description: textField(behavior.description, 800), evidence: evidenceField(behavior.evidence, [segment]) }; });
    const dependencies = listField(row.dependencies, 16).map(item => {
      const dependency = strictObject(item, ['target', 'type', 'description', 'evidence', 'status']);
      if (!['observed', 'inferred', 'unknown'].includes(String(dependency.status))) return semanticInvalid('schema');
      return { target: textField(dependency.target, 500), type: textField(dependency.type, 80), description: textField(dependency.description, 500), evidence: evidenceField(dependency.evidence, [segment]), status: dependency.status as SegmentFact['dependencies'][number]['status'] };
    });
    return { segment_id: segment.id, input_sha256: segment.input_sha256, summary: textField(row.summary, 1200), responsibility: textField(row.responsibility, 800), behaviors, dependencies, evidence, state_owners: stringsField(row.state_owners, 12), user_purposes: stringsField(row.user_purposes, 12), unknowns: stringsField(row.unknowns, 12) };
  });
}

import { objectRecord, semanticDigest, semanticInvalid, type SemanticSchemaIssue, type SourceEvidence } from './code-analysis-semantic-source.js';

export const ARCHITECTURE_EVIDENCE_PROTOCOL = 'architecture-evidence-1.0.0';
export type ArchitectureWireShape =
  | { type: 'string'; minLength: number; maxLength: number; enum?: readonly string[]; pattern?: string }
  | { type: 'integer'; minimum: number; maximum: number }
  | { type: 'array'; minItems: number; maxItems: number; items: ArchitectureWireShape }
  | { type: 'object'; additionalProperties: false; required: string[]; properties: Record<string, ArchitectureWireShape> };
export const wireText = (maximum = 800, values?: readonly string[]): ArchitectureWireShape => ({ type: 'string', minLength: 1, maxLength: maximum, ...(values ? { enum: values } : {}) });
export const wireList = (maximum: number, items: ArchitectureWireShape, minimum = 0): ArchitectureWireShape => ({ type: 'array', minItems: minimum, maxItems: maximum, items });
export const wireObject = (properties: Record<string, ArchitectureWireShape>): ArchitectureWireShape => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const strings = (maximum: number) => wireList(maximum, wireText());
const evidenceIds = () => wireList(20, wireText(100), 1);
const rule = () => wireObject({ description: wireText(500), evidence_ids: evidenceIds() });
const node = (prefix: string, extra: Record<string, ArchitectureWireShape>) => wireObject({ id: { type: 'string', minLength: prefix.length + 2, maxLength: prefix.length + 81, pattern: `^${prefix}:[a-z][a-z0-9-]{0,79}$` }, name: wireText(150), summary: wireText(1600), business_rules: wireList(12, rule()), evidence_ids: evidenceIds(), ...extra });
export const ARCHITECTURE_RELATION_TYPES = ['depends_on', 'calls', 'reads_from', 'writes_to', 'validates', 'configures', 'documents', 'related', 'cross_domain', 'serves', 'contains_flow', 'routes', 'tested_by'] as const;
export const GLOBAL_ARCHITECTURE_OUTPUT_SCHEMA = wireObject({
  description: wireText(3000), languages: strings(20), frameworks: strings(30),
  modules: wireList(10, node('module', { state_owners: strings(12), user_purposes: strings(12) }), 1),
  capabilities: wireList(24, node('capability', { module_ids: wireList(10, wireText(), 1) }), 1),
  flows: wireList(12, node('flow', { steps: wireList(12, wireObject({ capability_id: wireText(), description: wireText(800), evidence_ids: evidenceIds() }), 1) }), 1),
  relations: wireList(80, wireObject({ source: wireText(), target: wireText(), type: wireText(80, ARCHITECTURE_RELATION_TYPES), description: wireText(1200), evidence_ids: evidenceIds() })),
  unknowns: strings(40),
});
export function architectureProposalOutputSchema(options: { relatedPaths: number; unknowns: number; requireProposal: boolean; relatedPathIds?: readonly string[] }) {
  const paths: Record<string, ArchitectureWireShape> = options.relatedPathIds === undefined ? { related_paths: wireList(options.relatedPaths, wireText(), options.requireProposal ? 0 : 1) } : { related_path_ids: wireList(options.relatedPaths, wireText(100, options.relatedPathIds), 1) };
  return wireObject({ proposals: wireList(10, wireObject({ name: wireText(150), responsibility: wireText(1200), state_owners: strings(12), user_purposes: strings(12),
    business_rules: wireList(20, rule()), evidence_ids: evidenceIds(), ...paths, unknowns: strings(options.unknowns) }), options.relatedPathIds !== undefined || options.requireProposal ? 1 : 0) });
}
export const ARCHITECTURE_REVIEW_OUTPUT_SCHEMA = wireObject({
  findings: wireList(30, wireObject({ severity: wireText(8, ['warning', 'critical']), scope: wireText(500), description: wireText(1200), evidence_ids: evidenceIds() })), unknowns: strings(30),
});
export function architectureTourOutputSchema(nodeIds?: readonly string[]) {
  return wireObject({ tour: wireList(12, wireObject({ order: { type: 'integer', minimum: 0, maximum: 11 }, title: wireText(160), description: wireText(2000), nodeIds: wireList(15, wireText(800, nodeIds), 1) }), 5) });
}
export const ARCHITECTURE_TOUR_OUTPUT_SCHEMA = architectureTourOutputSchema();
export function architectureOwnershipOutputSchema(count: number, moduleIds: string[], paths?: readonly string[]) {
  return wireObject({ assignments: wireList(count, wireObject({ path: wireText(800, paths), module_id: wireText(800, moduleIds), rationale: wireText(500) }), count) });
}

/** Collect only host-defined paths and numeric constraints; never echo unknown keys or values. */
export function assertArchitectureWireShape(value: unknown, shape: ArchitectureWireShape): void {
  const issues: SemanticSchemaIssue[] = []; let total = 0;
  const type = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const add = (issue: SemanticSchemaIssue) => { total++; if (issues.length < 40) issues.push(issue); };
  function visit(value: unknown, shape: ArchitectureWireShape, at: string): void {
    if (shape.type === 'object') {
      if (!objectRecord(value)) { add({ path: at, rule: 'type', expected: 'object', observed_type: type(value) }); return; }
      for (const key of shape.required) if (!Object.hasOwn(value, key)) add({ path: `${at}.${key}`, rule: 'required' });
      const unexpected = Object.keys(value).filter(key => !Object.hasOwn(shape.properties, key)).length;
      if (unexpected) add({ path: at, rule: 'unexpected_fields', observed_count: unexpected, maximum: 0, allowed_values: shape.required });
      for (const [key, child] of Object.entries(shape.properties)) if (Object.hasOwn(value, key)) visit(value[key], child, `${at}.${key}`);
    } else if (shape.type === 'array') {
      if (!Array.isArray(value)) { add({ path: at, rule: 'type', expected: 'array', observed_type: type(value) }); return; }
      if (value.length < shape.minItems) add({ path: at, rule: 'min_items', observed_count: value.length, minimum: shape.minItems });
      if (value.length > shape.maxItems) add({ path: at, rule: 'max_items', observed_count: value.length, maximum: shape.maxItems });
      value.slice(0, shape.maxItems).forEach((item, index) => visit(item, shape.items, `${at}[${index}]`));
    } else if (shape.type === 'integer') {
      if (!Number.isSafeInteger(value) || Number(value) < shape.minimum || Number(value) > shape.maximum) add({ path: at, rule: 'type', expected: `integer in [${shape.minimum},${shape.maximum}]`, observed_type: type(value) });
    } else {
      if (typeof value !== 'string') { add({ path: at, rule: 'type', expected: 'string', observed_type: type(value) }); return; }
      if (value.length < shape.minLength || shape.minLength > 0 && !value.trim()) add({ path: at, rule: 'non_empty', observed_length: value.length, minimum: shape.minLength });
      if (value.length > shape.maxLength) add({ path: at, rule: 'max_length', observed_length: value.length, maximum: shape.maxLength });
      if (shape.enum && !shape.enum.includes(value)) add({ path: at, rule: 'enum', allowed_values: shape.enum });
      if (shape.pattern && !new RegExp(shape.pattern).test(value)) add({ path: at, rule: 'enum', expected: shape.pattern });
    }
  }
  visit(value, shape, '$');
  if (total) semanticInvalid('schema', true, issues.map(issue => issue.path), issues, total);
}

export type ArchitectureEvidenceEntry = SourceEvidence & { id: string };
const rangeKey = (item: SourceEvidence) => JSON.stringify([item.path, item.line_start, item.line_end]);
function readRange(value: unknown): SourceEvidence {
  if (!objectRecord(value) || Object.keys(value).some(key => !['path', 'line_start', 'line_end'].includes(key)) || typeof value.path !== 'string'
    || !Number.isSafeInteger(value.line_start) || !Number.isSafeInteger(value.line_end) || Number(value.line_start) < 1 || Number(value.line_end) < Number(value.line_start)) return semanticInvalid('architecture_input_evidence', false);
  return { path: value.path, line_start: Number(value.line_start), line_end: Number(value.line_end) };
}
export function encodeArchitectureEvidence(value: unknown, catalog: readonly ArchitectureEvidenceEntry[]): unknown {
  const ids = new Map(catalog.map(item => [rangeKey(item), item.id]));
  function visit(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(visit);
    if (!objectRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key !== 'evidence') return [key, visit(item)];
      if (!Array.isArray(item)) return semanticInvalid('architecture_input_evidence', false);
      return ['evidence_ids', item.map(row => {
        const id = ids.get(rangeKey(readRange(row)));
        if (!id) return semanticInvalid('architecture_input_evidence', false);
        return id;
      })];
    }));
  }
  return visit(value);
}

/** One request's actual facts define its citation vocabulary. No global range widening. */
export function createArchitectureEvidenceWire(input: Record<string, unknown>, scope: { snapshotId: string; phase: string; name: string }) {
  const ranges = new Map<string, SourceEvidence>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) value.forEach(collect);
    else if (objectRecord(value)) for (const [key, item] of Object.entries(value)) {
      if (key === 'evidence') {
        if (!Array.isArray(item)) return semanticInvalid('architecture_input_evidence', false);
        for (const row of item) { const range = readRange(row); ranges.set(rangeKey(range), range); }
      } else collect(item);
    }
  }
  collect(input);
  const requestId = semanticDigest({ protocol: ARCHITECTURE_EVIDENCE_PROTOCOL, ...scope, input }).slice(0, 20);
  const catalog = [...ranges.values()].sort((a, b) => a.path.localeCompare(b.path) || a.line_start - b.line_start || a.line_end - b.line_end)
    .map((range, index) => ({ id: `AE-${requestId}-${String(index + 1).padStart(3, '0')}`, ...range }));
  const entries = new Map(catalog.map(item => [item.id, item]));
  function decode(value: unknown, shape: ArchitectureWireShape): unknown {
    assertArchitectureWireShape(value, shape);
    function visit(value: unknown, shape: ArchitectureWireShape, at: string): unknown {
      if (shape.type === 'array') return (value as unknown[]).map((item, index) => visit(item, shape.items, `${at}[${index}]`));
      if (shape.type !== 'object') return value;
      return Object.fromEntries(Object.entries(shape.properties).map(([key, child]) => {
        const item = (value as Record<string, unknown>)[key];
        if (key !== 'evidence_ids') return [key, visit(item, child, `${at}.${key}`)];
        const ids = item as string[];
        if (new Set(ids).size !== ids.length) return semanticInvalid('evidence_catalog_duplicate', true, [`${at}.evidence_ids`], [{ path: `${at}.evidence_ids`, rule: 'unique_items' }]);
        return ['evidence', ids.map(id => {
          const source = entries.get(id);
          if (!source) return semanticInvalid('evidence_catalog_id', true, [`${at}.evidence_ids`], [{ path: `${at}.evidence_ids`, rule: 'enum', expected: 'an ID from this request evidence_catalog' }]);
          return { path: source.path, line_start: source.line_start, line_end: source.line_end };
        })];
      }));
    }
    return visit(value, shape, '$');
  }
  function example(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(example);
    if (!objectRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => key === 'evidence' ? ['evidence_ids', [catalog[0]?.id ?? 'a current evidence_catalog ID']] : [key, example(item)]));
  }
  return { input: encodeArchitectureEvidence(input, catalog) as Record<string, unknown>, catalog, evidence: [...ranges.values()], decode, example };
}

export function createArchitectureEvidenceRequest(request: Record<string, unknown> & { task: string; output_shape: unknown }, scope: { snapshotId: string; phase: string; name: string }, schema: ArchitectureWireShape) {
  const { task, output_shape, ...facts } = request, wire = createArchitectureEvidenceWire(facts, scope);
  return { ...wire, input: { task, evidence_protocol: ARCHITECTURE_EVIDENCE_PROTOCOL, ...wire.input, evidence_catalog: wire.catalog, output_shape: wire.example(output_shape), output_schema: schema,
    evidence_constraints: '只使用本次 evidence_catalog 的 evidence_ids；每处1到20个不同ID，不能编造路径/行号或引用其他请求ID。宿主将精确恢复原证据。全局架构每个节点自身与business_rules的不同证据并集最多60项。output_schema列出全部字段、类型与生产限额；不增加字段。' } };
}

export const ARCHITECTURE_PROPOSAL_PATH_PROTOCOL = 'architecture-proposal-paths-1.0.0';
export interface ArchitectureRelatedPathEntry { id: string; path: string }
/** Canonical paths can be encoded only through a host-owned assignment vocabulary. */
export function encodeArchitectureRelatedPaths(value: unknown, catalog: readonly ArchitectureRelatedPathEntry[]): unknown {
  if (Array.isArray(value)) return value.map(item => encodeArchitectureRelatedPaths(item, catalog));
  if (!objectRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key !== 'related_paths') return [key, encodeArchitectureRelatedPaths(item, catalog)];
    if (!Array.isArray(item)) return semanticInvalid('architecture_input_paths', false);
    return ['related_path_ids', item.map(file => {
      const entry = catalog.find(entry => entry.path === file);
      if (!entry) return semanticInvalid('architecture_input_paths', false);
      return entry.id;
    })];
  }));
}
/** Assignment paths and citation paths intentionally have different scoped vocabularies. */
export function createArchitectureProposalPathRequest(request: Record<string, unknown> & { task: string; output_shape: unknown }, scope: { snapshotId: string; phase: string; name: string }, options: { paths: readonly string[]; maximumPaths: number; unknowns: number }) {
  if (!options.paths.length || new Set(options.paths).size !== options.paths.length) return semanticInvalid('architecture_input_paths', false);
  const identity = semanticDigest({ protocol: ARCHITECTURE_PROPOSAL_PATH_PROTOCOL, ...scope, request, paths: options.paths }).slice(0, 16);
  const pathCatalog = options.paths.map((file, index) => ({ id: `AP-${identity}-${String(index + 1).padStart(3, '0')}`, path: file })), allowedIds = pathCatalog.map(entry => entry.id);
  const schema = architectureProposalOutputSchema({ relatedPaths: options.maximumPaths, unknowns: options.unknowns, requireProposal: true, relatedPathIds: allowedIds });
  function example(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(example);
    if (!objectRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => key === 'related_paths' ? ['related_path_ids', [allowedIds[0]]] : [key, example(item)]));
  }
  const wire = createArchitectureEvidenceRequest({ ...request, output_shape: example(request.output_shape), related_path_protocol: ARCHITECTURE_PROPOSAL_PATH_PROTOCOL, related_path_catalog: pathCatalog,
    related_path_constraints: 'related_path_ids表示本次输入需要归属/归并的文件，只能使用related_path_catalog中的AP ID。全部proposals的ID并集必须精确覆盖该目录，每条proposal至少1个且内部不重复。evidence_catalog中的AE ID仅表示论断出处，可引用合法的页外callee证据；依赖target也可能页外。证据和下游路径不自动成为归属文件，不能把它们写入related_path_ids。不得返回自由路径或related_paths字段，不得遗漏困难文件；结构覆盖不代表语义理解已经正确。' }, scope, schema);
  function decode(value: unknown): unknown {
    const decoded = wire.decode(value, schema) as { proposals: Record<string, unknown>[] }, covered = new Set<string>();
    const proposals = decoded.proposals.map((proposal, index) => {
      const ids = proposal.related_path_ids as string[], at = `$.proposals[${index}].related_path_ids`;
      if (new Set(ids).size !== ids.length) return semanticInvalid('architecture_paths', true, [at], [{ path: at, rule: 'unique_items', allowed_values: allowedIds }]);
      ids.forEach(id => covered.add(id));
      return Object.fromEntries(Object.entries(proposal).map(([key, item]) => key === 'related_path_ids' ? ['related_paths', ids.map(id => (pathCatalog.find(entry => entry.id === id) as ArchitectureRelatedPathEntry).path)] : [key, item]));
    });
    if (covered.size !== allowedIds.length || allowedIds.some(id => !covered.has(id))) return semanticInvalid('architecture_paths_coverage', true, ['$.proposals[].related_path_ids'], [{ path: '$.proposals[].related_path_ids', rule: 'exact_items', allowed_values: allowedIds, observed_count: covered.size, minimum: allowedIds.length, maximum: allowedIds.length }]);
    return { proposals };
  }
  return { ...wire, schema, pathCatalog, decode };
}

// Reserve headroom below the model client's 180k hard limit for one bounded correction.
export const ARCHITECTURE_REQUEST_BUDGET = 160_000;
export function architectureEvidenceRequestBytes(request: ReturnType<typeof createArchitectureEvidenceRequest>, phase: string): number {
  return Buffer.byteLength(JSON.stringify({ analysis_phase: phase, ...request.input }));
}
/** Split complete pages only after measuring the actual wire, never crop facts or citations. */
export function budgetArchitectureEvidencePages<T>(pages: T[][], prepare: (items: T[]) => ReturnType<typeof createArchitectureEvidenceRequest>, phase: string): T[][] {
  const result: T[][] = [];
  function append(items: T[]): void {
    if (architectureEvidenceRequestBytes(prepare(items), phase) <= ARCHITECTURE_REQUEST_BUDGET) { result.push(items); return; }
    if (items.length < 2) return semanticInvalid('architecture_input_budget', false);
    const middle = Math.ceil(items.length / 2); append(items.slice(0, middle)); append(items.slice(middle));
  }
  pages.forEach(append); return result;
}

import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { sha } from './transport.mjs';
import { auditBinding } from './facts.mjs';
export const SOURCE = 'F:/workspace/team-synergy-runtime/full-ua-20261112/runner/projects/19Q4K7PDARXQ9JHW6R6F/P1KRPDABN4RD0YXMX64E/JYRGS256GG6DFPRKGCQV-zfMFjy/source';
export const OUTPUT = 'F:/workspace/team-synergy-runtime/module-understanding-pilot-20261117/experiment';
export const REPOSITORY = 'team-synergy';
export const TARGETS = ['apps/core-api/src/routes/tasks.ts', 'apps/core-api/src/routes/handovers.ts', 'apps/core-api/src/routes/execution.ts',
  ...['task-service', 'project-use-cases', 'execution-guard', 'execution-use-cases', 'project-access', 'handover-use-cases'].map(n => `packages/application/src/${n}.ts`),
  'packages/domain/src/task-state-machine.ts', 'packages/contracts/src/handover.ts', 'packages/integrations/src/handover-workspace.ts',
  ...['index', 'runtime', 'supervisor', 'api'].map(n => `apps/agentd/src/${n}.ts`)];
export function loadContext() {
  const parent = path.dirname(SOURCE), snapshot = JSON.parse(fs.readFileSync(path.join(parent, 'snapshot.json')));
  const native = JSON.parse(fs.readFileSync(path.join(parent, 'codegraph-projection.json')));
  if (snapshot.snapshot_id !== '6ad78c2f560c323270d182a0b4fd10ed0d802591203e1ca48431c69060105bf8'
    || snapshot.commit !== 'c87aefbbece35c0bf9ccad32a5084ad85b4edb9d') throw new Error('Frozen snapshot identity mismatch');
  const files = new Map(snapshot.files.map(file => [file.path, file])), sources = new Map(), reads = [], ranges = new Map();
  const repositories = [{ repository: REPOSITORY, commit: snapshot.commit, snapshot: snapshot.snapshot_id }];
  const root = fs.realpathSync(SOURCE), originalRead = fs.readFileSync;
  function readSource(filePath, reason = 'explicit inspector dependency') {
    if (!files.has(filePath) || path.isAbsolute(filePath) || filePath.split('/').includes('..')) throw new Error('Source not in frozen snapshot');
    if (sources.has(filePath)) return sources.get(filePath);
    const location = path.resolve(root, filePath), resolved = fs.realpathSync(location);
    if (!resolved.startsWith(root + path.sep) || !fs.lstatSync(location).isFile()) throw new Error('Source boundary violation');
    const bytes = originalRead(location), file = files.get(filePath);
    if (sha(bytes) !== file.sha256 || bytes.length !== file.byte_count) throw new Error('Frozen source hash mismatch: ' + filePath);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const source = { repository: REPOSITORY, path: filePath, content };
    sources.set(filePath, source); reads.push({ path: filePath, hash: file.sha256, bytes: bytes.length, target: TARGETS.includes(filePath), reason });
    return source;
  }
  for (const filePath of TARGETS) readSource(filePath, '16-target hash preflight');
  function sourceRange(query, owner) {
    const source = readSource(query.path), lines = source.content.split('\n');
    const { startLine, endLine } = query;
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine
      || endLine > lines.length || endLine - startLine > 179) throw new Error('Source range must be valid and <=180 lines');
    const text = lines.slice(startLine - 1, endLine).join('\n');
    if (Buffer.byteLength(text) > 32 * 1024) throw new Error('Single source range exceeds 32KiB');
    const id = 'E-' + sha(JSON.stringify([owner, query.path, startLine, endLine, files.get(query.path).sha256])).slice(0, 20);
    const range = { id, path: query.path, startLine, endLine, contentHash: files.get(query.path).sha256, text };
    ranges.set(id, range); return range;
  }
  const nodeById = new Map(native.nodes.map(node => [node.id, node]));
  const metadata = node => ({ id: node.id, label: node.label, kind: node.kind, path: node.path,
    startLine: node.line_start, endLine: node.line_end });
  function inspect(queries, owner) {
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 6) throw new Error('Inspect requires 1..6 bounded queries');
    const start = performance.now(), result = queries.map(query => {
      if (query.kind === 'source') return { kind: 'source', ...sourceRange(query, owner) };
      if (query.kind === 'search') {
        if (typeof query.text !== 'string' || !query.text || query.text.length > 100) throw new Error('Search requires literal text <=100 chars');
        const source = readSource(query.path);
        return { kind: 'search', path: query.path, matches: source.content.split('\n').flatMap((line, i) => line.includes(query.text)
          ? [{ line: i + 1, text: line.slice(0, 500) }] : []).slice(0, 20), warning: 'Navigation only; request source ranges for quotable evidence.' };
      }
      if (query.kind !== 'native' || !nodeById.has(query.symbolId)) throw new Error('Unknown native symbol');
      const node = nodeById.get(query.symbolId), edges = native.edges.filter(edge => edge.source === node.id || edge.target === node.id);
      const chosen = edges.filter(edge => /call|import|refer/u.test(edge.type)).slice(0, 25);
      return { kind: 'native', node: metadata(node), edges: chosen, totalEdges: edges.length,
        nodes: [...new Set(chosen.flatMap(edge => [edge.source, edge.target]))].map(id => nodeById.get(id)).filter(Boolean).map(metadata),
        warning: 'Static inferred relations; missing edges do not prove no source call. Returned-object calls require source/routing evidence.' };
    });
    return { result, retrievalMs: performance.now() - start };
  }
  function binding(ref) {
    const range = ranges.get(ref.ref), start = ref.startLine ?? range?.startLine, end = ref.endLine ?? range?.endLine;
    if (!range || !Number.isInteger(start) || !Number.isInteger(end) || start < range.startLine || end > range.endLine || end < start)
      throw new Error('Citation not contained in an actually returned source range');
    const quote = sources.get(range.path).content.split('\n').slice(start - 1, end).join('\n');
    const value = { repository: REPOSITORY, commit: snapshot.commit, snapshot: snapshot.snapshot_id, path: range.path,
      contentHash: range.contentHash, startLine: start, endLine: end, quote };
    if (auditBinding(value, { repositories, sources: [...sources.values()] }).status !== 'valid') throw new Error('Citation binding audit failed');
    return value;
  }
  async function guardedRead(action) {
    // Observe unchanged production grounder reads, checking only files it actually requests.
    fs.readFileSync = function(file, ...args) {
      const location = typeof file === 'string' || file instanceof URL ? path.resolve(String(file)) : '';
      if (location.startsWith(root + path.sep)) {
        const relative = path.relative(root, location).split(path.sep).join('/');
        readSource(relative, 'unchanged A grounder dependency');
      }
      return originalRead(file, ...args);
    };
    syncBuiltinESMExports();
    try { return await action(); } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); }
  }
  return { snapshot, native, repositories, files, sources, reads, ranges, readSource, inspect, binding, guardedRead,
    entries: TARGETS.map(filePath => ({ path: filePath, ...files.get(filePath), symbols: native.nodes.filter(node => node.path === filePath
      && ['function', 'method', 'class'].includes(node.kind)).map(metadata) })) };
}

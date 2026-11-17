import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { ProjectMaterialGlobInput, ProjectMaterialGrepInput, ProjectMaterialListInput, ProjectMaterialReadInput,
  type ProjectMaterialMetadata, type ProjectMaterialListView, type ProjectMaterialGrepView, type ProjectMaterialReadView } from '@team-synergy/contracts';
import { fail, type TaskResult } from './task-service.js';
import { authorizeProjectMaterialQuery, loadProjectMaterialCatalog } from './project-material-catalog.js';
import { loadProjectMaterialBody, materialHash, resolveCurrentProjectMaterialSource } from './project-material-body.js';
import { materialPathMatches, searchMaterialText, MATERIAL_SEARCH_TIMEOUT_MS } from './project-material-search.js';

type Actor = { projectCode: string; principalCode: string };
const MAX_SEARCH_DOCUMENTS = 128, MAX_SEARCH_CHARS = 1000000, MAX_DOCUMENT_CHARS = 100000;
function parse<T>(parser: { parse(value: unknown): T }, value: unknown): T {
  try { return parser.parse(value); } catch { throw new DomainError('material_invalid', '资料查询参数无效'); }
}
function options<T extends Actor>(command: T) {
  const { projectCode: _project, principalCode: _principal, ...input } = command; return input;
}
function filter(items: ProjectMaterialMetadata[], input: { sourceKinds?: ProjectMaterialMetadata['sourceKind'][]; status: string }) {
  return items.filter(row => (!input.sourceKinds || input.sourceKinds.includes(row.sourceKind)) && (input.status === 'all' || row.status === input.status));
}
function page(items: ProjectMaterialMetadata[], input: { offset: number; limit: number }, catalogTruncated: boolean): ProjectMaterialListView {
  // Titles/summaries remain bounded and list never includes source bodies.
  let chars = 0;
  const selected: ProjectMaterialMetadata[] = [];
  for (const item of items.slice(input.offset, input.offset + input.limit)) {
    const size = JSON.stringify(item).length;
    if (chars + size > 32000) break;
    chars += size; selected.push(item);
  }
  const more = input.offset + selected.length < items.length;
  return { items: selected, total: items.length, offset: input.offset, nextOffset: more ? input.offset + selected.length : null,
    truncated: more || catalogTruncated, catalogTruncated, pathGrammar: 'sourceKind/objectCode.md' };
}
async function result<T>(action: () => Promise<T>): Promise<TaskResult<T>> {
  try { return { ok: true, data: await action() }; }
  catch (error) { return fail(error instanceof DomainError ? error : new DomainError('internal_error', '资料查询失败')); }
}
function sliceBody(body: string, input: { offset?: number; limit: number; startLine?: number; endLine?: number }) {
  const starts = [0];
  for (let n = body.indexOf('\n'); n >= 0; n = body.indexOf('\n', n + 1)) starts.push(n + 1);
  let offset = input.offset ?? 0, requestedEnd = body.length;
  if (input.startLine !== undefined) {
    if (input.startLine > starts.length) throw new DomainError('material_range_invalid', '起始行超出资料范围');
    offset = starts[input.startLine - 1] ?? 0;
    const endLine = input.endLine ?? Math.min(starts.length, input.startLine + 499);
    requestedEnd = starts[endLine] ?? body.length;
  }
  if (offset > body.length || (offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] ?? '') && /[\uD800-\uDBFF]/.test(body[offset - 1] ?? ''))) {
    throw new DomainError('material_range_invalid', '请使用返回的nextOffset连续读取');
  }
  let end = Math.min(requestedEnd, offset + input.limit);
  if (end < body.length && /[\uDC00-\uDFFF]/.test(body[end] ?? '') && /[\uD800-\uDBFF]/.test(body[end - 1] ?? '')) end--;
  const lineOf = (position: number) => { let line = 0; while (line + 1 < starts.length && (starts[line + 1] ?? Infinity) <= position) line++; return line + 1; };
  return { body: body.slice(offset, end), range: { offset, nextOffset: end < body.length ? end : null, totalChars: body.length,
    startLine: lineOf(offset), endLine: lineOf(end > offset ? end - 1 : end), totalLines: starts.length, unit: 'utf16' as const },
    truncated: end < requestedEnd || requestedEnd < body.length };
}

export function createProjectMaterialQueryUseCases(db: Db) {
  return {
    list: (command: Actor & ProjectMaterialListInput) => result<ProjectMaterialListView>(async () => {
      const input = parse(ProjectMaterialListInput, options(command)), project = await authorizeProjectMaterialQuery(db, command);
      const catalog = await loadProjectMaterialCatalog(db, project.id);
      const query = input.query?.toLocaleLowerCase();
      return page(filter(catalog.items, input).filter(row => !query || `${row.path} ${row.title} ${row.summary}`.toLocaleLowerCase().includes(query)), input, catalog.truncated);
    }),
    glob: (command: Actor & ProjectMaterialGlobInput) => result<ProjectMaterialListView>(async () => {
      const input = parse(ProjectMaterialGlobInput, options(command)), project = await authorizeProjectMaterialQuery(db, command);
      const catalog = await loadProjectMaterialCatalog(db, project.id);
      return page(filter(catalog.items, input).filter(row => materialPathMatches(input.pattern, row.path)), input, catalog.truncated);
    }),
    read: (command: Actor & ProjectMaterialReadInput) => result<ProjectMaterialReadView>(async () => {
      const input = parse(ProjectMaterialReadInput, options(command)), project = await authorizeProjectMaterialQuery(db, command);
      let selector = { sourceKind: input.sourceKind, objectCode: input.objectCode, revision: input.revision, sourceCitation: input.sourceCitation };
      if (input.path) {
        const match = /^(project|requirement|architecture|testing)\/([0-9A-Za-z]{20})\.md$/.exec(input.path);
        if (!match) throw new DomainError('material_not_found', '虚拟资料路径不存在');
        selector = { ...selector, sourceKind: match[1] as ProjectMaterialMetadata['sourceKind'], objectCode: match[2] };
      }
      const source = await loadProjectMaterialBody(db, project.id, selector);
      if (source.oversize) throw new DomainError('material_body_limit', '资料正文超过读取上限');
      await authorizeProjectMaterialQuery(db, command);
      const latest = await resolveCurrentProjectMaterialSource(db, { projectId: project.id, sourceCitation: source.metadata.sourceCitation });
      const current = source.current && latest?.metadataHash === source.metadata.metadataHash;
      const version = { revision: source.metadata.revision, revisionCode: source.metadata.revisionCode,
        sha256: source.body === null ? null : materialHash(source.body) };
      return { ...source.metadata, current, version, ...(source.body === null ? {
        body: null, range: null, truncated: false, unsupportedReason: 'binary_content' as const,
      } : sliceBody(source.body, input)) };
    }),
    grep: (command: Actor & ProjectMaterialGrepInput) => result<ProjectMaterialGrepView>(async () => {
      const input = parse(ProjectMaterialGrepInput, options(command)), project = await authorizeProjectMaterialQuery(db, command);
      const catalog = await loadProjectMaterialCatalog(db, project.id);
      const selected = filter(catalog.items, input).filter(row => !input.pathGlob || materialPathMatches(input.pathGlob, row.path));
      const documents: Array<{ metadata: ProjectMaterialMetadata; body: string }> = [];
      let chars = 0, skippedBinary = 0, skippedOversize = 0, scannedDocuments = 0, bounded = catalog.truncated;
      for (const metadata of selected) {
        if (!metadata.textSearchable) { skippedBinary++; continue; }
        if (scannedDocuments >= MAX_SEARCH_DOCUMENTS || chars >= MAX_SEARCH_CHARS) { bounded = true; break; }
        const source = await loadProjectMaterialBody(db, project.id, { sourceKind: metadata.sourceKind, objectCode: metadata.objectCode,
          revision: metadata.revision }, MAX_DOCUMENT_CHARS);
        scannedDocuments++;
        if (!source.current) { bounded = true; continue; }
        if (source.oversize || source.body === null || chars + source.body.length > MAX_SEARCH_CHARS) { skippedOversize++; bounded = true; continue; }
        chars += source.body.length; documents.push({ metadata: source.metadata, body: source.body });
      }
      const found = await searchMaterialText({ documents, ...input });
      await authorizeProjectMaterialQuery(db, command);
      return { ...found, offset: input.offset, truncated: found.truncated || bounded, scannedDocuments, skippedBinary, skippedOversize, catalogTruncated: catalog.truncated,
        limits: { maxDocuments: MAX_SEARCH_DOCUMENTS, maxInputChars: MAX_SEARCH_CHARS, maxOutputChars: input.maxChars, timeoutMs: MATERIAL_SEARCH_TIMEOUT_MS } };
    }),
  };
}

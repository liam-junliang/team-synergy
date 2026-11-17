import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createMemoryProjectManagementUseCases, reconcileProjectMaterialIndexes, resolveCurrentProjectMaterialSource } from '@team-synergy/application';
import { schema, type Db } from '@team-synergy/persistence';
import type { EngineConfig } from './memory-engines.js';
import { ensureProjectMemoryResource } from './memory-engines.js';
import { resolveProjectMemoryEngines } from './memory-project-runtime.js';

type Mapping = EngineConfig['projects'][string];
type IndexJob = { id: string; attempts: number; generation: number; operation: 'upsert' | 'delete';
  externalRef: string | null; code: string; projectId: string; project: string; bindingGeneration: number | null;
  sourceKind: 'project' | 'requirement' | 'architecture' | 'testing'; objectCode: string; revision: number;
  revisionCode: string; metadataHash: string; sourceCitation: string; path: string; title: string; summary: string;
  summaryOrigin: 'authored' | 'excerpt' | 'title';
  textSearchable: boolean; active: boolean; legacy: boolean; text: string | null; titleTruncated: boolean };
type WikiResult = { items?: { ref?: string; filename?: string; content?: string; not_found?: boolean; path?: string }[];
  results?: { path: string }[]; wiki_id?: string; team_id?: string; name?: string; status?: string };
type CoreResult = { total?: number; messages?: { id?: string; content: string; role: string }[]; accepted_ids?: string[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cursors = new WeakMap<Db, string>();
const safeKey = /^[a-z0-9_.-]{1,128}$/iu;
export const projectMaterialIndexPage = (project: string, code: string) => 'wiki/sources/tsp-material-' + hash(project + '/' + code) + '.md';
const legacyPage = (project: string, code: string) => 'wiki/sources/tsp-evidence-' + hash('tsp-wiki-page/' + project + '/' + code) + '.md';

async function api<T>(config: EngineConfig, wiki: boolean, operation: string, body: object): Promise<T> {
  const base = wiki ? config.tencent.baseUrl : config.tencent.coreBaseUrl;
  if (!base) throw Error('Missing semantic mapping');
  const response = await fetch(base.replace(/\/+$/u, '') + (wiki ? '/wiki/' : '/conversation/') + operation, {
    method: 'POST', headers: { authorization: 'Bearer ' + config.tencent.token, 'x-tdai-service-id': config.tencent.serviceId,
      'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000), redirect: 'error' });
  if (!response.ok) throw Error('Engine HTTP ' + response.status);
  const envelope = await response.json() as { code?: number; data?: T };
  if (envelope.code !== 0 || envelope.data === undefined || envelope.data === null) throw Error('Invalid engine envelope');
  return envelope.data;
}
const wiki = (config: EngineConfig, p: Mapping, operation: string, body: object) => api<WikiResult>(config, true, operation,
  { wiki_id: p.wikiId, team_id: p.teamId, user_id: p.userId, ...body });
function core(config: EngineConfig, p: Mapping, operation: string, body: object) {
  if (!p.semanticAgentId) throw Error('Missing semantic mapping');
  return api<CoreResult>(config, false, operation, { team_id: p.teamId, user_id: p.userId, agent_id: p.semanticAgentId,
    task_id: 'tsp-wiki-' + p.wikiId, ...body });
}
async function owned(config: EngineConfig, project: string, p: Mapping) {
  const detail = await wiki(config, p, 'get', {});
  if (detail.wiki_id !== p.wikiId || detail.team_id !== p.teamId || detail.name !== 'tsp-memory-' + project) throw Error('Wiki identity mismatch');
  // A new metadata-only Wiki is draft until an ingest runs. Manual page writes
  // build their own search index; uploading a raw body just to become ready would defeat this architecture.
  if (detail.status !== 'ready' && detail.status !== 'draft') throw Error('Wiki ingestion pending');
}

/** Fixed, bounded directory card. Never receives the source body. */
export function projectMaterialIndexText(row: Pick<IndexJob, 'code' | 'project' | 'sourceKind' | 'objectCode' | 'revision' | 'revisionCode' |
  'metadataHash' | 'sourceCitation' | 'path' | 'title' | 'summary' | 'summaryOrigin' | 'textSearchable'>) {
  if (row.title.length > 256 || row.summary.length > 600 || row.path.length > 2048) throw Error('Index metadata too large');
  return JSON.stringify({ schema: 'tsp-project-material-index/v1', indexCode: row.code, project: row.project, sourceKind: row.sourceKind,
    objectCode: row.objectCode, revision: row.revision, revisionCode: row.revisionCode, metadataHash: row.metadataHash,
    source: row.sourceCitation, path: row.path, title: row.title, summary: row.summary, summaryOrigin: row.summaryOrigin, textSearchable: row.textSearchable,
    state: 'documented', readHint: 'Read the current source from TeamSynergy with project ACL; index sync does not confirm a decision or implementation.' });
}

async function readPage(config: EngineConfig, p: Mapping, ref: string) {
  const result = await wiki(config, p, 'page/read', { refs: [ref] });
  const row = result.items?.find(item => item.ref?.replace(/\\/gu, '/') === ref);
  if (!row || row.not_found) return null;
  if (typeof row.content !== 'string') throw Error('Invalid engine envelope');
  return row.content;
}
async function coreCopy(config: EngineConfig, p: Mapping, session: string, content: string, remove = false) {
  const read = async () => {
    const result = await core(config, p, 'query', { session_id: session, limit: 100 });
    if (!Array.isArray(result.messages) || result.total !== result.messages.length) throw Error('Invalid semantic receipt');
    if (result.messages.some(row => row.role !== 'assistant' || row.content !== content)) throw Error('Remote content changed');
    return result.messages;
  };
  let rows = await read();
  if (remove) {
    if (rows.length) {
      if (rows.some(row => !row.id)) throw Error('Invalid semantic receipt');
      await core(config, p, 'delete', { message_ids: rows.map(row => row.id) });
      if ((await read()).length) throw Error('Engine readback mismatch');
    }
    return;
  }
  if (!rows.length) { await core(config, p, 'add', { session_id: session, messages: [{ role: 'assistant', content }] }); rows = await read(); }
  if (rows.length !== 1) throw Error('Engine readback mismatch');
}

async function transferIndex(config: EngineConfig, p: Mapping, job: IndexJob) {
  const text = projectMaterialIndexText(job), path = projectMaterialIndexPage(job.project, job.code);
  const page = '---\ntype: source\nlocked: true\n---\n\n# 项目资料目录：' + job.title.replace(/[\r\n]+/gu, ' ') + '\n\n' + text + '\n';
  const previous = await readPage(config, p, path);
  if (previous !== null && previous !== page) throw Error('Remote content changed');
  if (job.operation === 'delete') {
    if (previous !== null) await wiki(config, p, 'page/rm', { refs: [path] });
    if (await readPage(config, p, path) !== null) throw Error('Engine readback mismatch');
  } else {
    if (previous === null) await wiki(config, p, 'page/write', { pages: [{ ref: path, content: page }] });
    if (await readPage(config, p, path) !== page) throw Error('Engine readback mismatch');
    const indexed = await wiki(config, p, 'search', { query: job.code, limit: 16 });
    if (!indexed.results?.some(row => row.path.replace(/\\/gu, '/') === path)) throw Error('Wiki page not indexed');
  }
  if (p.semanticAgentId && config.tencent.coreBaseUrl) await coreCopy(config, p, 'tsp-material-' + p.wikiId + '-' + job.code,
    text + '\n\n[tsp-material-index ' + p.wikiId + ' ' + job.code + ']', job.operation === 'delete');
  return 'wiki:' + p.wikiId + '/' + path;
}

function sources(content: string) {
  const front = /^---\s*\n([\s\S]*?)\n---/u.exec(content)?.[1] ?? '';
  const inline = /^sources:\s*\[([^\]]*)\]/mu.exec(front)?.[1];
  const block = /^sources:\s*\n((?:[ \t]+-[^\n]*(?:\n|$))*)/mu.exec(front)?.[1];
  return (inline ? inline.split(',') : (block?.split('\n').map(row => row.replace(/^\s*-\s*/u, '')) ?? []))
    .map(row => row.trim().replace(/^['"]|['"]$/gu, '')).filter(Boolean);
}
async function deleteLegacyCopy(config: EngineConfig, p: Mapping, job: IndexJob) {
  if (job.text === null) throw Error('Missing legacy body');
  const filename = 'tsp-' + job.code + '-' + hash(job.text) + '.md', path = legacyPage(job.project, job.code);
  const raw = await wiki(config, p, 'raw/read', { filenames: [filename] });
  const stored = raw.items?.find(row => row.filename === filename);
  if (stored && !stored.not_found && stored.content !== job.text) throw Error('Remote content changed');
  const expected = '---\ntype: source\nsources:\n  - ' + filename + '\nlocked: true\n---\n\n# 项目文档修订：' +
    job.title.replace(/[\r\n]+/gu, ' ') + (job.titleTruncated ? '（标题摘录）' : '') + '\n\n' + job.text +
    '\n\n<!-- tspfragment' + job.code.toLowerCase() + ' -->\n';
  const page = await readPage(config, p, path);
  if (page !== null && page !== expected) throw Error('Remote content changed');
  const listed = await wiki(config, p, 'page/ls', {});
  if (!Array.isArray(listed.items) || listed.items.length > 2000) throw Error('Legacy cleanup requires review');
  const exclusive: string[] = []; let mixed = false;
  for (const row of listed.items) {
    const ref = row.path?.replace(/\\/gu, '/');
    if (!ref || ref === path) continue;
    const body = await readPage(config, p, ref);
    if (body === null) continue;
    const refs = sources(body);
    if (refs.includes(filename)) { if (refs.length === 1) exclusive.push(ref); else mixed = true; }
  }
  if (page !== null) await wiki(config, p, 'page/rm', { refs: [path] });
  for (const ref of exclusive) await wiki(config, p, 'page/rm', { refs: [ref] });
  if (p.semanticAgentId && config.tencent.coreBaseUrl && job.text.length <= 4000) await coreCopy(config, p,
    'tsp-' + p.wikiId + '-' + job.code, job.text + '\n\n[tsp-evidence ' + p.wikiId + ' ' + job.code + ']', true);
  // Removing a mixed source reference alone leaves its body unchanged in the
  // upstream cascade implementation. Keep a visible retry/review state instead.
  if (mixed) throw Error('Legacy mixed source page');
  if (stored && !stored.not_found) await wiki(config, p, 'raw/rm', { filenames: [filename] });
  const after = await wiki(config, p, 'raw/read', { filenames: [filename] });
  if (after.items?.some(row => row.filename === filename && !row.not_found) || await readPage(config, p, path) !== null) throw Error('Engine readback mismatch');
  return 'wiki:' + p.wikiId + '/' + path;
}

/** One project per scheduler tick; round robin avoids an ever-growing first-project scan. */
export async function maintainProjectMaterialIndexes(db: Db, config?: EngineConfig) {
  const previous = cursors.get(db) ?? '0';
  let result = await db.$client.query<{ id: string; code: string }>('select id,code from projects where id>$1 order by id limit 1', [previous]);
  if (!result.rows.length) result = await db.$client.query<{ id: string; code: string }>('select id,code from projects order by id limit 1');
  const project = result.rows[0]; if (!project) return null;
  cursors.set(db, project.id);
  const changed = await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('project:' || ${project.id}::text)::bigint)`);
    return reconcileProjectMaterialIndexes(tx, BigInt(project.id));
  });
  if (config && (config.projectProvisioning || config.projects[project.code])) {
    const control = createMemoryProjectManagementUseCases(db), ticket = await control.prepareAutomatic(project.code);
    if (ticket) {
      try { await control.completeProvision({ ...ticket, binding: await ensureProjectMemoryResource(config, project.code) }); }
      catch { await control.failProvision({ ...ticket, errorCode: 'engine_unavailable' }); }
    }
  }
  return { project: project.code, ...changed };
}

async function stillCurrent(db: Parameters<typeof resolveCurrentProjectMaterialSource>[0], job: IndexJob) {
  const current = await resolveCurrentProjectMaterialSource(db, { projectId: BigInt(job.projectId), sourceCitation: job.sourceCitation });
  return current?.metadataHash === job.metadataHash && current.revisionCode === job.revisionCode;
}

export async function projectNextMaterialIndex(db: Db, config: EngineConfig) {
  const result = await db.$client.query<IndexJob>(`with candidate as (
    select j.id from memory_projection_jobs j
    left join project_material_index_versions v on v.id=j.material_index_id
    left join project_document_revisions r on r.id=j.project_document_revision_id
    left join project_documents d on d.id=r.document_id
    join projects p on p.id=coalesce(v.project_id,d.project_id)
    left join project_memory_bindings b on b.project_id=p.id
    where (j.material_index_id is not null or j.project_document_revision_id is not null and j.operation='delete')
      and (j.status='pending' or j.status in ('processing','needs_reconcile') and j.lease_until<now())
      and (b.enabled and b.state='ready' or b.id is null and p.code=any($1::text[]))
    order by j.id for update of j skip locked limit 1
  ), claimed as (update memory_projection_jobs j set status='processing',attempts=j.attempts+1,
    lease_until=now()+interval '2 minutes' from candidate c where j.id=c.id returning j.*)
  select j.id,j.attempts,j.generation,j.operation,j.external_ref as "externalRef",coalesce(v.code,r.code) as code,
    p.id as "projectId",p.code as project,b.generation as "bindingGeneration",v.source_kind as "sourceKind",v.object_code as "objectCode",
    v.revision,v.revision_code as "revisionCode",v.metadata_hash as "metadataHash",v.source_citation as "sourceCitation",
    v.path,coalesce(v.title,left(r.title,240)) as title,v.summary,v.summary_origin as "summaryOrigin",v.text_searchable as "textSearchable",v.active,
    j.project_document_revision_id is not null as legacy,r.content as text,char_length(coalesce(r.title,''))>240 as "titleTruncated"
  from claimed j left join project_material_index_versions v on v.id=j.material_index_id
  left join project_document_revisions r on r.id=j.project_document_revision_id left join project_documents d on d.id=r.document_id
  join projects p on p.id=coalesce(v.project_id,d.project_id) left join project_memory_bindings b on b.project_id=p.id`, [Object.keys(config.projects)]);
  const job = result.rows[0]; if (!job) return null;
  const update = (status: string, error: string | null, ref: string | null = job.externalRef) => db.$client.query(`update memory_projection_jobs
    set status=$5,last_error=$6,external_ref=$7,lease_until=case when $5='needs_reconcile' then now()+interval '30 seconds' else null end
    where id=$1 and attempts=$2 and generation=$3 and operation=$4 and status='processing'`,
  [job.id, job.attempts, job.generation, job.operation, status, error, ref]);
  try {
    if (!job.legacy && job.operation === 'upsert' && (!job.active || !await stillCurrent(db, job))) {
      await db.$client.query(`update memory_projection_jobs set operation='delete',generation=generation+1,status='pending',lease_until=null
        where id=$1 and attempts=$2 and generation=$3 and operation=$4`, [job.id, job.attempts, job.generation, job.operation]);
      return { status: 'source_unavailable', engine: 'tencent' };
    }
    const resolved = await resolveProjectMemoryEngines(db, config, job.project);
    const mapping = resolved.config.projects[job.project];
    if (resolved.generation !== job.bindingGeneration || !mapping) throw Error('Project memory changed');
    let p = mapping;
    // Deletes may still own a previous binding's external reference. Verify its
    // project Wiki identity, never reinterpret it as the new Wiki's resource.
    if (job.operation === 'delete' && job.externalRef) {
      const match = /^wiki:([^/]+)\//u.exec(job.externalRef);
      const wikiId = match?.[1];
      if (!wikiId || !safeKey.test(wikiId)) throw Error('Wiki identity mismatch');
      p = { ...p, wikiId };
    }
    await owned(resolved.config, job.project, p);
    const ref = job.legacy ? await deleteLegacyCopy(resolved.config, p, job) : await transferIndex(resolved.config, p, job);
    if (!job.legacy && job.operation === 'upsert' && !await stillCurrent(db, job)) {
      await db.$client.query(`update memory_projection_jobs set operation='delete',generation=generation+1,status='pending',lease_until=null,external_ref=$4
        where id=$1 and attempts=$2 and generation=$3 and operation='upsert'`, [job.id, job.attempts, job.generation, ref]);
      return { status: 'source_unavailable', engine: 'tencent' };
    }
    const acknowledged = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${'project:' + job.projectId})::bigint)`);
      const [project] = await tx.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, BigInt(job.projectId)));
      const [binding] = await tx.select().from(schema.projectMemoryBindings).where(eq(schema.projectMemoryBindings.project_id, BigInt(job.projectId)));
      if (project?.status !== 'active' || (binding?.generation ?? null) !== job.bindingGeneration ||
          (binding ? !binding.enabled || binding.state !== 'ready' : !config.projects[job.project])) return false;
      if (!job.legacy && job.operation === 'upsert' && !await stillCurrent(tx, job)) {
        await tx.execute(sql`update memory_projection_jobs set operation='delete',generation=generation+1,status='pending',lease_until=null,external_ref=${ref}
          where id=${job.id}::bigint and attempts=${job.attempts} and generation=${job.generation} and operation='upsert'`);
        return false;
      }
      const ack = await tx.execute(sql`update memory_projection_jobs set status='synced',last_error=null,external_ref=${ref},lease_until=null
        where id=${job.id}::bigint and attempts=${job.attempts} and generation=${job.generation} and operation=${job.operation} and status='processing' returning id`);
      return ack.rows.length === 1;
    });
    return { status: acknowledged ? 'synced' : 'lease_changed', engine: 'tencent', sourceKind: job.legacy ? 'legacy_cleanup' : 'project_material',
      source: job.sourceCitation, operation: job.operation };
  } catch (error) {
    const errors = new Map([['Legacy mixed source page', 'legacy_cleanup_pending'], ['Legacy cleanup requires review', 'legacy_cleanup_pending'],
      ['Remote content changed', 'remote_content_changed'], ['Wiki identity mismatch', 'identity_mismatch'],
      ['Wiki ingestion pending', 'wiki_ingesting'], ['Wiki page not indexed', 'wiki_index_pending'],
      ['Project memory changed', 'project_memory_changed'], ['Engine readback mismatch', 'readback_mismatch']]);
    const code = error instanceof Error ? errors.get(error.message) ?? 'delivery_not_verified' : 'delivery_not_verified';
    await update('needs_reconcile', code); return { status: 'needs_reconcile', engine: 'tencent', code };
  }
}


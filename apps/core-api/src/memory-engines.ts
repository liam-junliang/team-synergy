import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import type { Db } from '@team-synergy/persistence';
import { resolveProjectMemoryEngines } from './memory-project-runtime.js';
import { ensurePersonalMemoryResource } from './memory-personal-runtime.js';
import { projectNextMaterialIndex, projectMaterialIndexPage } from './memory-material-runtime.js';

type Project = { teamId: string; userId: string; wikiId: string; semanticAgentId?: string };
type Account = { userId: string; apiKey: string };
export interface EngineConfig {
  tencent: { baseUrl: string; coreBaseUrl?: string; token: string; serviceId: string };
  openviking: { baseUrl: string };
  projects: Record<string, Project>;
  accounts: Record<string, Account>;
  /** Service-owned writer identity for provisioning new project scopes; never supplied by a browser. */
  projectProvisioning?: Omit<Project, 'wikiId'>;
  /** Existing OV account; only its server-held admin can provision scoped users. */
  personalProvisioning?: { accountId: string; adminApiKey: string; keySeed: string };
}
interface Job {
  id: string; attempts: number; engine: string; project: string; principal: string;
  code: string; state: string; text: string; applicability: string; eligible: boolean;
  sourceKind: 'fragment' | 'project_document'; title: string; titleTruncated: boolean;
  bindingGeneration: number | null;
  fragmentId: string | null; operation: 'upsert' | 'delete'; generation: number; externalRef: string | null;
}
// Core embeds a public excerpt as one record. Native documents retain their
// complete original in Wiki; larger versions must not become one huge vector.
const maxCoreDocumentChars = 4000;
const validKey = /^[a-z0-9_.-]{1,128}$/i;
const platformCode = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const wikiPrefix = 'wiki/sources/tsp-evidence-';

function baseUrl(value: string) {
  const url = new URL(value);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || local && url.protocol === 'http:')) throw Error('Invalid engine address');
  return url.href.replace(/\/+$/, '');
}

export async function loadMemoryEngines(file: string): Promise<EngineConfig> {
  if (!isAbsolute(file)) throw Error('Use an absolute server-side memory configuration path');
  const config: EngineConfig = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  baseUrl(config.tencent.baseUrl);
  if (config.tencent.coreBaseUrl !== undefined) baseUrl(config.tencent.coreBaseUrl);
  baseUrl(config.openviking.baseUrl);
  const present = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  if (!present(config.tencent.token) || !present(config.tencent.serviceId)) throw Error('Missing service identity');
  const wikis = new Set<string>();
  if (config.projectProvisioning) {
    const p = config.projectProvisioning;
    if (!present(p.teamId) || !validKey.test(p.teamId) || !present(p.userId) || !validKey.test(p.userId) ||
        (p.semanticAgentId !== undefined && (!config.tencent.coreBaseUrl || !validKey.test(p.semanticAgentId)))) {
      throw Error('Invalid project provisioning identity');
    }
  }
  for (const [code, p] of Object.entries(config.projects)) {
    if (!platformCode.test(code) || !present(p.teamId) || !present(p.userId) || !present(p.wikiId) || !validKey.test(p.wikiId) || wikis.has(p.wikiId))
      throw Error('Invalid or repeated Wiki mapping');
    wikis.add(p.wikiId);
    if (p.semanticAgentId !== undefined && (!config.tencent.coreBaseUrl || !present(p.semanticAgentId) || !validKey.test(p.semanticAgentId)))
      throw Error('Invalid project semantic search mapping');
  }
  const users = new Set<string>();
  if (config.personalProvisioning && (!validKey.test(config.personalProvisioning.accountId) ||
    !present(config.personalProvisioning.adminApiKey) || !present(config.personalProvisioning.keySeed) || config.personalProvisioning.keySeed.length < 32)) {
    throw Error('Invalid personal provisioning identity');
  }
  for (const [code, a] of Object.entries(config.accounts)) {
    if (!platformCode.test(code) || !present(a.apiKey) || !present(a.userId) || !validKey.test(a.userId) || ['.','..'].includes(a.userId) || users.has(a.userId))
      throw Error('Invalid or repeated personal mapping');
    users.add(a.userId);
  }
  return config;
}

type WikiData = {
  wiki_id?: string; team_id?: string; name?: string; status?: string;
  owner_user_id?: string | null;
  items?: {filename?: string; ref?: string; not_found?: boolean; content?: string; status?: string}[];
  results?: {path:string}[];
};
async function request<T = unknown>(url: string, headers: Record<string,string>, body?: unknown, allowMissing = false,
    method: 'GET' | 'POST' | 'DELETE' = body === undefined ? 'GET' : 'POST'): Promise<T|null> {
  const res = await fetch(url, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  if (allowMissing && res.status === 404) { await res.arrayBuffer(); return null; }
  if (!res.ok) throw Error('Engine HTTP ' + res.status);
  const result = await res.json() as {code?:number; data:T; status?:string; result:T};
  // With allowMissing, null is reserved for a verified HTTP 404, never a
  // successful response carrying a malformed/null result.
  if (result.code === 0 && (!allowMissing || result.data !== null)) return result.data;
  if (result.status === 'ok' && (!allowMissing || result.result !== null)) return result.result;
  throw Error('Invalid engine envelope');
}
function wiki(config: EngineConfig, op: string, body: unknown) {
  return request<WikiData>(baseUrl(config.tencent.baseUrl) + '/wiki/' + op,
    { authorization: 'Bearer ' + config.tencent.token, 'x-tdai-service-id': config.tencent.serviceId }, body);
}
async function ownedWiki(config: EngineConfig, code: string) {
  const p = config.projects[code];
  if (!p) throw Error('Missing Wiki mapping');
  const detail = await wiki(config, 'get', { wiki_id: p.wikiId });
  if (detail?.wiki_id !== p.wikiId || detail.team_id !== p.teamId || detail.name !== 'tsp-memory-' + code) throw Error('Wiki identity mismatch');
  return p;
}

/** Validate a bound resource without accidentally creating one during a retry. */
export const verifyProjectMemoryResource = ownedWiki;

export async function ensureProjectMemoryResource(config: EngineConfig, projectCode: string) {
  if (!platformCode.test(projectCode)) throw Error('Invalid project identity');
  const existing = config.projects[projectCode];
  let writer = config.projectProvisioning;
  if (existing) {
    try {
      await ownedWiki(config, projectCode);
      return existing;
    } catch (error) {
      // Only a definite deletion permits replacement. Reuse the server-owned
      // legacy writer; a timeout or ownership mismatch must fail closed.
      if (!(error instanceof Error) || error.message !== 'Engine HTTP 404') throw error;
      writer = { teamId: existing.teamId, userId: existing.userId,
        ...(existing.semanticAgentId ? { semanticAgentId: existing.semanticAgentId } : {}) };
    }
  }
  if (!writer) throw Error('Missing project provisioning identity');
  // Tencent create is idempotent by service/team/name in the pinned deployment.
  // Retry after an uncertain response reconciles the same deterministic name.
  const resource = await wiki(config, 'create', { team_id: writer.teamId, user_id: writer.userId, name: 'tsp-memory-' + projectCode });
  if (!resource?.wiki_id || !validKey.test(resource.wiki_id) || resource.team_id !== writer.teamId ||
      resource.name !== 'tsp-memory-' + projectCode || resource.owner_user_id !== writer.userId) throw Error('Wiki identity mismatch');
  const mapping = { ...writer, wikiId: resource.wiki_id };
  await ownedWiki({ ...config, projects: { ...config.projects, [projectCode]: mapping } }, projectCode);
  return mapping;
}
function personalRoot(a: Account) {
  return 'viking://user/' + a.userId + '/memories/preferences/team-synergy/';
}

type CoreMessages = {
  total?: number; accepted_ids?: string[];
  messages?: {content: string; role: string; score?: number}[];
};

function core(config: EngineConfig, p: Project, operation: string, payload: Record<string, unknown>) {
  if (!config.tencent.coreBaseUrl || !p.semanticAgentId) throw Error('Missing semantic mapping');
  const scope = {team_id:p.teamId, user_id:p.userId, agent_id:p.semanticAgentId, task_id:'tsp-wiki-'+p.wikiId};
  return request<CoreMessages>(baseUrl(config.tencent.coreBaseUrl)+'/conversation/'+operation, {
    authorization:'Bearer '+config.tencent.token, 'x-tdai-service-id':config.tencent.serviceId,
    'x-tdai-session-id':'tsp-query-'+p.wikiId,
  }, {...scope,...payload});
}

function evidencePage(projectCode: string, fragmentCode: string) {
  const key = createHash('sha256').update('tsp-wiki-page/'+projectCode+'/'+fragmentCode).digest('hex');
  return wikiPrefix+key+'.md';
}

async function indexPublicExcerpt(config: EngineConfig, p: Project, job: Job) {
  const session = 'tsp-'+p.wikiId+'-'+job.code;
  const content = job.text+'\n\n[tsp-evidence '+p.wikiId+' '+job.code+']';
  const read = async () => {
    const result = await core(config,p,'query',{session_id:session,limit:2});
    if (!Array.isArray(result?.messages) || result.total !== result.messages.length) throw Error('Invalid semantic receipt');
    if (!result.messages.length) return false;
    if (result.messages.some(row=>row.role!=='assistant' || row.content!==content)) throw Error('Remote content changed');
    return true;
  };
  if (await read()) return;
  // A published excerpt is indexed as one server-authored record; no member transcript is sent.
  const saved = await core(config,p,'add',{session_id:session,messages:[{role:'assistant',content}]});
  if (saved?.accepted_ids?.length !== 1 || !await read()) throw Error('Engine readback mismatch');
}

async function ingestOriginal(config: EngineConfig, target: Project, filename: string) {
  const ids = {wiki_id:target.wikiId, user_id:target.userId};
  for (let poll = 0; poll < 60; poll++) {
    const detail = await wiki(config, 'get', ids);
    const files = await wiki(config, 'raw/ls', ids);
    const original = files?.items?.find(row => row.filename === filename);
    if (detail?.status === 'ready' && original?.status === 'ingested') return;
    if (poll === 0 && !['pending','processing'].includes(detail?.status ?? '')) {
      await wiki(config, 'ingest', {...ids, on_busy:'reject'});
    } else if (detail?.status === 'failed') {
      throw Error('Wiki ingestion failed');
    }
    await delay(1000);
  }
  throw Error('Wiki ingestion pending');
}

async function putWiki(config: EngineConfig, job: Job) {
  const p = await ownedWiki(config, job.project);
  const target = { wiki_id: p.wikiId, team_id: p.teamId, user_id: p.userId };
  const digest = createHash('sha256').update(job.text).digest('hex');
  const filename = 'tsp-' + job.code + '-' + digest + '.md';
  // The generator may derive a summary slug from the original filename. Keep
  // the verified copy under a separate, deterministic name it never receives.
  const path = evidencePage(job.project,job.code);
  const marker = 'tspfragment' + job.code.toLowerCase();
  const heading = job.sourceKind === 'project_document' ? '# 项目文档修订：' + job.title.replace(/[\r\n]+/gu, ' ') +
    (job.titleTruncated ? '（标题摘录）' : '') :
    job.state === 'confirmed' ? '# 已确认方案' : '# 讨论中的方案';
  const page = '---\ntype: source\nsources:\n  - ' + filename + '\nlocked: true\n---\n\n' +
    heading + '\n\n' + job.text + '\n\n<!-- ' + marker + ' -->\n';
  // The immutable original and the Chinese searchable page have separate APIs.
  for (const kind of ['raw', 'page'] as const) {
    const raw = kind === 'raw';
    if (!raw) await ingestOriginal(config, p, filename);
    const expected = raw ? job.text : page;
    const key = raw ? filename : path;
    const read = async () => {
      const result = await wiki(config, kind + '/read', { wiki_id: p.wikiId, [raw ? 'filenames' : 'refs']: [key] });
      if (!Array.isArray(result?.items)) throw Error('Missing engine result');
      const item = result.items.find((r: {filename?:string; ref?:string}) => (raw ? r.filename : r.ref?.replace(/\\/g, '/')) === key);
      if (!item || item.not_found) return null;
      if (typeof item.content !== 'string') throw Error('Unrecognized engine content');
      return item.content;
    };
    const prior = await read();
    if (prior === expected) continue;
    if (prior !== null) throw Error('Remote content changed');
    const payload = raw ? {files:[{filename,content:expected,encoding:'utf8'}]} : {pages:[{ref:path,content:expected}]};
    await wiki(config, kind + '/write', {...target,...payload});
    if (await read() !== expected) throw Error('Engine readback mismatch');
  }
  const indexed = await wiki(config, 'search', {wiki_id:p.wikiId,query:marker,limit:16});
  if (!indexed?.results?.some(hit => String(hit.path).replace(/\\/g,'/') === path)) throw Error('Wiki page not indexed');
  if (p.semanticAgentId && (job.sourceKind !== 'project_document' || job.text.length <= maxCoreDocumentChars)) {
    await indexPublicExcerpt(config,p,job);
  }
  return 'wiki:' + p.wikiId + '/' + path;
}

async function putPersonal(config: EngineConfig, job: Job) {
  const account = await ensurePersonalMemoryResource(config, job.principal);
  const uri = personalRoot(account) + job.code + '.json';
  const expected = JSON.stringify({ source:job.code, applicability:job.applicability,
    ...(job.applicability === 'account' ? {} : {project:job.project}), text:job.text });
  const headers = { 'x-api-key': account.apiKey };
  const base = baseUrl(config.openviking.baseUrl) + '/api/v1/content/';
  const read = async () => personalStoredBody(await request(base + 'read?uri=' + encodeURIComponent(uri), headers, undefined, true));
  const previous = await read();
  if (previous === expected) return uri;
  if (previous !== null) throw Error('Remote content changed');
  await request(base + 'write', headers, { uri, content:expected, mode:'replace', wait:true, tags:['source=tsp_personal'] });
  if (await read() !== expected) throw Error('Engine readback mismatch');
  return uri;
}

/** Only the final reserved, valid version-bearing metadata comment is ignored.
 * All submitted body bytes, including whitespace, remain part of verification. */
function personalStoredBody(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trailer = /\n\n<!--\s*MEMORY_FIELDS\s*\n([\s\S]*?)\n-->$/u.exec(raw);
  if (!trailer) return raw;
  try {
    const fields: unknown = JSON.parse(trailer[1] ?? '');
    if (fields && typeof fields === 'object' && !Array.isArray(fields) && 'version' in fields &&
        Number.isSafeInteger(fields.version) && Number(fields.version) > 0) return raw.slice(0, trailer.index);
  } catch { /* A malformed wrapper is part of the body and must fail exact comparison. */ }
  return raw;
}

async function deletePersonal(config: EngineConfig, job: Job) {
  const account = await ensurePersonalMemoryResource(config, job.principal);
  const uri = personalRoot(account) + job.code + '.json';
  // Never turn a poisoned receipt into authority to delete another member's URI.
  if (job.externalRef !== null && job.externalRef !== uri) throw Error('Personal identity mismatch');
  const headers = { 'x-api-key': account.apiKey }, base = baseUrl(config.openviking.baseUrl);
  const read = () => request(base + '/api/v1/content/read?uri=' + encodeURIComponent(uri), headers, undefined, true);
  const expected = JSON.stringify({ source:job.code, applicability:job.applicability,
    ...(job.applicability === 'account' ? {} : {project:job.project}), text:job.text });
  const previous = await read();
  if (previous !== null && personalStoredBody(previous) !== expected) throw Error('Remote content changed');
  await request(base + '/api/v1/fs?uri=' + encodeURIComponent(uri) + '&recursive=false&wait=true', headers, undefined, true, 'DELETE');
  if (await read() !== null) throw Error('Engine readback mismatch');
  return uri;
}

type MemoryQuery = Pick<Db['$client'], 'query'>;
async function sameClaim(connection: MemoryQuery, job: Job) {
  const result = await connection.query(`select id from memory_projection_jobs where id=$1 and attempts=$2
    and generation=$3 and operation=$4 and status='processing'`, [job.id, job.attempts, job.generation, job.operation]);
  return result.rowCount === 1;
}

async function compensateLatePersonalWrite(connection: MemoryQuery, job: Job) {
  if (job.engine !== 'openviking' || job.operation !== 'upsert') return;
  // A legacy/expired in-flight upsert may finish after another deletion already
  // ACKed. Preserve the current delete intent and reopen only that completed
  // deletion; never overwrite a newer upsert, a running cleanup, or its error.
  await connection.query(`update memory_projection_jobs set status='pending',generation=generation+1,
    lease_until=null,last_error='stale_upsert_cleanup' where id=$1 and operation='delete'
    and generation<>$2 and status='synced'`, [job.id, job.generation]);
}

// The job lease fences acknowledgements. An interrupted write is reconciled at the same remote name.
export async function projectNextMemory(db: Db, config: EngineConfig) {
  const material = await projectNextMaterialIndex(db, config);
  if (material) return material;
  const {rows} = await db.$client.query<Job>(`
    with candidate as (
      select j.id from memory_projection_jobs j
      left join memory_fragments cf on cf.id=j.fragment_id
      left join memory_capture_receipts cr on cr.id=cf.receipt_id
      left join project_document_revisions cv on cv.id=j.project_document_revision_id
      left join project_documents cd on cd.id=cv.document_id
      left join projects cp on cp.id=coalesce(cr.project_id,cd.project_id)
      left join users cu on cu.id=cr.principal_id
      left join project_memory_bindings cb on cb.project_id=cp.id
      where (j.status = 'pending' or (j.status in ('processing','needs_reconcile') and j.lease_until < now()))
        and j.material_index_id is null and j.project_document_revision_id is null
        and ((j.engine='openviking' and (cu.code=any($2::text[]) or
          ($3::boolean and cu.status='active' and not cu.pending_deletion and cu.deleted_at is null))) or (j.engine='tencent' and
          ((cb.id is null and cp.code=any($1::text[])) or (cb.enabled and cb.state='ready'))))
      order by j.id for update of j skip locked limit 1
    ), claimed as (
      update memory_projection_jobs j set status='processing', attempts=j.attempts+1,
        lease_until=now()+interval '2 minutes' from candidate c where j.id=c.id returning j.*
    )
    select j.id,j.attempts,j.engine,j.operation,j.generation,j.fragment_id as "fragmentId",j.external_ref as "externalRef",
      case when j.project_document_revision_id is not null then 'project_document' else 'fragment' end as "sourceKind",
      coalesce(f.code,dv.code) as code,
      case when j.project_document_revision_id is not null then 'documented' else f.state end as state,
      coalesce(f.text,dv.content) as text,coalesce(f.applicability,'project') as applicability,
      left(coalesce(dv.title,''),240) as title,char_length(coalesce(dv.title,''))>240 as "titleTruncated",
      p.code as project,u.code as principal,b.generation as "bindingGeneration",
      case when j.project_document_revision_id is not null then
          p.status='active' and d.status='active' and d.revision=dv.revision and d.project_id=p.id
        when f.state='preference' then j.operation='delete' or
          (u.status='active' and not u.pending_deletion and u.deleted_at is null and f.withdrawn_at is null
            and not exists(select 1 from memory_fragments newer where newer.supersedes_id=f.id))
        when f.state='discussed' and f.entry_id is null and r.topic_id is null and r.requirement_id is null then p.status='active'
        else exists (select 1 from requirement_topic_entries e join requirement_topics t on t.id=e.topic_id
          where e.id=f.entry_id and e.topic_id=r.topic_id and t.project_id=r.project_id and e.withdrawn_at is null
          and not exists(select 1 from requirement_topic_entries n where n.supersedes_entry_id=e.id)) end as eligible
    from claimed j left join memory_fragments f on f.id=j.fragment_id
    left join memory_capture_receipts r on r.id=f.receipt_id
    left join project_document_revisions dv on dv.id=j.project_document_revision_id
    left join project_documents d on d.id=dv.document_id
    join projects p on p.id=coalesce(r.project_id,d.project_id)
    left join users u on u.id=coalesce(r.principal_id,dv.created_by)
    left join project_memory_bindings b on b.project_id=p.id`, [Object.keys(config.projects), Object.keys(config.accounts), Boolean(config.personalProvisioning)]);
  const job = rows[0];
  if (!job) return null;
  const deliver = async (connection: MemoryQuery = db.$client) => {
  if (!await sameClaim(connection, job)) return { engine: job.engine, status: 'lease_changed' };
  if (!job.eligible) {
    await connection.query(`update memory_projection_jobs set status='needs_reconcile',lease_until=null,last_error='source_unavailable'
      where id=$1 and attempts=$2 and generation=$3 and operation=$4 and status='processing'`,[job.id,job.attempts,job.generation,job.operation]);
    return {engine:job.engine, status:'source_unavailable'};
  }
  let ref: string;
  let deliveryConfig = config;
  if (job.engine === 'tencent') {
    const resolved = await resolveProjectMemoryEngines(db, config, job.project);
    if (!resolved.config.projects[job.project] || resolved.generation !== job.bindingGeneration) {
      await connection.query(`update memory_projection_jobs set status='needs_reconcile',lease_until=now()+interval '30 seconds',last_error='project_memory_changed'
        where id=$1 and attempts=$2 and generation=$3 and operation=$4 and status='processing'`, [job.id, job.attempts, job.generation, job.operation]);
      return { engine: job.engine, status: 'binding_changed' };
    }
    deliveryConfig = resolved.config;
  }
  try {
    if (job.engine === 'openviking' && job.state === 'preference') ref = job.operation === 'delete'
      ? await deletePersonal(deliveryConfig, job) : await putPersonal(deliveryConfig, job);
    else if (job.engine === 'tencent' && job.operation === 'upsert' && ['discussed','confirmed','documented'].includes(job.state)) ref = await putWiki(deliveryConfig, job);
    else throw Error('Inconsistent destination');
  } catch (error) {
    const diagnoses = new Map([
      ['Wiki ingestion pending','wiki_ingesting'], ['Wiki ingestion failed','wiki_ingest_failed'],
      ['Remote content changed','remote_content_changed'], ['Wiki page not indexed','wiki_index_pending'],
      ['Engine readback mismatch','readback_mismatch'], ['Missing personal mapping','mapping_missing'],
      ['Missing Wiki mapping','mapping_missing'], ['Wiki identity mismatch','identity_mismatch'],
      ['Personal identity mismatch','identity_mismatch'],
    ]);
    const code = error instanceof Error ? diagnoses.get(error.message) ?? 'delivery_not_verified' : 'delivery_not_verified';
    await compensateLatePersonalWrite(connection, job);
    if (!await sameClaim(connection, job)) return { engine: job.engine, status: 'lease_changed' };
    await connection.query(`update memory_projection_jobs set status='needs_reconcile',last_error=$3,
      lease_until=now()+least(attempts,20)*interval '30 seconds' where id=$1 and attempts=$2
        and generation=$4 and operation=$5 and status='processing'`,[job.id,job.attempts,code,job.generation,job.operation]);
    return { engine:job.engine, status:'needs_reconcile', code };
  }
  if (job.engine === 'tencent') {
    const current = await resolveProjectMemoryEngines(db, config, job.project);
    if (!current.config.projects[job.project] || current.generation !== job.bindingGeneration) {
      await connection.query(`update memory_projection_jobs set status='needs_reconcile',lease_until=now()+interval '30 seconds',last_error='project_memory_changed'
        where id=$1 and attempts=$2 and generation=$3 and operation=$4 and status='processing'`, [job.id, job.attempts, job.generation, job.operation]);
      return { engine: job.engine, status: 'binding_changed' };
    }
  }
  // Share the project fence with pause/provision so the final acknowledgement is
  // atomic with the binding check, rather than racing a preceding read.
  const result = job.engine === 'openviking' ? await connection.query(`update memory_projection_jobs set
      status='synced',external_ref=$1,lease_until=null,last_error=null
      where id=$2 and attempts=$3 and generation=$4 and operation=$5 and status='processing'
        and ($5='delete' or exists (select 1 from memory_fragments f
          join memory_capture_receipts r on r.id=f.receipt_id join users u on u.id=r.principal_id
          where f.id=$6 and f.state='preference' and f.withdrawn_at is null
            and u.status='active' and not u.pending_deletion and u.deleted_at is null
            and not exists(select 1 from memory_fragments newer where newer.supersedes_id=f.id)))`,
    [ref,job.id,job.attempts,job.generation,job.operation,job.fragmentId]) : await db.transaction(async tx => {
    if (job.engine === 'tencent') {
      // Same hashtext encoding as application/aggregate-lock.ts and migration 0046.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('project:' || id::text)::bigint) from projects where code=${job.project}`);
    }
    return tx.execute(sql`update memory_projection_jobs set status='synced',external_ref=${ref},lease_until=null,last_error=null
      where id=${job.id} and attempts=${job.attempts} and generation=${job.generation} and operation=${job.operation} and status='processing'
        and (${job.engine} <> 'tencent' or exists (
          select 1 from projects p left join project_memory_bindings b on b.project_id=p.id
          where p.code=${job.project} and p.status='active' and
            (b.id is null and ${job.bindingGeneration}::integer is null or
             b.enabled and b.state='ready' and b.generation=${job.bindingGeneration}::integer)))`);
  });
  if (result.rowCount !== 1) await compensateLatePersonalWrite(connection, job);
  return { engine:job.engine, status:result.rowCount === 1 ? 'synced' : 'lease_changed',
    ...(job.sourceKind === 'project_document' ? { sourceKind:job.sourceKind, source:job.code,
      semanticIndex: job.text.length > maxCoreDocumentChars ? 'wiki_only_size_limit' :
        deliveryConfig.projects[job.project]?.semanticAgentId ? 'wiki_and_core' : 'wiki_only_not_configured' } : {}),
  };
  };
  if (job.engine !== 'openviking' || job.fragmentId === null) return deliver();
  // This connection holds only a per-fragment advisory lock during HTTP I/O;
  // it never row-locks the source/outbox, so a user's edit/withdrawal can commit.
  // All compliant workers serialize before checking the current generation.
  const client = await db.$client.connect();
  try {
    await client.query('BEGIN');
    await client.query("select pg_advisory_xact_lock(hashtext('memory_projection_fragment:' || $1::text)::bigint)", [job.fragmentId]);
    const result = await deliver(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export type MemoryEngineChannel = 'wiki' | 'core' | 'viking';
export type MemoryEngineMatches = Record<MemoryEngineChannel, string[]>;
// The Wiki and Core return scores on different scales. Fuse their rank positions;
// preserve exact platform matches independently of the semantic expansion budget.
export function rankedMemoryRefs(hits: MemoryEngineMatches): string[] {
  if (!hits.core.length) return [...new Set([...hits.wiki, ...hits.viking])];
  const scores = new Map<string, number>();
  for (const channel of [hits.wiki, hits.core]) {
    for (const [rank, ref] of [...new Set(channel)].entries()) {
      scores.set(ref, (scores.get(ref) ?? 0) + 1 / (61 + rank));
    }
  }
  return [...scores].sort((a,b) => b[1] - a[1]).slice(0,4).map(([ref]) => ref);
}
export async function searchMemoryEngineDetailed(config: EngineConfig, actor: {principalCode:string; projectCode:string},
    query: string, scope: 'project'|'personal') {
  const hits: MemoryEngineMatches = {wiki:[],core:[],viking:[]};
  const degraded: MemoryEngineChannel[] = [];
  if (scope === 'project') {
    if (!config.projects[actor.projectCode]) return {...hits,degraded};
    const p = await ownedWiki(config, actor.projectCode);
    const [pages, records] = await Promise.allSettled([
      wiki(config, 'search', {wiki_id:p.wikiId,query,limit:12}),
      p.semanticAgentId ? core(config,p,'search',{query,limit:12}) : Promise.resolve(null),
    ]);
    if (pages.status === 'fulfilled') hits.wiki = (pages.value?.results ?? []).slice(0,12).map(r => String(r.path).replace(/\\/g,'/'))
      .filter(path => /^wiki\/sources\/tsp-(?:evidence|material)-[0-9a-f]{64}\.md$/u.test(path))
      .map(path => 'wiki:' + p.wikiId + '/' + path);
    else degraded.push('wiki');
    if (records.status === 'fulfilled') {
      for (const record of (records.value?.messages ?? []).slice(0,12)) {
        const trailer = typeof record.content === 'string' && /\n\n\[tsp-evidence ([a-zA-Z0-9_.-]+) ([0-9A-HJKMNP-TV-Z]{20})\]$/u.exec(record.content);
        if (record.role === 'assistant' && trailer && trailer[1] === p.wikiId && trailer[2]) {
          hits.core.push('wiki:'+p.wikiId+'/'+evidencePage(actor.projectCode,trailer[2]));
        }
        const material = typeof record.content === 'string' && /\n\n\[tsp-material-index ([a-zA-Z0-9_.-]+) ([0-9A-HJKMNP-TV-Z]{20})\]$/u.exec(record.content);
        if (record.role === 'assistant' && material && material[1] === p.wikiId && material[2]) {
          hits.core.push('wiki:'+p.wikiId+'/'+projectMaterialIndexPage(actor.projectCode,material[2]));
        }
      }
    } else degraded.push('core');
    return {...hits,degraded};
  }
  const account = config.accounts[actor.principalCode] ?? (config.personalProvisioning
    ? await ensurePersonalMemoryResource(config,actor.principalCode) : undefined);
  if (!account) return {...hits,degraded};
  const root = personalRoot(account);
  const result = await request<{memories:{uri:string;score:number}[]}>(baseUrl(config.openviking.baseUrl) + '/api/v1/search/find', {'x-api-key':account.apiKey},
    {query, target_uri:root, context_type:'memory', tags:['source=tsp_personal'], limit:12, score_threshold:0.75});
  hits.viking = (result?.memories ?? []).slice(0,12).filter(hit => hit.score >= 0.75 && typeof hit.uri === 'string' &&
    hit.uri.startsWith(root) && hit.uri.endsWith('.json') && platformCode.test(hit.uri.slice(root.length,-5))).map(hit => hit.uri);
  return {...hits,degraded};
}

export async function searchMemoryEngine(config: EngineConfig, actor: {principalCode:string; projectCode:string},
    query:string, scope:'project'|'personal'): Promise<string[]> {
  const matches = await searchMemoryEngineDetailed(config,actor,query,scope);
  return rankedMemoryRefs(matches);
}

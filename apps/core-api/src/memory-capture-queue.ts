import { createHash } from 'node:crypto';
import { createMemorySliceUseCases } from '@team-synergy/application';
import { MemoryCaptureInput } from '@team-synergy/contracts';
import { DomainError } from '@team-synergy/domain';
import type { Db } from '@team-synergy/persistence';
import { sql } from 'drizzle-orm';
import { extractMemoryParts } from './memory-extraction.js';

type Actor = { principalCode: string; projectCode: string };
type Capture = Actor & MemoryCaptureInput;
type Job = { code: string; status: string; attempts: number; result_json: string | null; last_error_code: string | null };
const messages: Record<string, string> = {
  memory_needs_clarification: '请澄清个人偏好、项目讨论或要采纳的业务对象。',
  memory_ambiguous: '请明确业务对象及其当前版本后，用新事件确认。',
  memory_source_changed: '来源版本已变化，请核对后创建新事件。',
  memory_model_unavailable: '整理服务暂不可用，可重试此事件。',
  memory_no_material: '此事件只用于当次工作，没有形成长期记忆。',
  memory_capture_failed: '整理暂未完成，可重试或检查服务状态。',
};
const view = (job: Job) => ({ captureCode: job.code, status: job.status, attempts: job.attempts,
  ...(job.result_json ? { result: JSON.parse(job.result_json) as unknown } : {}),
  ...(job.last_error_code ? { error: { code: job.last_error_code,
    message: messages[job.last_error_code] ?? '请核对来源、权限与业务对象后创建新事件。' } } : {}) });
const fingerprint = (input: MemoryCaptureInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');

async function currentView(db: Db, actor: Actor, job: Job, body: MemoryCaptureInput) {
  const status = view({ ...job, result_json: null });
  if (job.status !== 'completed') return status;
  // A completed job is an audit record, not a durable grant to reuse old text.
  // Editing, withdrawing, replacing a decision or losing access invalidates its
  // cached result through the same authoritative source checks as normal reads.
  try {
    const result = await createMemorySliceUseCases(db).replay({ ...body, ...actor });
    return { ...status, ...(result ? { result, resultCurrent: true } : { resultUnavailable: true }) };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { ...status, resultUnavailable: true };
  }
}

export async function enqueueMemoryCapture(db: Db, command: Capture) {
  const memory = createMemorySliceUseCases(db);
  // Authorization and replay validation run before any transcript is persisted.
  const previous = await memory.replay(command);
  const parsed = MemoryCaptureInput.parse(commandBody(command));
  const hash = fingerprint(parsed);
  const existing = await db.$client.query<Job & { source_hash: string }>(`select j.code,j.status,j.attempts,j.result_json,j.last_error_code,j.source_hash
    from memory_capture_jobs j join projects p on p.id=j.project_id join users u on u.id=j.principal_id
    where p.code=$1 and u.code=$2 and j.session_key=$3 and j.event_key=$4`,
  [command.projectCode,command.principalCode,command.sessionId,command.eventId]);
  if (existing.rows[0]) {
    if (existing.rows[0].source_hash !== hash) throw new DomainError('memory_event_conflict', '该事件已记录不同的原文或绑定。');
    return currentView(db,command,existing.rows[0],parsed);
  }
  if (!previous) {
    const binding = await memory.inspect(command);
    if (command.topicCode && (binding.expectedHead !== command.expectedHead || binding.expectedRevision !== command.expectedRevision)) {
      throw new DomainError('memory_source_changed', '来源版本已变化，请核对后创建新事件。');
    }
  }
  const result = await db.$client.query<Job & { source_hash: string }>(`insert into memory_capture_jobs
    (project_id,principal_id,session_key,event_key,source_hash,payload_json,status,result_json)
    select p.id,u.id,$3,$4,$5,$6,$7,$8 from projects p,users u where p.code=$1 and u.code=$2
    on conflict(project_id,principal_id,session_key,event_key) do update set source_hash=memory_capture_jobs.source_hash
    returning code,status,attempts,result_json,last_error_code,source_hash`,
  [command.projectCode,command.principalCode,command.sessionId,command.eventId,hash,JSON.stringify(parsed),
    previous ? 'completed' : 'pending', previous ? JSON.stringify(previous) : null]);
  const job = result.rows[0];
  if (!job) throw new DomainError('memory_forbidden', '无权采集此会话。');
  if (job.source_hash !== hash) throw new DomainError('memory_event_conflict', '该事件已记录不同的原文或绑定。');
  return currentView(db,command,job,parsed);
}

function commandBody(command: Capture): MemoryCaptureInput {
  const { principalCode: _principal, projectCode: _project, ...body } = command;
  return body;
}

export async function readMemoryCapture(db: Db, actor: Actor, captureCode: string) {
  await createMemorySliceUseCases(db).inspect(actor);
  const { rows } = await db.$client.query<Job & { payload_json: string }>(`select j.code,j.status,j.attempts,j.result_json,j.last_error_code,j.payload_json
    from memory_capture_jobs j join projects p on p.id=j.project_id join users u on u.id=j.principal_id
    where j.code=$1 and p.code=$2 and u.code=$3`, [captureCode,actor.projectCode,actor.principalCode]);
  if (!rows[0]) throw new DomainError('memory_capture_not_found', '找不到本人的采集事件。');
  return currentView(db,actor,rows[0],MemoryCaptureInput.parse(JSON.parse(rows[0].payload_json)));
}

export async function retryMemoryCapture(db: Db, actor: Actor, captureCode: string) {
  await readMemoryCapture(db,actor,captureCode);
  const { rows } = await db.$client.query<Job>(`update memory_capture_jobs j
    set status='pending',lease_until=null,last_error_code=null,updated_at=now()
    from projects p,users u where j.project_id=p.id and j.principal_id=u.id and
    j.code=$1 and p.code=$2 and u.code=$3 and j.status='failed' and j.attempts<5
    returning j.code,j.status,j.attempts,j.result_json,j.last_error_code`, [captureCode,actor.projectCode,actor.principalCode]);
  if (!rows[0]) throw new DomainError('memory_capture_state_conflict', '只有可重试的失败事件可以重试；澄清后请使用新事件。');
  return view(rows[0]);
}

/** One durable event per session at a time. Model work stays outside DB locks. */
export async function processNextMemoryCapture(db: Db, extract = extractMemoryParts) {
  await db.$client.query(`update memory_capture_jobs set status='failed',last_error_code='memory_capture_failed',
    lease_until=null,updated_at=now() where status='processing' and lease_until<now() and attempts>=5`);
  const { rows } = await db.$client.query<Job & { payload_json: string; principal: string; project: string }>(`
    with candidate as (select j.id from memory_capture_jobs j
      where (j.status='pending' or j.status='processing' and j.lease_until<now()) and j.attempts<5
        and not exists(select 1 from memory_capture_jobs older where older.id<j.id
          and older.project_id=j.project_id and older.principal_id=j.principal_id and older.session_key=j.session_key
          and older.status in ('pending','processing'))
      order by j.id for update skip locked limit 1), claimed as (
      update memory_capture_jobs j set status='processing',attempts=j.attempts+1,
      lease_until=now()+interval '2 minutes',updated_at=now() from candidate c where j.id=c.id returning j.*)
    select c.*,u.code principal,p.code project from claimed c
    join users u on u.id=c.principal_id join projects p on p.id=c.project_id`);
  const job = rows[0];
  if (!job) return null;
  try {
    const body = MemoryCaptureInput.parse(JSON.parse(job.payload_json));
    const command = { ...body, principalCode: job.principal, projectCode: job.project };
    const prior = await createMemorySliceUseCases(db).replay(command);
    const parts = prior ? null : await extract(command.sourceText);
    return await db.transaction(async tx => {
      const current = await tx.execute(sql`select id from memory_capture_jobs where code=${job.code}
        and attempts=${job.attempts} and status='processing' and lease_until>now() for update`);
      if (!current.rows.length) return { captureCode: job.code, status: 'lease_changed' };
      // Fence the side effect, not just its acknowledgement. This short native
      // transaction holds the job row while domain writes and ACK commit.
      const memory = createMemorySliceUseCases(tx as unknown as Db);
      const replayed = await memory.replay(command);
      const result = replayed ?? (parts ? await memory.capture({ ...command, parts }) : null);
      if (!result) throw new DomainError('memory_capture_failed', '来源无法恢复。');
      await tx.execute(sql`update memory_capture_jobs set status='completed',result_json=${JSON.stringify(result)},
        last_error_code=null,lease_until=null,updated_at=now() where code=${job.code} and attempts=${job.attempts} and status='processing'`);
      return { captureCode: job.code, status: 'completed' };
    });
  } catch (error) {
    const code = error instanceof DomainError ? error.code : 'memory_capture_failed';
    const status = code === 'memory_no_material' ? 'skipped' :
      ['memory_needs_clarification','memory_ambiguous','memory_source_changed','memory_revision_conflict',
        'memory_head_conflict','memory_scope_mismatch','memory_proposal_changed'].includes(code) ? 'needs_clarification' : 'failed';
    await db.$client.query(`update memory_capture_jobs set status=$3,last_error_code=$4,lease_until=null,updated_at=now()
      where code=$1 and attempts=$2 and status='processing'`, [job.code,job.attempts,status,code]);
    return { captureCode: job.code, status, errorCode: code };
  }
}

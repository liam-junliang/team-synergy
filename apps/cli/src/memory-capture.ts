import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { authDirectory } from './auth-store.js';
import { memoryContext, valueOf, type MemoryContext } from './memory.js';

type Witness = { expectedHead?: string | null; expectedRevision?: number };
type Target = Witness & { topicCode?: string; requirementCode?: string };
type Receipt = Witness & { receiptCode: string; replayed: boolean; items: unknown[] };
type CaptureStatus = 'pending' | 'processing' | 'completed' | 'needs_clarification' | 'skipped' | 'failed';
type CaptureJob = { captureCode: string; status: CaptureStatus; replayed?: boolean; attempts?: number;
  result?: Receipt; error?: { code: string; message: string } };
type Source = {
  file: string; cwd: string; offset: number; digest: string; identity: string;
  questionOffset?: number; userMirrorDigest?: string; pendingConfirmation?: string;
};
type Binding = Target & { source?: Source };
type HookEvent = { hook_event_name?: unknown; cwd?: unknown; session_id?: unknown; transcript_path?: unknown };
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const bareAdoption = /^(?:就按这个方案做|按这个方案做|确认采纳这个方案|确认采用这个方案|采纳这个方案)[。.!！]?$/u;
const clarification = '请在下一条发言中说明“确认采纳：方案原文”。';

function hostId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) throw new DomainError('invalid_host_id', '会话或事件 ID 无效');
  return id;
}

function assertWitness(value: Witness, required = false) {
  if (value && value.expectedRevision === undefined && value.expectedHead === undefined && !required) return;
  if (!value || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision ?? 0) < 1 ||
      !(value.expectedHead === null || typeof value.expectedHead === 'string')) {
    throw new DomainError('api_bad_response', '平台返回的对象版本无效');
  }
}

function captureJob(value: CaptureJob): CaptureJob {
  if (!value || !PublicCodeSchema.safeParse(value.captureCode).success ||
      !['pending', 'processing', 'completed', 'needs_clarification', 'skipped', 'failed'].includes(value.status)) {
    throw new DomainError('api_bad_response', '平台未返回有效的持久采集任务状态');
  }
  return value;
}

function captureJobsTable(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS capture_jobs (event_id TEXT PRIMARY KEY, capture_code TEXT NOT NULL UNIQUE, status TEXT NOT NULL, error_code TEXT)');
}

export async function readCaptureJob(code: string) {
  if (!PublicCodeSchema.safeParse(code).success) throw new DomainError('invalid_capture_code', '采集任务编码无效');
  const context = memoryContext();
  const value = captureJob(valueOf(await context.client.request<CaptureJob>('GET', context.route + '/captures/' + code)));
  if (value.captureCode !== code) throw new DomainError('api_bad_response', '采集任务身份不匹配');
  return value;
}

export async function retryCaptureJob(code: string) {
  if (!PublicCodeSchema.safeParse(code).success) throw new DomainError('invalid_capture_code', '采集任务编码无效');
  const context = memoryContext();
  const value = captureJob(valueOf(await context.client.request<CaptureJob>('POST', context.route + '/captures/' + code + '/retry')));
  if (value.captureCode !== code) throw new DomainError('api_bad_response', '采集任务身份不匹配');
  return value;
}

async function refreshCaptureJobs(db: DatabaseSync, context: MemoryContext) {
  captureJobsTable(db);
  const updates: CaptureJob[] = [];
  // One bounded status pass only. Hooks never call this function.
  const pending = db.prepare("SELECT capture_code FROM capture_jobs WHERE status IN ('pending','processing','failed') ORDER BY rowid LIMIT 20").all();
  const statusContext = memoryContext(5000);
  if (statusContext.owner !== context.owner) throw new DomainError('memory_binding_changed', '登录或工作区已切换，请重新同步');
  const results = await Promise.all(pending.map(async row => {
    const code = String(row.capture_code);
    const result = captureJob(valueOf(await statusContext.client.request<CaptureJob>('GET', context.route + '/captures/' + code)));
    if (result.captureCode !== code) throw new DomainError('api_bad_response', '采集任务身份不匹配');
    return result;
  }));
  for (const result of results) {
    const code = result.captureCode;
    db.prepare('UPDATE capture_jobs SET status=?,error_code=? WHERE capture_code=?').run(result.status, result.error?.code ?? null, code);
    updates.push(result);
  }
  return updates;
}

function sessionCaptureJobs(db: DatabaseSync) {
  captureJobsTable(db);
  return db.prepare('SELECT capture_code AS captureCode,status,error_code AS errorCode FROM capture_jobs ORDER BY rowid DESC LIMIT 50').all();
}

function canonical(file: unknown) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new DomainError('memory_source_invalid', '请选择宿主文件或工作目录的绝对路径');
  try { return realpathSync.native(file); }
  catch { throw new DomainError('memory_source_unavailable', '找不到已绑定的宿主文件或工作目录'); }
}

function rolloutPath(file: unknown) {
  const candidate = canonical(file);
  const sessions = canonical(path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions'));
  const relative = path.relative(sessions, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || path.extname(candidate) !== '.jsonl') {
    throw new DomainError('memory_source_invalid', '转录文件必须属于当前 Codex 宿主的 sessions 目录');
  }
  return candidate;
}

function readRollout(file: string) {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > 64n * 1024n * 1024n) throw new DomainError('memory_source_invalid', '请选择 64 MiB 以内的普通 Codex 转录文件');
    const bytes = Buffer.alloc(Number(stat.size));
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) throw new DomainError('memory_source_changed', '宿主转录在读取时被截断');
      read += count;
    }
    return { bytes, identity: stat.dev + '/' + stat.ino };
  } finally { closeSync(fd); }
}

function parseLine(line: Buffer) {
  try {
    const entry = JSON.parse(line.toString('utf8'));
    if (!entry || typeof entry !== 'object') throw new Error();
    return entry;
  } catch { throw new DomainError('memory_source_invalid', 'Codex 转录含无效记录'); }
}

function firstSource(fileArg: string, sessionId: string): Source {
  const file = rolloutPath(fileArg);
  const { bytes, identity } = readRollout(file);
  const end = bytes.indexOf(10);
  if (end === -1 || bytes.at(-1) !== 10) throw new DomainError('memory_source_pending', '请在 Codex 完成当前轮次后绑定');
  const meta = parseLine(bytes.subarray(0, end));
  const cwd = canonical(process.cwd());
  if (meta.type !== 'session_meta' || meta.payload?.id !== sessionId || canonical(meta.payload?.cwd) !== cwd) {
    throw new DomainError('memory_source_mismatch', '宿主会话或工作目录与绑定目标不符');
  }
  return { file, cwd, identity, offset: bytes.length, digest: hash(bytes) };
}

// Decode the host's completed events in the Codex CLI and desktop rollout formats.
function hostMessage(entry: ReturnType<typeof parseLine>, speaker: 'user' | 'assistant'): string | undefined {
  if (entry.type !== 'event_msg') return;
  const p = entry.payload;
  if (p?.type === (speaker === 'user' ? 'user_message' : 'agent_message') && typeof p.message === 'string') return p.message;
  const item = p?.item;
  if (p?.type !== 'item_completed' || item?.type !== (speaker === 'user' ? 'UserMessage' : 'AgentMessage')) return;
  const kind = speaker === 'user' ? 'text' : 'Text';
  if (Array.isArray(item.content) && item.content.length &&
      item.content.every((part: { type?: string; text?: string } | null) => part?.type === kind && typeof part.text === 'string')) {
    return item.content.map((part: { text: string }) => part.text).join('\n');
  }
  if (speaker === 'user') throw new DomainError('memory_source_unsupported', '该轮含有不支持的宿主输入，请核对原始会话');
}

function adoptionQuestion(text: unknown): text is string {
  return typeof text === 'string' && text === text.trim() && text.length <= 1000 && /^是否采纳《[^《》\r\n]+》[？?]$/u.test(text);
}

function precedingQuestion(source: Source, bytes: Buffer): string | undefined {
  // The cursor keeps an offset into the verified rollout, not an assistant transcript.
  if (source.questionOffset === undefined) return;
  const end = bytes.indexOf(10, source.questionOffset);
  if (end < 0) return;
  const row = parseLine(bytes.subarray(source.questionOffset, end));
  const text = hostMessage(row, 'assistant');
  if (adoptionQuestion(text)) return text;
}

function clearQuestion(source: Source) {
  delete source.questionOffset;
  delete source.userMirrorDigest;
}

function trackContext(entry: ReturnType<typeof parseLine>, source: Source, bytes: Buffer) {
  const payload = entry.payload;
  const assistant = hostMessage(entry, 'assistant');
  if (assistant !== undefined) {
    clearQuestion(source);
    if (adoptionQuestion(assistant)) {
      source.questionOffset = source.offset;
    }
    return;
  }
  if (source.questionOffset === undefined) return;
  if (entry.type === 'token_usage_record') return;
  if (entry.type === 'event_msg' && ['token_count', 'task_started'].includes(payload?.type)) return;
  if (entry.type === 'event_msg' && payload?.type === 'task_complete' &&
      (payload.last_agent_message == null || payload.last_agent_message === precedingQuestion(source, bytes))) return;
  if (entry.type === 'turn_context' && typeof payload?.cwd === 'string' && path.relative(source.cwd, payload.cwd) === '' &&
      !payload.user_instructions && !payload.developer_instructions) return;
  if (entry.type === 'response_item' && payload?.type === 'message' && Array.isArray(payload.content) && payload.content.length === 1) {
    const part = payload.content[0];
    if (payload.role === 'assistant' && part?.type === 'output_text' && part.text === precedingQuestion(source, bytes) && !source.userMirrorDigest) return;
    if (payload.role === 'user' && part?.type === 'input_text' && typeof part.text === 'string' &&
        bareAdoption.test(part.text.trim()) && !source.userMirrorDigest) {
      source.userMirrorDigest = hash(part.text);
      return;
    }
  }
  // Tool calls, tool results, developer instructions, compaction and unknown
  // records break adjacency. A response_item mirror can never restore it.
  clearQuestion(source);
}

function databaseFile(context: MemoryContext, sessionId: string) {
  return path.join(authDirectory(), 'memory-sessions', hash(context.owner + '\n' + hostId(sessionId)) + '.sqlite');
}

// Each session serializes the witness, cursor and HTTP operation. A crash before
// commit retries the same event/witness against the server's idempotency receipt.
async function transaction<T>(file: string, create: boolean, action: (db: DatabaseSync) => Promise<T>) {
  if (!create && !existsSync(file)) throw new DomainError('memory_unbound', '当前账号与工作区尚未绑定该会话');
  if (create) mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 2500');
    if (create) db.exec('CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, digest TEXT NOT NULL, witness TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    const result = await action(db);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); } // Closing rolls back any uncommitted transaction.
}

function loadBinding(db: DatabaseSync): Binding {
  const row = db.prepare('SELECT data FROM binding WHERE id=1').get();
  if (!row) throw new DomainError('memory_unbound', '当前账号与工作区尚未绑定该会话');
  return JSON.parse(String(row.data));
}

function saveBinding(db: DatabaseSync, binding: Binding) {
  db.prepare('INSERT OR REPLACE INTO binding(id,data) VALUES(1,?)').run(JSON.stringify(binding));
}

export async function bindSession(opts: { session: string; topic?: string; requirement?: string; transcript?: string }) {
  const objectBound = opts.topic !== undefined || opts.requirement !== undefined;
  if (objectBound && (!opts.topic || !opts.requirement)) throw new DomainError('memory_target_required', 'topic 与 requirement 必须成对提供；无任务讨论可以同时省略。');
  const query = opts.topic !== undefined && opts.requirement !== undefined ? '?' + new URLSearchParams({ topicCode: opts.topic, requirementCode: opts.requirement }) : '';
  const context = memoryContext();
  const file = databaseFile(context, opts.session);
  if (valueOf(await context.client.whoami()).user_code !== context.actor) throw new DomainError('memory_actor_mismatch', '设备登录身份与本机账号不匹配');
  return transaction(file, true, async db => {
    if (db.prepare('SELECT id FROM binding').get()) throw new DomainError('memory_already_bound', '会话已绑定，请先核对旧记录并显式解除绑定');
    const target = valueOf(await context.client.request<Target>('GET', context.route + '/binding' + query));
    assertWitness(target, objectBound);
    if (target.topicCode !== opts.topic || target.requirementCode !== opts.requirement) throw new DomainError('memory_target_mismatch', '平台返回的对象与所选对象不符');
    if (!objectBound && (target.expectedHead !== undefined || target.expectedRevision !== undefined)) throw new DomainError('api_bad_response', '无业务对象的会话不能携带对象版本见证');
    const source = opts.transcript ? firstSource(opts.transcript, opts.session) : undefined;
    saveBinding(db, { ...target, source });
    return { ...target, sessionId: opts.session, transcriptBound: Boolean(source) };
  });
}

function checkpoint(db: DatabaseSync, binding: Binding) {
  saveBinding(db, binding);
  db.exec('COMMIT; BEGIN IMMEDIATE');
  if (JSON.stringify(loadBinding(db)) !== JSON.stringify(binding)) {
    throw new DomainError('memory_session_changed', '会话同步中绑定已变更，请重新同步');
  }
}

async function deliver(db: DatabaseSync, context: MemoryContext, binding: Binding, sessionId: string, eventId: string, sourceText: string, referenceText?: string) {
  if (!sourceText.trim() || sourceText.length > 4000) throw new DomainError('invalid_source_text', '每条来源发言应为 1 至 4000 字符');
  const previous = db.prepare('SELECT digest,witness FROM events WHERE id=?').get(eventId);
  const digest = referenceText === undefined ? hash(sourceText) : hash(JSON.stringify([sourceText, referenceText]));
  if (previous && previous.digest !== digest) throw new DomainError('memory_event_changed', '同一事件 ID 的来源文本发生变化');
  const witness: Target = previous ? JSON.parse(String(previous.witness)) : {
    expectedHead: binding.expectedHead, expectedRevision: binding.expectedRevision,
    topicCode: binding.topicCode, requirementCode: binding.requirementCode,
  };
  if (witness.topicCode !== binding.topicCode || witness.requirementCode !== binding.requirementCode) {
    throw new DomainError('memory_target_mismatch', '该事件已经绑定其他项目对象');
  }
  // Pin the original witness even when the remote call times out or conflicts.
  if (!previous) {
    db.prepare('INSERT INTO events(id,digest,witness) VALUES(?,?,?)').run(eventId, digest, JSON.stringify(witness));
    checkpoint(db, binding);
  }
  if (!binding.topicCode) {
    const queueContext = memoryContext(5000);
    if (queueContext.owner !== context.owner) throw new DomainError('memory_binding_changed', '登录或工作区已切换，请重新采集');
    const job = captureJob(valueOf(await queueContext.client.request<CaptureJob>('POST', context.route + '/capture-events', {
      sessionId, eventId, sourceText, referenceText,
    })));
    captureJobsTable(db);
    const prior = db.prepare('SELECT capture_code FROM capture_jobs WHERE event_id=?').get(eventId);
    if (prior && prior.capture_code !== job.captureCode) throw new DomainError('api_bad_response', '同一事件返回了不同的持久采集任务');
    db.prepare('INSERT INTO capture_jobs(event_id,capture_code,status) VALUES(?,?,?) ON CONFLICT(event_id) DO UPDATE SET status=excluded.status')
      .run(eventId, job.captureCode, job.status);
    return job;
  }
  const receipt = valueOf(await context.client.request<Receipt>('POST', context.route + '/captures', {
    sessionId, eventId, sourceText, referenceText, ...witness,
  }));
  assertWitness(receipt, binding.topicCode !== undefined);
  if (typeof receipt.receiptCode !== 'string' || !receipt.receiptCode || !Array.isArray(receipt.items) || typeof receipt.replayed !== 'boolean') {
    throw new DomainError('api_bad_response', '平台未返回有效的事件回执');
  }
  if (binding.expectedRevision === witness.expectedRevision && binding.expectedHead === witness.expectedHead) {
    binding.expectedHead = receipt.expectedHead;
    binding.expectedRevision = receipt.expectedRevision;
  }
  return receipt;
}

export async function captureText(sessionId: string, userEvent: string, text: string) {
  const context = memoryContext(55000);
  const eventId = hostId(userEvent);
  if (eventId.startsWith('codex.')) throw new DomainError('reserved_event_id', 'codex. 前缀由宿主使用');
  return transaction(databaseFile(context, sessionId), false, async db => {
    const binding = loadBinding(db);
    const receipt = await deliver(db, context, binding, sessionId, eventId, text);
    saveBinding(db, binding);
    return receipt;
  });
}

export async function syncSession(sessionId: string, hook?: HookEvent) {
  const context = memoryContext(55000);
  return transaction(databaseFile(context, sessionId), false, async db => {
    const binding = loadBinding(db);
    const updatedJobs = hook || binding.topicCode ? [] : await refreshCaptureJobs(db, context);
    const source = binding.source;
    if (!source) {
      if (binding.topicCode) throw new DomainError('memory_transcript_unbound', '此会话仅启用了显式 stdin 采集');
      return { appended: 0, queued: 0, skipped: 0, sessionId, jobs: sessionCaptureJobs(db), updatedJobs };
    }
    if (canonical(process.cwd()) !== source.cwd || (hook && (canonical(hook.cwd) !== source.cwd || canonical(hook.transcript_path) !== source.file))) {
      throw new DomainError('memory_source_mismatch', 'Stop 事件与绑定的宿主来源不符');
    }
    const { bytes, identity } = readRollout(rolloutPath(source.file));
    const prefix = createHash('sha256').update(bytes.subarray(0, source.offset));
    if (identity !== source.identity || source.offset > bytes.length || prefix.copy().digest('hex') !== source.digest) {
      throw new DomainError('memory_source_changed', '宿主转录被替换、截断或改写，请检查来源');
    }
    let appended = 0;
    let queued = 0;
    let skipped = 0;
    let end: number;
    while ((end = bytes.indexOf(10, source.offset)) !== -1) {
      const line = bytes.subarray(source.offset, end);
      const entry = parseLine(line);
      if (entry.type === 'session_meta') throw new DomainError('memory_source_mismatch', '转录包含另一段会话');
      // Codex also mirrors role:user messages in response_item, including host
      // instructions. Only the actual user_message event is operator input.
      const text = hostMessage(entry, 'user');
      const userTurn = text !== undefined && text.trim().length > 0;
      if (userTurn) {
        const eventId = 'codex.' + hash(sessionId + '/' + source.offset + '/' + hash(line));
        const bare = bareAdoption.test(text.trim());
        const reference = bare && (!source.userMirrorDigest || source.userMirrorDigest === hash(text)) ? precedingQuestion(source, bytes) : undefined;
        try {
          const receipt = await deliver(db, context, binding, sessionId, eventId, text, reference);
          if ('items' in receipt && receipt.items.some(item => typeof item === 'object' && item !== null && 'state' in item && item.state === 'confirmed')) {
            delete source.pendingConfirmation;
          }
          if ('captureCode' in receipt) queued++;
          else appended++;
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          if (error.code === 'memory_no_material') skipped++;
          else if (bare && error.code === 'memory_ambiguous') {
            // Preserve the rejected event locally. A fresh, explicit answer
            // can now arrive behind it without discarding unrelated turns.
            db.exec('CREATE TABLE IF NOT EXISTS clarifications (event_id TEXT PRIMARY KEY, source_offset INTEGER NOT NULL)');
            db.prepare('INSERT OR IGNORE INTO clarifications VALUES(?,?)').run(eventId, source.offset);
            source.pendingConfirmation = eventId;
          } else throw error;
        }
        clearQuestion(source);
      } else trackContext(entry, source, bytes);
      prefix.update(bytes.subarray(source.offset, end + 1));
      source.offset = end + 1;
      source.digest = prefix.copy().digest('hex');
      if (userTurn) {
        // Commit each disposition before handling a later turn that may conflict.
        checkpoint(db, binding);
      }
    }
    saveBinding(db, binding);
    return { appended, queued, skipped, sessionId, offset: source.offset,
      ...(!binding.topicCode ? { jobs: sessionCaptureJobs(db), updatedJobs } : {}),
      ...(source.pendingConfirmation ? { clarification: { eventId: source.pendingConfirmation, message: clarification } } : {}) };
  });
}

export async function stopHook(input: string) {
  let event: HookEvent;
  try { event = JSON.parse(input); } catch { throw new DomainError('memory_hook_invalid', 'Stop 输入格式无效'); }
  if (event?.hook_event_name !== 'Stop') return;
  try {
    const sessionId = hostId(event.session_id);
    if (!event.transcript_path) {
      const file = databaseFile(memoryContext(), sessionId);
      await transaction(file, false, async db => {
        if (loadBinding(db).source) process.stderr.write('memory_transcript_unavailable 宿主未提供转录路径，请使用 tsp memory sync --session ' + sessionId + '\n');
      });
      return;
    }
    const result = await syncSession(sessionId, event);
    if ('clarification' in result && result.clarification) process.stderr.write('memory_ambiguous ' + clarification + '\n');
  } catch (error) {
    if (error instanceof DomainError && ['memory_unbound', 'login_required', 'project_binding_required', 'memory_transcript_unbound'].includes(error.code)) return;
    throw error;
  }
}

export async function unbindSession(sessionId: string) {
  const context = memoryContext();
  return transaction(databaseFile(context, sessionId), false, async db => {
    db.exec('DELETE FROM binding');
    return { sessionId, bound: false };
  });
}

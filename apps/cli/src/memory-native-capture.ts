import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema } from '@team-synergy/contracts';
import { authDirectory } from './auth-store.js';
import { memoryContext, valueOf } from './memory.js';

export type NativeHarness = 'dsh' | 'opencode' | 'codex';
export type NativeCaptureEvent = { eventId: string; sourceText: string; nativeMessageId: string; nativeSeq?: number };
export type NativePendingQuery = { nativeMessageId?: string; after?: number };
export type NativePendingCapture = NativeCaptureEvent & { cursor: number };
export interface NativeCaptureScope {
  harness: NativeHarness;
  hostSessionId: string;
  memorySession: string;
  owner: string;
}
export interface NativeCaptureBridgeConfig extends NativeCaptureScope {
  cwd: string;
  memberHome: string;
  cliPath: string;
  nodePath: string;
  auditFile?: string;
}
type OutboxRow = { cursor?: number; event_id: string; source_text: string; native_message_id: string; native_seq: number | null;
  digest: string; state: string; claim: string | null; lease_until: number | null; capture_code: string | null; last_error: string | null };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/u.test(value);
const invalid = () => new DomainError('memory_native_invalid', '原生采集配置或事件无效');

export function nativeCaptureEventId(harness: NativeHarness, hostSessionId: string, nativeMessageId: string) {
  if (!['dsh', 'opencode', 'codex'].includes(harness) || !id(hostSessionId) || !id(nativeMessageId)) throw invalid();
  return `native.${harness}.${hash(JSON.stringify([hostSessionId, nativeMessageId]))}`;
}

function scopeContext(scope: NativeCaptureScope) {
  if (!scope || !['dsh', 'opencode', 'codex'].includes(scope.harness) || !id(scope.hostSessionId) || !id(scope.memorySession)
    || typeof scope.owner !== 'string' || !/^[a-f0-9]{64}$/u.test(scope.owner)) throw invalid();
  const context = memoryContext(5000);
  if (scope.owner !== context.owner) throw new DomainError('memory_binding_changed', '账号、设备或项目已切换，请重新确认原生采集配置');
  return context;
}

export async function withNativeCaptureOutbox<T>(scope: NativeCaptureScope, work: (db: DatabaseSync, context: ReturnType<typeof memoryContext>) => T | Promise<T>) {
  const context = scopeContext(scope);
  const directory = path.join(authDirectory(), 'memory-native-outbox');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Imported only inside the fixed Node CLI, never by a Bun-hosted plugin.
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(directory, hash(JSON.stringify([scope.owner, scope.harness, scope.hostSessionId, scope.memorySession])) + '.sqlite');
  const deadline = Date.now() + 5000;
  let db: DatabaseSync | undefined, attempts = 0;
  do {
    scopeContext(scope);
    try {
      db = new DatabaseSync(file);
      // WAL conversion can return SQLITE_BUSY without invoking busy_timeout.
      db.exec(`PRAGMA busy_timeout=${Math.max(0, deadline - Date.now())}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS scope (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, native_message_id TEXT NOT NULL,
        native_seq INTEGER, source_text TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('staged','ready','sending','accepted')),
        claim TEXT, lease_until INTEGER, capture_code TEXT, last_error TEXT, attempts INTEGER NOT NULL DEFAULT 0);`);
      const identity = JSON.stringify({ harness:scope.harness,hostSessionId:scope.hostSessionId,memorySession:scope.memorySession,
        owner:scope.owner,projectCode:context.projectCode,root:context.root });
      db.prepare('INSERT OR IGNORE INTO scope(id,value) VALUES(1,?)').run(identity);
      if (db.prepare('SELECT value FROM scope WHERE id=1').get()?.value !== identity) throw invalid();
      db.exec('PRAGMA busy_timeout=5000');
    } catch (error) {
      db?.close(); db = undefined;
      if (!(error instanceof Error) || !('errcode' in error) || typeof error.errcode !== 'number' ||
        (error.errcode & 255) !== 5 || Date.now() >= deadline) throw error;
      await delay(Math.min(100, 20 * ++attempts, deadline - Date.now()));
    }
  } while (!db);
  // Retry only idempotent initialization, never a caller's transaction or HTTP delivery.
  try { return await work(db, context); } finally { db.close(); }
}

function eventInput(scope: NativeCaptureScope, event: NativeCaptureEvent) {
  if (!event || event.eventId !== nativeCaptureEventId(scope.harness, scope.hostSessionId, event.nativeMessageId)
    || typeof event.sourceText !== 'string' || !event.sourceText.trim() || event.sourceText.length > 4000
    || (event.nativeSeq !== undefined && (!Number.isSafeInteger(event.nativeSeq) || event.nativeSeq < 0))) throw invalid();
}

/** Local durable ACK only. No HTTP, model call or business-object binding. */
export async function enqueueNativeCapture(scope: NativeCaptureScope, event: NativeCaptureEvent, ready = true) {
  eventInput(scope, event);
  return withNativeCaptureOutbox(scope, db => {
    const digest = hash(event.sourceText);
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT digest,state,capture_code FROM events WHERE event_id=?').get(event.eventId);
      if (previous && previous.digest !== digest) throw new DomainError('memory_event_changed', '同一原生消息的来源内容发生变化');
      db.prepare(`INSERT OR IGNORE INTO events(event_id,native_message_id,native_seq,source_text,digest,state)
        VALUES(?,?,?,?,?,?)`).run(event.eventId, event.nativeMessageId, event.nativeSeq ?? null, event.sourceText, digest, ready ? 'ready' : 'staged');
      // A candidate is promoted only by explicit post-persistence confirmation.
      db.exec('COMMIT');
      return { eventId: event.eventId, durable: true, state: String(previous?.state ?? (ready ? 'ready' : 'staged')),
        ...(previous?.capture_code ? { captureCode: String(previous.capture_code) } : {}) };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
}

export async function pendingNativeCapture(scope: NativeCaptureScope, query: NativePendingQuery = {}): Promise<NativePendingCapture[]> {
  const after=query.after??0;
  if(!Number.isSafeInteger(after)||after<0||(query.nativeMessageId!==undefined&&!id(query.nativeMessageId)))throw invalid();
  return withNativeCaptureOutbox(scope, db => (db.prepare("SELECT rowid AS cursor,* FROM events WHERE state='staged' AND rowid>?"+
    (query.nativeMessageId===undefined?'':' AND native_message_id=?')+' ORDER BY rowid LIMIT 100')
    .all(after,...(query.nativeMessageId===undefined?[]:[query.nativeMessageId])) as OutboxRow[])
    .map(row => ({ eventId: row.event_id, sourceText: row.source_text, nativeMessageId: row.native_message_id,
      cursor:Number(row.cursor),...(row.native_seq !== null ? { nativeSeq: row.native_seq } : {}) })));
}

export async function confirmNativeCapture(scope: NativeCaptureScope, event: { eventId: string; sourceText: string }) {
  return withNativeCaptureOutbox(scope, db => {
    const row = db.prepare('SELECT digest,state FROM events WHERE event_id=?').get(event.eventId);
    if (!row || typeof event.sourceText !== 'string' || row.digest !== hash(event.sourceText)) {
      throw new DomainError('memory_source_changed', '宿主持久化原文与采集候选不一致');
    }
    db.prepare("UPDATE events SET state='ready' WHERE event_id=? AND state='staged'").run(event.eventId);
    return { eventId: event.eventId, durable: true, state: row.state === 'staged' ? 'ready' : String(row.state) };
  });
}

export async function inspectNativeCapture(scope: NativeCaptureScope) {
  return withNativeCaptureOutbox(scope, db => ({
    counts: db.prepare('SELECT state,count(*) AS count FROM events GROUP BY state').all(),
    events: db.prepare(`SELECT event_id AS eventId,native_message_id AS nativeMessageId,state,
      capture_code AS captureCode,last_error AS errorCode,attempts FROM events ORDER BY rowid LIMIT 100`).all(),
  }));
}

/** Sending is asynchronous to the host hook. A timeout retries the same event
 * and immutable body; the server owns receipt idempotency and classification. */
export async function drainNativeCapture(scope: NativeCaptureScope) {
  return withNativeCaptureOutbox(scope, async (db, context) => {
    let accepted = 0;
    let retryAfterMs = 0;
    for (let index = 0; index < 10; index++) {
      const claim = randomBytes(16).toString('hex');
      let row: OutboxRow | undefined;
      db.exec('BEGIN IMMEDIATE');
      try {
        row = db.prepare("SELECT * FROM events WHERE state IN ('ready','sending') ORDER BY rowid LIMIT 1").get() as OutboxRow | undefined;
        if (!row || row.state === 'sending' && (row.lease_until ?? 0) > Date.now()) {
          retryAfterMs = row ? Math.max(0,(row.lease_until ?? 0)-Date.now()) : 0;
          db.exec('COMMIT'); break;
        }
        db.prepare("UPDATE events SET state='sending',claim=?,lease_until=?,attempts=attempts+1 WHERE event_id=?")
          .run(claim, Date.now() + 60000, row.event_id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      try {
        if (scopeContext(scope).owner !== context.owner) throw new DomainError('memory_binding_changed', '采集身份已变化');
        const result = valueOf(await context.client.request<{ captureCode: string; status: string }>('POST', context.route + '/capture-events', {
          sessionId: scope.memorySession, eventId: row.event_id, sourceText: row.source_text,
        }));
        if (!PublicCodeSchema.safeParse(result?.captureCode).success ||
          !['pending','processing','completed','needs_clarification','skipped','failed'].includes(result.status)) {
          throw new DomainError('api_bad_response', '平台未确认持久采集任务');
        }
        const changed = db.prepare("UPDATE events SET state='accepted',capture_code=?,claim=NULL,lease_until=NULL,last_error=NULL WHERE event_id=? AND claim=? AND state='sending'")
          .run(result.captureCode, row.event_id, claim);
        if (changed.changes === 1) accepted++;
      } catch (error) {
        const code = error instanceof DomainError && /^[a-z0-9_]{1,100}$/u.test(error.code) ? error.code : 'memory_native_delivery_failed';
        db.prepare("UPDATE events SET state='ready',claim=NULL,lease_until=NULL,last_error=? WHERE event_id=? AND claim=? AND state='sending'")
          .run(code, row.event_id, claim);
        return { accepted, pending: true, errorCode: code };
      }
    }
    return { accepted, pending: Boolean(db.prepare("SELECT 1 FROM events WHERE state IN ('ready','sending') LIMIT 1").get()),
      ...(retryAfterMs ? { retryAfterMs } : {}) };
  });
}

/** Bounded detached delivery also recovers a previous sender's expired lease.
 * It never turns a failed request into an ACK or changes the original body. */
export async function pumpNativeCapture(scope: NativeCaptureScope) {
  const deadline = Date.now()+75000;
  let attempts=0,accepted=0;
  while (Date.now()<deadline && attempts<6) {
    const result=await drainNativeCapture(scope);accepted+=result.accepted;attempts++;
    if(!result.pending)return {accepted,pending:false,attempts};
    const wait='retryAfterMs' in result ? Math.min(60000,result.retryAfterMs??0)+20 : result.accepted ? 20 : Math.min(10000,1000*attempts);
    if(Date.now()+wait>=deadline)break;
    await delay(wait);
  }
  return {accepted,pending:true,attempts};
}

function bridgeConfig(config: NativeCaptureBridgeConfig) {
  if (!config || !['dsh','opencode','codex'].includes(config.harness) || !id(config.hostSessionId) || !id(config.memorySession)
    || !/^[a-f0-9]{64}$/u.test(config.owner) ||
    ![config.cwd,config.memberHome,config.cliPath,config.nodePath,...(config.auditFile ? [config.auditFile] : [])]
      .every(value => typeof value === 'string' && path.isAbsolute(value) && !/\p{Cc}/u.test(value))) throw invalid();
}

/** Fixed child CLI protocol is shared by Node DSH and Bun OpenCode. The plugin
 * never mutates process.env or receives a database/engine credential. */
export function createNativeCaptureBridge(input: NativeCaptureBridgeConfig) {
  bridgeConfig(input);
  const config = { ...input };
  const env = Object.fromEntries(['SystemRoot','WINDIR','PATH','PATHEXT','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP']
    .filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const args = (action: string) => [config.cliPath,'memory','native',action,'--harness',config.harness,
    '--host-session',config.hostSessionId,'--session',config.memorySession,'--owner',config.owner];
  const invoke = <T>(action: string, body?: unknown, extra: string[] = []) => new Promise<T>((resolve, reject) => {
    const child = spawn(config.nodePath,[...args(action),...extra],{ cwd: config.cwd, env: { ...env, AGENTCTL_HOME: config.memberHome },
      windowsHide: true, stdio: ['pipe','pipe','ignore'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), action === 'drain' ? 65000 : 15000);
    child.stdout.setEncoding('utf8').on('data',chunk => { if (output.length < 1000000) output += chunk; });
    child.stdin.on('error',() => undefined);
    child.stdin.end(body === undefined ? '' : JSON.stringify(body));
    child.once('error',() => { clearTimeout(timer); reject(new DomainError('memory_native_unavailable','原生采集本地服务不可用')); });
    child.once('close',code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output) as { ok?: boolean; data?: T; error?: { code?: unknown } };
        if (code !== 0 || result.ok !== true) throw new DomainError(
          typeof result.error?.code === 'string' && /^[a-z0-9_]{1,100}$/u.test(result.error.code) ? result.error.code : 'memory_native_unavailable',
          '原生采集未获得本地持久确认');
        resolve(result.data as T);
      } catch (error) { reject(error instanceof DomainError ? error : new DomainError('memory_native_unavailable','原生采集未获得本地持久确认')); }
    });
  });
  return {
    enqueue: (event: NativeCaptureEvent, ready = true) => invoke<{ eventId: string; durable: boolean; state: string }>('enqueue',{ event,ready }),
    pending: (query:NativePendingQuery={}) => invoke<NativePendingCapture[]>('pending',undefined,
      [...(query.nativeMessageId===undefined?[]:['--message',query.nativeMessageId]),...(query.after===undefined?[]:['--after',String(query.after)])]),
    confirm: (event: { eventId: string; sourceText: string }) => invoke<{ eventId: string; durable: boolean; state: string }>('confirm',event),
    status: () => invoke<Awaited<ReturnType<typeof inspectNativeCapture>>>('status'),
    drain: () => invoke<Awaited<ReturnType<typeof drainNativeCapture>>>('drain'),
    kick() {
      const child = spawn(config.nodePath,args('pump'),{ cwd: config.cwd,env: { ...env,AGENTCTL_HOME: config.memberHome },
        windowsHide: true,detached: true,stdio: 'ignore' });
      child.once('error',() => undefined);
      child.unref();
    },
  };
}

export async function nativeCaptureConfig(input: { harness: unknown; hostSessionId: unknown; memorySession?: string }): Promise<NativeCaptureBridgeConfig> {
  if (!['dsh','opencode'].includes(String(input.harness)) || !id(input.hostSessionId)) throw invalid();
  const harness=input.harness as NativeHarness,hostSessionId=input.hostSessionId;
  const memorySession=input.memorySession??harness+'.'+hash(hostSessionId).slice(0,32);
  if(!id(memorySession))throw invalid();
  const context=memoryContext();
  if(valueOf(await context.client.whoami()).user_code!==context.actor)throw new DomainError('memory_actor_mismatch','设备登录身份与账号不匹配');
  valueOf(await context.client.request('GET',context.route+'/binding'));
  return {harness,hostSessionId,memorySession,owner:context.owner,cwd:realpathSync.native(process.cwd()),
    memberHome:path.resolve(authDirectory()),cliPath:fileURLToPath(new URL('./index.js',import.meta.url)),nodePath:process.execPath};
}

/** Writes an opt-in profile only. Existing project/global harness files are
 * never replaced, and neither tokens nor conversation bodies enter the profile. */
export async function setupNativeCapture(input: { harness: unknown; hostSessionId: unknown; memorySession?: string; directory?: string }) {
  const base=await nativeCaptureConfig(input);
  const directory=input.directory??path.join(authDirectory(),'memory-native-profiles',hash(JSON.stringify([base.owner,base.harness,base.hostSessionId])).slice(0,32));
  if(!path.isAbsolute(directory)||/\p{Cc}/u.test(directory))throw invalid();
  mkdirSync(path.dirname(directory),{recursive:true,mode:0o700});
  try{mkdirSync(directory,{mode:0o700});}catch{throw new DomainError('memory_profile_exists','请选择不存在的新目录；原生配置不会覆盖已有文件');}
  const config={...base,auditFile:path.join(directory,'capture-audit.ndjson')};
  const configFile=path.join(directory,'capture.config.json');
  writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600});
  const mcp={type:'local',command:[config.nodePath,config.cliPath,'memory','mcp'],environment:{AGENTCTL_HOME:config.memberHome,TSP_MEMORY_SESSION:config.memorySession}};
  let profileFile:string;
  if(config.harness==='opencode'){
    const {opencodeNativePluginSource}=await import('./memory-opencode-capture.js');
    const pluginFile=path.join(directory,'capture-plugin.mjs');
    writeFileSync(pluginFile,opencodeNativePluginSource({...config,harness:'opencode'}),{mode:0o600});
    profileFile=path.join(directory,'opencode.json');
    writeFileSync(profileFile,JSON.stringify({plugin:[pathToFileURL(pluginFile).href],mcp:{tsp_memory:mcp}},null,2)+'\n',{mode:0o600});
  }else{
    const {dshCapturePluginEntry}=await import('./memory-dsh-capture.js');
    const {dshLifecyclePluginEntry}=await import('./memory-dsh-lifecycle.js');
    profileFile=path.join(directory,'dsh.patch.json');
    const mcpEntry={id:'tsp-memory',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'tsp_memory',transport:'stdio',
      command:config.nodePath,args:[config.cliPath,'memory','mcp'],cwd:config.cwd,env:mcp.environment,
      failOnStartupError:true,toolCallTimeoutMs:15000}};
    const lifecycle=dshLifecyclePluginEntry({hostSessionId:config.hostSessionId,memorySession:config.memorySession,
      cwd:config.cwd,memberHome:config.memberHome,cliPath:config.cliPath,nodePath:config.nodePath,auditFile:config.auditFile});
    writeFileSync(profileFile,JSON.stringify({plugins:{insert:[dshCapturePluginEntry({...config,harness:'dsh'}),lifecycle,mcpEntry]}},null,2)+'\n',{mode:0o600});
    writeFileSync(path.join(directory,'mcp-server.json'),JSON.stringify({tsp_memory:mcp},null,2)+'\n',{mode:0o600});
  }
  return {directory,configFile,profileFile,harness:config.harness,hostSessionId:config.hostSessionId,
    memorySession:config.memorySession,scope:'explicit-project-and-account-single-session',globalConfigurationChanged:false};
}

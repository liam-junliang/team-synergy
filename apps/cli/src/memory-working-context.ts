import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DomainError } from '@team-synergy/domain';
import { authDirectory } from './auth-store.js';
import { memoryContext } from './memory.js';

export type MemoryContextResetReason = 'compaction' | 'resume' | 'new-chat';
export type MemorySourceReference = { source: string; version: string };
export type MemoryWorkingSnapshot = {
  epoch: string;
  revision: number;
  reason: string;
  sources: MemorySourceReference[];
  expiresAt: number;
};
const ttlMs = 24 * 60 * 60 * 1000;
const maxSources = 40;
const maxContexts = 128;
const maxReferenceBytes = 6000;
const validReasons = new Set(['compaction', 'resume', 'new-chat', 'new-session', 'expired']);
const invalid = () => new DomainError('memory_context_invalid', '短期记忆记录无效，请清理后重新读取。');
const changed = () => new DomainError('memory_context_changed', '宿主上下文已变化，请在当前上下文重新读取。');

function sessionKey(sessionId: string) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/u.test(sessionId)) throw invalid();
  return createHash('sha256').update(sessionId).digest('hex');
}

function references(value: unknown): MemorySourceReference[] {
  if (!Array.isArray(value) || value.length > maxSources) throw invalid();
  const seen = new Set<string>();
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || Object.keys(ref).sort().join(',') !== 'source,version' ||
        typeof ref.source !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{20}$/u.test(ref.source) ||
        typeof ref.version !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.version) || seen.has(ref.source)) throw invalid();
    seen.add(ref.source);
    return { source: ref.source, version: ref.version };
  });
}

function snapshot(row: Record<string, unknown>): MemoryWorkingSnapshot {
  if (typeof row.epoch !== 'string' || !/^[a-f0-9-]{36}$/u.test(row.epoch) ||
      typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 ||
      typeof row.reason !== 'string' || !validReasons.has(row.reason) ||
      typeof row.expires_at !== 'number' || !Number.isSafeInteger(row.expires_at) ||
      typeof row.sources_json !== 'string' || Buffer.byteLength(row.sources_json) > maxReferenceBytes) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(row.sources_json); } catch { throw invalid(); }
  return { epoch: row.epoch, revision: row.revision, reason: row.reason,
    sources: references(parsed), expiresAt: row.expires_at };
}

/** Host-owned checkpoints retain only bounded references, never evidence bodies or grants. */
export function createMemoryWorkingContextStore(owner: string, sessionId: string,
    options: { directory?: string; now?: () => number } = {}) {
  if (!/^[a-f0-9]{64}$/u.test(owner)) throw invalid();
  const key = sessionKey(sessionId);
  const directory = options.directory ?? authDirectory();
  const file = path.join(directory, 'memory-working-context.sqlite');
  const now = options.now ?? Date.now;

  function transaction<T>(action: (db: DatabaseSync) => T, create?: true): Promise<T>;
  function transaction<T>(action: (db: DatabaseSync) => T, create: false): Promise<T | undefined>;
  async function transaction<T>(action: (db: DatabaseSync) => T, create = true): Promise<T | undefined> {
    if (!create && !existsSync(file)) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
    const { DatabaseSync } = await import('node:sqlite');
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file);
      db.exec(`pragma busy_timeout=5000;
        create table if not exists working_contexts (
          owner text not null, session_key text not null, epoch text not null,
          revision integer not null, reason text not null, expires_at integer not null,
          sources_json text not null, primary key(owner,session_key)
        );`);
      db.exec('begin immediate');
      const result = action(db);
      db.exec('commit');
      return result;
    } catch (error) {
      try { db?.exec('rollback'); } catch { /* Opening a corrupt file may fail before BEGIN. */ }
      if (error instanceof DomainError) throw error;
      throw invalid();
    } finally { db?.close(); }
  }

  const get = (db: DatabaseSync) => db.prepare(`select epoch,revision,reason,expires_at,
    case when length(cast(sources_json as blob))<=${maxReferenceBytes} then sources_json else null end as sources_json
    from working_contexts where owner=? and session_key=?`).get(owner, key);
  function insert(db: DatabaseSync, reason: string): MemoryWorkingSnapshot {
    db.prepare('delete from working_contexts where expires_at<=?').run(now());
    const count = db.prepare('select count(*) as count from working_contexts where owner=?').get(owner)?.count;
    if (Number(count) >= maxContexts) throw new DomainError('memory_context_capacity', '此账号的短期会话已满，请清理不用的会话。');
    const value = { epoch: randomUUID(), revision: 0, reason, sources: [], expiresAt: now() + ttlMs };
    db.prepare('insert into working_contexts values(?,?,?,?,?,?,?)')
      .run(owner, key, value.epoch, value.revision, value.reason, value.expiresAt, '[]');
    return value;
  }

  async function read(): Promise<MemoryWorkingSnapshot> {
    return (await transaction(db => {
      const row = get(db);
      if (!row) return insert(db, 'new-session');
      // Expired references are discarded without parsing or extending their life.
      if (typeof row.expires_at === 'number' && row.expires_at <= now()) {
        db.prepare('delete from working_contexts where owner=? and session_key=?').run(owner, key);
        return insert(db, 'expired');
      }
      return snapshot(row);
    }));
  }

  async function commit(base: MemoryWorkingSnapshot, next: MemorySourceReference[], unavailable: readonly string[]) {
    const checked = references(next);
    return transaction(db => {
      const row = get(db);
      if (!row || row.epoch !== base.epoch || row.revision !== base.revision ||
          typeof row.expires_at !== 'number' || row.expires_at <= now()) throw changed();
      const merged = new Map(snapshot(row).sources.map(ref => [ref.source, ref]));
      for (const source of unavailable) merged.delete(source);
      for (const ref of checked) { merged.delete(ref.source); merged.set(ref.source, ref); }
      while (merged.size > maxSources) merged.delete(merged.keys().next().value as string);
      const expiresAt = now() + ttlMs;
      db.prepare(`update working_contexts set revision=revision+1, expires_at=?, sources_json=?
        where owner=? and session_key=? and epoch=? and revision=?`)
        .run(expiresAt, JSON.stringify([...merged.values()]), owner, key, base.epoch, base.revision);
    });
  }

  async function reset(reason: MemoryContextResetReason) {
    if (!['compaction', 'resume', 'new-chat'].includes(reason)) throw invalid();
    await transaction(db => {
      const row = get(db);
      if (!row) { insert(db, reason); return; }
      const expired = typeof row.expires_at === 'number' && row.expires_at <= now();
      const prior = expired ? undefined : snapshot(row);
      // Reset is not evidence refresh: preserve the original reference deadline.
      db.prepare(`update working_contexts set epoch=?, revision=revision+1, reason=?, sources_json=?, expires_at=?
        where owner=? and session_key=?`).run(randomUUID(), reason,
          JSON.stringify(reason === 'new-chat' || !prior ? [] : prior.sources), prior?.expiresAt ?? now() + ttlMs, owner, key);
    });
    return inspect();
  }

  async function inspect() {
    const result = await transaction(db => {
      const row = get(db);
      if (!row) return;
      if (typeof row.expires_at === 'number' && row.expires_at <= now()) return { expired: true };
      return snapshot(row);
    }, false);
    if (!result || 'expired' in result) return { session: sessionId, exists: false, sourceCount: 0, expired: !!result };
    return { session: sessionId, exists: true, epoch: result.epoch, reason: result.reason,
      sourceCount: result.sources.length, expiresAt: result.expiresAt };
  }

  async function clear() {
    const result = await transaction(db => db.prepare('delete from working_contexts where owner=? and session_key=?').run(owner, key), false);
    return { session: sessionId, cleared: !!result?.changes };
  }
  return { read, commit, reset, inspect, clear };
}

export async function resetMemoryWorkingContext(sessionId: string, reason: MemoryContextResetReason) {
  return createMemoryWorkingContextStore(memoryContext().owner, sessionId).reset(reason);
}
export async function inspectMemoryWorkingContext(sessionId: string) {
  return createMemoryWorkingContextStore(memoryContext().owner, sessionId).inspect();
}
export async function clearMemoryWorkingContext(sessionId: string) {
  return createMemoryWorkingContextStore(memoryContext().owner, sessionId).clear();
}

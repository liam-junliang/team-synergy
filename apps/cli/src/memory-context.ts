import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '@team-synergy/domain';

type Row = Record<string, unknown>;
type KnownSource = { version: string; state?: string; scope?: string };
export type MemoryReadBase = {
  owner: string;
  epoch?: string;
  sources: Map<string, KnownSource>;
  reset: boolean;
};
type Receipt = MemoryReadBase & { expiresAt: number };

const ttlMs = 30 * 60 * 1000;
const maxReceipts = 128;
const maxSources = 40;

function sourceOf(row: unknown): string | undefined {
  if (!row || typeof row !== 'object' || !('source' in row)) return;
  return typeof row.source === 'string' && row.source.length > 0 && row.source.length <= 64 ? row.source : undefined;
}

function describe(row: Row): KnownSource {
  // Briefs add a presentation-only explanation; source reads return the same
  // evidence without it. All other fields take part in a stable fingerprint.
  const evidence = Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== 'evidenceStatus').sort(([a], [b]) => a.localeCompare(b)));
  return {
    version: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    ...(typeof row.state === 'string' ? { state: row.state } : {}),
    ...(typeof row.scope === 'string' ? { scope: row.scope } : {}),
  };
}

/** Receipts are explicit branches of a conversation. They retain hashes, never old text. */
export class MemoryContextReceipts {
  private readonly receipts = new Map<string, Receipt>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(owner: string, token?: string, epoch?: string): MemoryReadBase {
    const now = this.now();
    for (const [id, receipt] of this.receipts) {
      if (receipt.expiresAt <= now) this.receipts.delete(id);
    }
    const prior = token ? this.receipts.get(token) : undefined;
    if (prior && prior.owner !== owner) throw new DomainError('memory_context_mismatch', '记忆上下文属于其他登录或工作区，请开始新的读取。');
    const current = prior?.epoch === epoch ? prior : undefined;
    return { owner, ...(epoch ? { epoch } : {}), sources: new Map(current?.sources), reset: Boolean(token && !current) };
  }

  finish(base: MemoryReadBase, rows: unknown[], verifiedRows: Row[], options: {
    full: boolean; forceSource?: string; restoreBudget?: { textChars: number; rows: number };
  }) {
    const verified = new Map(verifiedRows.map(row => [sourceOf(row), row]));
    if (verified.has(undefined) || [...verified.keys()].some(source => !base.sources.has(String(source)))) {
      throw new DomainError('memory_invalid_sources', '来源校验返回了不属于当前上下文的记录。');
    }
    const unavailable = [...base.sources.keys()].filter(source => !verified.has(source));
    const current = new Map<string, Row>();
    const unkeyed: unknown[] = [];
    for (const row of rows) {
      const source = sourceOf(row);
      if (!source) {
        unkeyed.push(row);
        continue;
      }
      // A source known to this branch must survive the later authorized revalidation.
      const fresh = base.sources.has(source) ? verified.get(source) : row as Row;
      if (fresh) current.set(source, fresh);
    }
    for (const [source, row] of verified) {
      if (source && describe(row).version !== base.sources.get(source)?.version) current.set(source, row);
    }
    const next = new Map<string, KnownSource>();
    if (options.restoreBudget && unkeyed.length) throw new DomainError('memory_invalid_sources', '恢复的来源记录缺少编码。');
    for (const [source, row] of verified) {
      if (source && !options.restoreBudget) next.set(source, describe(row));
    }
    const output: unknown[] = [...unkeyed];
    const unchanged: Array<{ source: string } & KnownSource> = [];
    const deferred: string[] = [];
    let restoredChars = 0;
    let restoredRows = 0;
    for (const [source, row] of current) {
      const textChars = typeof row.text === 'string' ? row.text.length : 0;
      if (options.restoreBudget && (restoredRows >= options.restoreBudget.rows ||
          restoredChars + textChars > options.restoreBudget.textChars)) {
        deferred.push(source);
        continue;
      }
      restoredChars += textChars;
      restoredRows++;
      const entry = describe(row);
      if (!options.full && options.forceSource !== source && base.sources.get(source)?.version === entry.version) {
        unchanged.push({ source, ...entry });
      } else output.push(row);
      next.delete(source);
      next.set(source, entry);
    }
    // A compact receipt has a finite horizon. Evicted entries are returned in full on a later read.
    while (next.size > maxSources) next.delete(next.keys().next().value as string);
    const token = randomBytes(24).toString('hex');
    this.receipts.set(token, { owner: base.owner, ...(base.epoch ? { epoch: base.epoch } : {}), sources: next, reset: false, expiresAt: this.now() + ttlMs });
    while (this.receipts.size > maxReceipts) this.receipts.delete(this.receipts.keys().next().value as string);
    return {
      rows: output,
      metadata: {
        context_receipt: token,
        unchanged_sources: unchanged,
        unavailable_sources: unavailable,
        ...(deferred.length ? { deferred_sources: deferred } : {}),
        ...(base.reset ? { receipt_reset: 'expired_or_unknown' } : {}),
        expires_in_seconds: ttlMs / 1000,
      },
    };
  }

  references(token: string) {
    return [...(this.receipts.get(token)?.sources ?? [])].map(([source, value]) => ({ source, version: value.version }));
  }
}
